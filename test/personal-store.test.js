import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

import { PersonalAuthStore, parseMasterKey } from '../src/personal-store.js';

const SCOPES = ['music:read', 'playlist:read', 'playlist:write', 'player:control'];
const RESOURCE = 'https://music.example.test/mcp';

function assertInvalidToken(error) {
  assert.ok(error instanceof OAuthError);
  assert.equal(error.code, OAuthErrorCode.InvalidToken);
  assert.equal(error.message, 'Invalid access token.');
  return true;
}

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), 'netease-auth-store-'));
  const filePath = join(directory, 'auth.json');
  const store = new PersonalAuthStore({
    filePath,
    masterKey: parseMasterKey('1'.repeat(64)),
    allowedScopes: SCOPES,
  });
  await store.initialize();
  return { store, filePath };
}

test('creates one owner and never stores plaintext passwords', async () => {
  const { store, filePath } = await createStore();
  const user = await store.createOwner('music_friend', 'correct horse battery staple');

  assert.equal((await store.authenticateOwner('music_friend', 'wrong password')), null);
  assert.deepEqual(
    await store.authenticateOwner('music_friend', 'correct horse battery staple'),
    user,
  );
  await assert.rejects(
    store.createOwner('someone_else', 'another sufficiently long password'),
    /已经完成所有者初始化/,
  );

  const raw = await readFile(filePath, 'utf8');
  assert.doesNotMatch(raw, /correct horse battery staple/);
  assert.match(raw, /scrypt\$/);
});

test('issues scoped personal tokens and validates their audience', async () => {
  const { store, filePath } = await createStore();
  const user = await store.createOwner('listener', 'this is a long password');
  const issued = await store.createPersonalAccessToken(user.id, {
    label: 'self-hosted frontend',
    scopes: ['music:read'],
    resource: RESOURCE,
    expiresInDays: 30,
  });

  const auth = await store.verifyAccessToken(issued.token, RESOURCE);
  assert.equal(auth.extra.userId, user.id);
  assert.deepEqual(auth.scopes, ['music:read']);
  const before = await readFile(filePath, 'utf8');
  await assert.rejects(
    store.verifyAccessToken(issued.token, 'https://other.example/mcp'),
    assertInvalidToken,
  );
  assert.deepEqual(await store.verifyAccessToken(issued.token, RESOURCE), auth);
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('classifies unknown, revoked and expired credentials without rewriting authentication data', async () => {
  const { store, filePath } = await createStore();
  const user = await store.createOwner('credential_owner', 'a sufficiently long password');
  const issue = () => store.createPersonalAccessToken(user.id, {
    label: 'credential classification', scopes: SCOPES, resource: RESOURCE,
  });
  const valid = await issue();
  const revoked = await issue();
  const expired = await issue();
  await store.revokeToken(revoked.token);
  const data = JSON.parse(await readFile(filePath, 'utf8'));
  const expiredHash = createHash('sha256').update(expired.token).digest('hex');
  data.accessTokens.find((entry) => entry.tokenHash === expiredHash).expiresAt =
    Math.floor(Date.now() / 1000) - 1;
  await writeFile(filePath, JSON.stringify(data));
  const before = await readFile(filePath, 'utf8');

  for (const credential of ['unregistered-credential', revoked.token, expired.token]) {
    await assert.rejects(store.verifyAccessToken(credential, RESOURCE), assertInvalidToken);
  }
  const auth = await store.verifyAccessToken(valid.token, RESOURCE);
  assert.equal(auth.extra.userId, user.id);
  assert.deepEqual(auth.scopes, SCOPES);
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('preserves real storage failures instead of classifying them as invalid credentials', async () => {
  const { store, filePath } = await createStore();
  const user = await store.createOwner('storage_owner', 'a sufficiently long password');
  const issued = await store.createPersonalAccessToken(user.id, {
    label: 'storage failure', scopes: ['music:read'], resource: RESOURCE,
  });
  const raw = await readFile(filePath, 'utf8');
  const unavailablePath = `${filePath}.unavailable`;
  await rename(filePath, unavailablePath);
  try {
    await assert.rejects(store.verifyAccessToken(issued.token, RESOURCE), (error) => {
      assert.equal(error.code, 'ENOENT');
      assert.equal(error instanceof OAuthError, false);
      return true;
    });
  } finally {
    await rename(unavailablePath, filePath);
  }

  await writeFile(filePath, '{invalid authentication data');
  try {
    await assert.rejects(store.verifyAccessToken(issued.token, RESOURCE), (error) => {
      assert.ok(error instanceof SyntaxError);
      assert.equal(error instanceof OAuthError, false);
      return true;
    });
  } finally {
    await writeFile(filePath, raw);
  }
  assert.equal((await store.verifyAccessToken(issued.token, RESOURCE)).extra.userId, user.id);
});

test('encrypts per-user NetEase sessions at rest', async () => {
  const { store, filePath } = await createStore();
  const user = await store.createOwner('playlist_owner', 'another long password');
  const cookie = 'MUSIC_U=private-session-value; __csrf=private-csrf';

  await store.saveNeteaseSession(user.id, cookie);
  assert.deepEqual(await store.loadNeteaseSession(user.id), {
    cookieHeader: cookie,
    csrfToken: 'private-csrf',
  });

  const raw = await readFile(filePath, 'utf8');
  assert.doesNotMatch(raw, /private-session-value|private-csrf|MUSIC_U/);
});

test('keeps NetEase sessions isolated between independent deployments', async () => {
  const first = await createStore();
  const second = await createStore();
  const alice = await first.store.createOwner('alice_music', 'alice has a long password');
  const bob = await second.store.createOwner('bob_music', 'bob also has a long password');
  await first.store.saveNeteaseSession(alice.id, 'MUSIC_U=alice-only');
  await second.store.saveNeteaseSession(bob.id, 'MUSIC_U=bob-only');

  assert.equal((await first.store.loadNeteaseSession(alice.id)).cookieHeader, 'MUSIC_U=alice-only');
  assert.equal((await second.store.loadNeteaseSession(bob.id)).cookieHeader, 'MUSIC_U=bob-only');
});

test('exchanges PKCE authorization codes only once', async () => {
  const { store } = await createStore();
  const user = await store.createOwner('oauth_user', 'oauth password is long');
  const client = await store.registerClient({
    client_name: 'test client',
    redirect_uris: ['http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
  });
  const verifier = 'v'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const code = await store.issueAuthorizationCode({
    userId: user.id,
    clientId: client.client_id,
    redirectUri: client.redirect_uris[0],
    codeChallenge: challenge,
    scopes: ['music:read'],
    resource: RESOURCE,
  });

  const tokens = await store.exchangeAuthorizationCode({
    code,
    clientId: client.client_id,
    redirectUri: client.redirect_uris[0],
    codeVerifier: verifier,
    resource: RESOURCE,
  });
  assert.equal(tokens.token_type, 'Bearer');
  await assert.rejects(
    store.exchangeAuthorizationCode({
      code,
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      codeVerifier: verifier,
      resource: RESOURCE,
    }),
    /授权码无效/,
  );
});
