import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

const STORE_VERSION = 1;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const BROWSER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_STORE_BYTES = 8 * 1024 * 1024;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]+$/i.test(left ?? '') || !/^[a-f0-9]+$/i.test(right ?? '')) return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeUsername(value) {
  const username = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new Error('用户名必须是 3–32 位小写字母、数字、点、下划线或短横线。');
  }
  return username;
}

function validatePassword(password) {
  const value = String(password ?? '');
  if (value.length < 10 || value.length > 128) {
    throw new Error('密码必须是 10–128 个字符。');
  }
  return value;
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(validatePassword(password), Buffer.from(salt, 'hex'), 64, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

function verifyPassword(password, encoded) {
  const [algorithm, salt, expected] = String(encoded ?? '').split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt ?? '')) return false;
  try {
    const actual = hashPassword(password, salt).split('$')[2];
    return safeEqualHex(actual, expected);
  } catch {
    return false;
  }
}

const DUMMY_PASSWORD_HASH = hashPassword('netease-mcp-dummy-password');

function emptyStore() {
  return {
    version: STORE_VERSION,
    users: [],
    clients: [],
    browserSessions: [],
    authorizationCodes: [],
    accessTokens: [],
    refreshTokens: [],
    neteaseSessions: {},
  };
}

function cleanup(store) {
  const now = nowSeconds();
  store.browserSessions = store.browserSessions.filter((entry) => entry.expiresAt > now);
  store.authorizationCodes = store.authorizationCodes.filter((entry) => entry.expiresAt > now);
  store.accessTokens = store.accessTokens.filter((entry) => entry.expiresAt > now && !entry.revokedAt);
  store.refreshTokens = store.refreshTokens.filter((entry) => entry.expiresAt > now && !entry.revokedAt);
}

function normalizeScopes(scopes, allowedScopes) {
  const values = [
    ...new Set(
      (Array.isArray(scopes) ? scopes : String(scopes ?? '').split(/\s+/))
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ];
  if (values.length < 1 || values.some((scope) => !allowedScopes.has(scope))) {
    throw new Error('请求包含无效或空的权限范围。');
  }
  return values;
}

function encryptText(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

function decryptText(record, key) {
  if (record?.algorithm !== 'aes-256-gcm') throw new Error('不支持的会话加密格式。');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function parseMasterKey(raw) {
  const value = String(raw ?? '').trim();
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('NETEASE_PERSONAL_MASTER_KEY 必须是 64 位小写十六进制字符串。');
  }
  return Buffer.from(value, 'hex');
}

export class PersonalAuthStore {
  constructor({ filePath, masterKey, allowedScopes }) {
    if (!filePath) throw new Error('缺少认证数据库路径。');
    this.filePath = filePath;
    this.masterKey = masterKey;
    this.allowedScopes = new Set(allowedScopes);
    this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const metadata = await stat(this.filePath);
      if (!metadata.isFile() || metadata.size > MAX_STORE_BYTES) {
        throw new Error('认证数据库文件无效或过大。');
      }
      if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
        throw new Error('认证数据库权限过宽，必须设为 600。');
      }
      await this.#read();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.#write(emptyStore());
    }
  }

  async #read() {
    const raw = await readFile(this.filePath, 'utf8');
    const store = JSON.parse(raw);
    if (store?.version !== STORE_VERSION) throw new Error('认证数据库版本不受支持。');
    cleanup(store);
    return store;
  }

  async #write(store) {
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, this.filePath);
    if (process.platform !== 'win32') await chmod(this.filePath, 0o600);
  }

  async #transaction(operation, { write = true } = {}) {
    const run = async () => {
      const store = await this.#read();
      const result = await operation(store);
      if (write) await this.#write(store);
      return result;
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async createOwner(username, password) {
    const normalized = normalizeUsername(username);
    return this.#transaction((store) => {
      if (store.users.length > 0) {
        throw new Error('此 MCP 实例已经完成所有者初始化。');
      }
      const user = {
        id: `usr_${randomBytes(12).toString('hex')}`,
        username: normalized,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      store.users.push(user);
      return { id: user.id, username: user.username };
    });
  }

  async getOwner() {
    return this.#transaction(
      (store) => {
        const user = store.users[0];
        return user ? { id: user.id, username: user.username } : null;
      },
      { write: false },
    );
  }

  async authenticateOwner(username, password) {
    let normalized = '';
    try {
      normalized = normalizeUsername(username);
    } catch {
      // Continue through the same password-verification path to reduce user enumeration.
    }
    return this.#transaction(
      (store) => {
        const user = store.users.find((entry) => entry.username === normalized);
        const passwordValid = verifyPassword(
          password,
          user?.passwordHash ?? DUMMY_PASSWORD_HASH,
        );
        if (!user || !passwordValid) return null;
        return { id: user.id, username: user.username };
      },
      { write: false },
    );
  }

  async createBrowserSession(userId) {
    const token = randomToken();
    const csrfToken = randomToken(24);
    await this.#transaction((store) => {
      store.browserSessions.push({
        tokenHash: digest(token),
        csrfHash: digest(csrfToken),
        csrfToken,
        userId,
        expiresAt: nowSeconds() + BROWSER_SESSION_TTL_SECONDS,
      });
    });
    return { token, csrfToken, expiresIn: BROWSER_SESSION_TTL_SECONDS };
  }

  async getBrowserSession(token) {
    if (!token) return null;
    return this.#transaction(
      (store) => {
        const session = store.browserSessions.find(
          (entry) => safeEqualHex(entry.tokenHash, digest(token)),
        );
        if (!session) return null;
        const user = store.users.find((entry) => entry.id === session.userId);
        return user
          ? {
              user: { id: user.id, username: user.username },
              csrfHash: session.csrfHash,
              csrfToken: session.csrfToken,
              expiresAt: session.expiresAt,
            }
          : null;
      },
      { write: false },
    );
  }

  verifyCsrf(session, csrfToken) {
    return Boolean(
      session?.csrfHash &&
        csrfToken &&
        safeEqualHex(session.csrfHash, digest(String(csrfToken))),
    );
  }

  async registerClient(metadata) {
    const redirectUris = [...new Set(metadata.redirect_uris ?? [])];
    if (
      redirectUris.length < 1 ||
      redirectUris.length > 20 ||
      redirectUris.some((uri) => !isAllowedRedirectUri(uri))
    ) {
      throw new Error('redirect_uris 必须包含 HTTPS 或本机回调地址。');
    }
    const method = metadata.token_endpoint_auth_method ?? 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
      throw new Error('不支持的客户端认证方式。');
    }
    const clientId = `mcp_${randomBytes(18).toString('base64url')}`;
    const clientSecret = method === 'none' ? null : randomToken();
    await this.#transaction((store) => {
      store.clients.push({
        clientId,
        clientSecretHash: clientSecret ? digest(clientSecret) : null,
        clientName: String(metadata.client_name ?? 'MCP client').slice(0, 80),
        redirectUris,
        tokenEndpointAuthMethod: method,
        createdAt: new Date().toISOString(),
      });
    });
    return {
      client_id: clientId,
      client_id_issued_at: nowSeconds(),
      client_name: String(metadata.client_name ?? 'MCP client').slice(0, 80),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: method,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    };
  }

  async getClient(clientId) {
    return this.#transaction(
      (store) => store.clients.find((client) => client.clientId === clientId) ?? null,
      { write: false },
    );
  }

  verifyClientSecret(client, clientSecret) {
    if (client?.tokenEndpointAuthMethod === 'none') return true;
    return Boolean(
      client?.clientSecretHash &&
        clientSecret &&
        safeEqualHex(client.clientSecretHash, digest(clientSecret)),
    );
  }

  async issueAuthorizationCode({
    userId,
    clientId,
    redirectUri,
    codeChallenge,
    scopes,
    resource,
  }) {
    const code = randomToken();
    await this.#transaction((store) => {
      store.authorizationCodes.push({
        codeHash: digest(code),
        userId,
        clientId,
        redirectUri,
        codeChallenge,
        scopes: normalizeScopes(scopes, this.allowedScopes),
        resource,
        expiresAt: nowSeconds() + AUTHORIZATION_CODE_TTL_SECONDS,
      });
    });
    return code;
  }

  async exchangeAuthorizationCode({
    code,
    clientId,
    clientSecret,
    redirectUri,
    codeVerifier,
    resource,
  }) {
    return this.#transaction((store) => {
      const index = store.authorizationCodes.findIndex((entry) =>
        safeEqualHex(entry.codeHash, digest(code)),
      );
      if (index < 0) throw new Error('授权码无效或已过期。');
      const entry = store.authorizationCodes[index];
      const client = store.clients.find((item) => item.clientId === clientId);
      if (!client || !this.verifyClientSecret(client, clientSecret)) {
        throw new Error('客户端认证失败。');
      }
      if (
        entry.clientId !== clientId ||
        entry.redirectUri !== redirectUri ||
        entry.resource !== resource ||
        !verifyPkce(codeVerifier, entry.codeChallenge)
      ) {
        throw new Error('授权码校验失败。');
      }
      store.authorizationCodes.splice(index, 1);
      return issueTokenPair(store, entry);
    });
  }

  async refreshAccessToken({ refreshToken, clientId, clientSecret, resource, scopes }) {
    return this.#transaction((store) => {
      const index = store.refreshTokens.findIndex((entry) =>
        safeEqualHex(entry.tokenHash, digest(refreshToken)),
      );
      if (index < 0) throw new Error('刷新令牌无效或已过期。');
      const previous = store.refreshTokens[index];
      const client = store.clients.find((item) => item.clientId === clientId);
      if (!client || !this.verifyClientSecret(client, clientSecret)) {
        throw new Error('客户端认证失败。');
      }
      if (previous.clientId !== clientId || previous.resource !== resource) {
        throw new Error('刷新令牌不属于当前资源。');
      }
      const requestedScopes = scopes
        ? normalizeScopes(scopes, this.allowedScopes)
        : previous.scopes;
      if (requestedScopes.some((scope) => !previous.scopes.includes(scope))) {
        throw new Error('刷新时不能扩大权限范围。');
      }
      store.refreshTokens.splice(index, 1);
      return issueTokenPair(store, { ...previous, scopes: requestedScopes });
    });
  }

  async createPersonalAccessToken(userId, { label, scopes, resource, expiresInDays = 30 }) {
    const normalizedScopes = normalizeScopes(scopes, this.allowedScopes);
    const days = Number(expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error('个人 Token 有效期必须是 1–365 天。');
    }
    const token = `nmcp_${randomToken()}`;
    await this.#transaction((store) => {
      store.accessTokens.push({
        tokenHash: digest(token),
        userId,
        clientId: 'personal-access-token',
        scopes: normalizedScopes,
        resource,
        label: String(label ?? 'personal token').trim().slice(0, 60),
        createdAt: new Date().toISOString(),
        expiresAt: nowSeconds() + days * 24 * 60 * 60,
      });
    });
    return { token, scopes: normalizedScopes, expiresInDays: days };
  }

  async listPersonalAccessTokens(userId) {
    return this.#transaction(
      (store) =>
        store.accessTokens
          .filter((entry) => entry.userId === userId && entry.clientId === 'personal-access-token')
          .map((entry) => ({
            id: entry.tokenHash.slice(0, 16),
            label: entry.label,
            scopes: entry.scopes,
            createdAt: entry.createdAt,
            expiresAt: entry.expiresAt,
          })),
      { write: false },
    );
  }

  async revokePersonalAccessToken(userId, tokenId) {
    return this.#transaction((store) => {
      const before = store.accessTokens.length;
      store.accessTokens = store.accessTokens.filter(
        (entry) =>
          !(
            entry.userId === userId &&
            entry.clientId === 'personal-access-token' &&
            entry.tokenHash.startsWith(tokenId)
          ),
      );
      return store.accessTokens.length < before;
    });
  }

  async verifyAccessToken(token, resource) {
    return this.#transaction(
      (store) => {
        const entry = store.accessTokens.find((item) =>
          safeEqualHex(item.tokenHash, digest(token)),
        );
        if (!entry || entry.resource !== resource || entry.expiresAt <= nowSeconds()) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token.');
        }
        return {
          token,
          clientId: entry.clientId,
          scopes: entry.scopes,
          expiresAt: entry.expiresAt,
          resource: new URL(entry.resource),
          extra: { userId: entry.userId },
        };
      },
      { write: false },
    );
  }

  async revokeToken(token) {
    if (!token) return;
    const tokenHash = digest(token);
    await this.#transaction((store) => {
      store.accessTokens = store.accessTokens.filter(
        (entry) => !safeEqualHex(entry.tokenHash, tokenHash),
      );
      store.refreshTokens = store.refreshTokens.filter(
        (entry) => !safeEqualHex(entry.tokenHash, tokenHash),
      );
    });
  }

  async revokeBrowserSession(token) {
    if (!token) return;
    const tokenHash = digest(token);
    await this.#transaction((store) => {
      store.browserSessions = store.browserSessions.filter(
        (entry) => !safeEqualHex(entry.tokenHash, tokenHash),
      );
    });
  }

  async saveNeteaseSession(userId, cookieHeader) {
    const value = String(cookieHeader ?? '').trim();
    if (
      value.length > 8192 ||
      !/^MUSIC_U=[^;\s]+(?:;\s*__csrf=[^;\s]+)?$/.test(value) ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new Error('网易云会话格式无效，只接受 MUSIC_U 和可选的 __csrf。');
    }
    await this.#transaction((store) => {
      store.neteaseSessions[userId] = {
        ...encryptText(value, this.masterKey),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async deleteNeteaseSession(userId) {
    await this.#transaction((store) => {
      delete store.neteaseSessions[userId];
    });
  }

  async getNeteaseSessionStatus(userId) {
    return this.#transaction(
      (store) => ({
        enabled: Boolean(store.neteaseSessions[userId]),
        cookieFileConfigured: Boolean(store.neteaseSessions[userId]),
        updatedAt: store.neteaseSessions[userId]?.updatedAt ?? null,
      }),
      { write: false },
    );
  }

  async loadNeteaseSession(userId) {
    return this.#transaction(
      (store) => {
        const record = store.neteaseSessions[userId];
        if (!record) throw new Error('当前用户尚未连接网易云账号会话。');
        const cookieHeader = decryptText(record, this.masterKey);
        const csrfToken =
          cookieHeader.match(/(?:^|;\s*)__csrf=([^;\s]+)/)?.[1] ?? '';
        return { cookieHeader, csrfToken };
      },
      { write: false },
    );
  }
}

function issueTokenPair(store, entry) {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const access = {
    tokenHash: digest(accessToken),
    userId: entry.userId,
    clientId: entry.clientId,
    scopes: entry.scopes,
    resource: entry.resource,
    createdAt: new Date().toISOString(),
    expiresAt: nowSeconds() + ACCESS_TOKEN_TTL_SECONDS,
  };
  const refresh = {
    tokenHash: digest(refreshToken),
    userId: entry.userId,
    clientId: entry.clientId,
    scopes: entry.scopes,
    resource: entry.resource,
    createdAt: new Date().toISOString(),
    expiresAt: nowSeconds() + REFRESH_TOKEN_TTL_SECONDS,
  };
  store.accessTokens.push(access);
  store.refreshTokens.push(refresh);
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: entry.scopes.join(' '),
  };
}

function verifyPkce(verifier, challenge) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier ?? '')) return false;
  const actual = createHash('sha256').update(verifier).digest('base64url');
  return actual === challenge;
}

function isAllowedRedirectUri(value) {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
