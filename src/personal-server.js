#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
} from '@modelcontextprotocol/server';

import { PersonalAuthStore, parseMasterKey } from './personal-store.js';
import { createNeteaseMcpServer } from './mcp-server.js';
import { KugouBridge } from './kugou-bridge.js';
import {
  createKugouAgentApi,
  loadKugouDeviceRegistration,
} from './kugou-agent-api.js';
import { getLyrics, getSongDetails, searchSongs } from './netease.js';
import {
  addSongsToPlaylist,
  createPlaylist,
  listOwnPlaylists,
  removeSongsFromPlaylist,
} from './playlist.js';

export const PERSONAL_SCOPES = [
  'music:read',
  'playlist:read',
  'playlist:write',
  'player:control',
];

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3304;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FORM_BYTES = 64 * 1024;
const DEFAULT_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function json(response, status, data, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(data));
}

function html(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': DEFAULT_HTML_CSP,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...headers,
  });
  response.end(body);
}

function oauthConsentCsp(redirectUri) {
  const callback = new URL(redirectUri);
  const callbackSource = ['http:', 'https:'].includes(callback.protocol)
    ? callback.origin
    : callback.protocol;
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `form-action 'self' ${callbackSource}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function redirect(response, location, cookies = []) {
  response.writeHead(303, {
    location,
    'cache-control': 'no-store',
    ...(cookies.length ? { 'set-cookie': cookies } : {}),
  });
  response.end();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(title, content) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} · 网易云音乐 MCP</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #111218; color: #f6f7fb; }
    main { width: min(720px, calc(100% - 32px)); margin: 48px auto; }
    .card { background: #1c1e27; border: 1px solid #303441; border-radius: 18px; padding: 24px; margin: 16px 0; }
    h1, h2 { margin-top: 0; }
    label { display: block; margin: 14px 0 6px; color: #c8ccd7; }
    input, select { box-sizing: border-box; width: 100%; padding: 12px; border-radius: 10px; border: 1px solid #424655; background: #111218; color: inherit; }
    button, .button { display: inline-block; border: 0; border-radius: 999px; padding: 11px 18px; margin: 12px 8px 0 0; background: #df3f52; color: white; font-weight: 700; text-decoration: none; cursor: pointer; }
    button.secondary, .button.secondary { background: #353949; }
    code, pre { overflow-wrap: anywhere; white-space: pre-wrap; background: #111218; border-radius: 10px; padding: 3px 7px; }
    .notice { border-left: 4px solid #df3f52; padding: 10px 14px; background: #281b20; }
    .muted { color: #9da3b4; }
    .scope { padding: 8px 0; }
    form.inline { display: inline; }
  </style>
</head>
<body><main>${content}</main></body>
</html>`;
}

function parseCookies(request) {
  const cookies = {};
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    cookies[part.slice(0, separator).trim()] = decodeURIComponent(
      part.slice(separator + 1).trim(),
    );
  }
  return cookies;
}

function sessionCookie(value, secure, maxAge) {
  return [
    `nmcp_session=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : null,
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join('; ');
}

async function readBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const KUGOU_SECURITY_SCHEME_TOOLS = new Set(['kugou_status', 'kugou_control']);

function isSingleToolsListRequest(body) {
  if (!body) return false;
  try {
    const message = JSON.parse(body.toString('utf8'));
    return (
      message !== null &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      message.jsonrpc === '2.0' &&
      message.method === 'tools/list'
    );
  } catch {
    return false;
  }
}

function addKugouRootSecuritySchemes(message) {
  if (!Array.isArray(message?.result?.tools)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: message.result.tools.map((tool) => {
        if (
          !KUGOU_SECURITY_SCHEME_TOOLS.has(tool?.name) ||
          Object.hasOwn(tool, 'securitySchemes') ||
          !Array.isArray(tool?._meta?.securitySchemes)
        ) {
          return tool;
        }
        return {
          ...tool,
          securitySchemes: structuredClone(tool._meta.securitySchemes),
        };
      }),
    },
  };
}

async function adaptToolsListResponse(webResponse) {
  const contentType = (webResponse.headers.get('content-type') ?? '').toLowerCase();
  const isJson = contentType.includes('application/json');
  const isEventStream = contentType.includes('text/event-stream');
  if (!isJson && !isEventStream) return webResponse;

  const originalBody = await webResponse.text();
  let adaptedBody = originalBody;
  try {
    if (isJson) {
      adaptedBody = JSON.stringify(addKugouRootSecuritySchemes(JSON.parse(originalBody)));
    } else {
      let parseFailed = false;
      adaptedBody = originalBody.replace(/^data:(.*)$/gm, (line, data) => {
        const payload = data.trim();
        if (!payload || payload === '[DONE]') return line;
        try {
          return `data: ${JSON.stringify(addKugouRootSecuritySchemes(JSON.parse(payload)))}`;
        } catch {
          parseFailed = true;
          return line;
        }
      });
      if (parseFailed) adaptedBody = originalBody;
    }
  } catch {
    adaptedBody = originalBody;
  }

  const headers = new Headers(webResponse.headers);
  headers.delete('content-length');
  return new Response(adaptedBody, {
    status: webResponse.status,
    statusText: webResponse.statusText,
    headers,
  });
}

async function readForm(request) {
  const contentType = String(request.headers['content-type'] ?? '').split(';')[0];
  if (contentType !== 'application/x-www-form-urlencoded') {
    const error = new Error('Expected application/x-www-form-urlencoded');
    error.statusCode = 415;
    throw error;
  }
  return new URLSearchParams((await readBody(request, MAX_FORM_BYTES)).toString('utf8'));
}

async function readJson(request) {
  const contentType = String(request.headers['content-type'] ?? '').split(';')[0];
  if (contentType !== 'application/json') {
    const error = new Error('Expected application/json');
    error.statusCode = 415;
    throw error;
  }
  return JSON.parse((await readBody(request)).toString('utf8'));
}

function appendOAuthResult(redirectUri, values) {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(name, value);
    }
  }
  return url.href;
}

function safeReturnTo(value) {
  const path = String(value ?? '');
  if (path === '/dashboard' || path.startsWith('/oauth/authorize?')) return path;
  return '/dashboard';
}

function scopeLabels(scopes) {
  const labels = {
    'music:read': '搜索歌曲、读取歌曲资料',
    'playlist:read': '查看你创建的歌单',
    'playlist:write': '在你确认后创建或修改歌单',
    'player:control': '控制已连接设备上的本地播放器',
  };
  return scopes.map(
    (scope) => `<div class="scope"><strong>${escapeHtml(scope)}</strong><br><span class="muted">${escapeHtml(labels[scope] ?? scope)}</span></div>`,
  );
}

function getClientCredentials(request, form) {
  const authorization = String(request.headers.authorization ?? '');
  if (authorization.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator >= 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, separator)),
        clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
      };
    }
  }
  return {
    clientId: form.get('client_id') ?? '',
    clientSecret: form.get('client_secret') ?? '',
  };
}

function createOpenApi(origin, { kugouEnabled = false } = {}) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'NetEase Music MCP companion API',
      version: '0.6.0',
      description:
        'Platform-neutral REST bridge for self-hosted frontends and tool-calling clients that do not support remote MCP.',
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/search': {
        get: {
          operationId: 'searchNeteaseSongs',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 20 } },
          ],
          responses: { 200: { description: 'Search results' } },
        },
      },
      '/song-details': {
        post: {
          operationId: 'getNeteaseSongDetails',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['songIds'],
                  properties: {
                    songIds: { type: 'array', items: { type: 'string' }, maxItems: 20 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Song details' } },
        },
      },
      '/lyrics/{songId}': {
        get: {
          operationId: 'getNeteaseLyrics',
          parameters: [
            { name: 'songId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Lyrics' } },
        },
      },
      '/playlists': {
        get: {
          operationId: 'listMyNeteasePlaylists',
          responses: { 200: { description: 'Owned playlists' } },
        },
        post: {
          operationId: 'createNeteasePlaylist',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'confirm'],
                  properties: {
                    name: { type: 'string', maxLength: 40 },
                    isPrivate: { type: 'boolean' },
                    confirm: { const: true },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Created playlist' } },
        },
      },
      '/playlists/{playlistId}/tracks': {
        post: {
          operationId: 'addSongsToNeteasePlaylist',
          parameters: [
            { name: 'playlistId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['songIds', 'confirm'],
                  properties: {
                    songIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
                    confirm: { const: true },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Updated playlist' } },
        },
        delete: {
          operationId: 'removeSongsFromNeteasePlaylist',
          parameters: [
            { name: 'playlistId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['songIds', 'confirm'],
                  properties: {
                    songIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
                    confirm: { const: true },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Updated playlist' } },
        },
      },
      ...(kugouEnabled
        ? {
            '/kugou/status': {
              get: {
                operationId: 'getKugouStatus',
                responses: { 200: { description: 'Latest active Kugou device status' } },
              },
            },
            '/kugou/control': {
              post: {
                operationId: 'controlKugouPlayback',
                requestBody: {
                  required: true,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['action'],
                        properties: {
                          action: { enum: ['toggle', 'next', 'previous'] },
                        },
                      },
                    },
                  },
                },
                responses: {
                  202: { description: 'Command accepted into the short-lived queue' },
                },
              },
            },
          }
        : {}),
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
  };
}

class LoginLimiter {
  constructor({ maxAttempts = 10, windowMs = 10 * 60_000 } = {}) {
    this.entries = new Map();
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  check(key) {
    const now = Date.now();
    const recent = (this.entries.get(key) ?? []).filter(
      (time) => now - time < this.windowMs,
    );
    if (recent.length >= this.maxAttempts) return false;
    recent.push(now);
    this.entries.set(key, recent);
    return true;
  }
}

function requestIdentity(request) {
  const remoteAddress = String(request.socket.remoteAddress ?? 'unknown');
  const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress);
  if (!isLoopback) return remoteAddress;
  const forwarded = String(request.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    .trim();
  return /^[A-Fa-f0-9:.]{2,80}$/.test(forwarded) ? forwarded : remoteAddress;
}

export async function createPersonalNeteaseServer({
  origin,
  store,
  kugouBridge,
  kugouAgentApi,
  allowedCorsOrigins = [],
  onError = (error) => console.error(`[netease-personal] ${error.message}`),
} = {}) {
  const canonicalOrigin = new URL(origin);
  if (!['https:', 'http:'].includes(canonicalOrigin.protocol)) {
    throw new Error('公共服务 origin 必须是 HTTP(S) URL。');
  }
  if (
    canonicalOrigin.protocol !== 'https:' &&
    !['localhost', '127.0.0.1'].includes(canonicalOrigin.hostname)
  ) {
    throw new Error('公网 OAuth 服务必须使用 HTTPS。');
  }
  canonicalOrigin.pathname = '/';
  canonicalOrigin.search = '';
  canonicalOrigin.hash = '';

  await store.initialize();
  const originString = canonicalOrigin.href.replace(/\/$/, '');
  const resource = `${originString}/mcp`;
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(resource));
  const secureCookies = canonicalOrigin.protocol === 'https:';
  const loginLimiter = new LoginLimiter();
  const setupLimiter = new LoginLimiter({ maxAttempts: 5 });
  const oauthRegistrationLimiter = new LoginLimiter({ maxAttempts: 100 });
  const oauthMetadata = {
    issuer: originString,
    authorization_endpoint: `${originString}/oauth/authorize`,
    token_endpoint: `${originString}/oauth/token`,
    registration_endpoint: `${originString}/oauth/register`,
    revocation_endpoint: `${originString}/oauth/revoke`,
    scopes_supported: PERSONAL_SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  };
  const metadataOptions = {
    resourceServerUrl: new URL(resource),
    oauthMetadata,
    scopesSupported: PERSONAL_SCOPES,
    resourceName: 'NetEase Music MCP',
    serviceDocumentationUrl: new URL(`${originString}/docs`),
    dangerouslyAllowInsecureIssuerUrl: canonicalOrigin.protocol !== 'https:',
  };
  const verifier = {
    verifyAccessToken: (token) => store.verifyAccessToken(token, resource),
  };
  const mcpAuthGate = requireBearerAuth({
    verifier,
    requiredScopes: ['music:read'],
    resourceMetadataUrl: metadataUrl,
  });
  const mcpHandler = createMcpHandler(
    ({ authInfo }) => {
      const userId = authInfo?.extra?.userId;
      return createNeteaseMcpServer({
        authInfo,
        kugouBridge,
        resourceMetadataUrl: metadataUrl,
        accountContext: userId
          ? {
              getSessionConfiguration: () => store.getNeteaseSessionStatus(userId),
              loadNeteaseSession: () => store.loadNeteaseSession(userId),
            }
          : undefined,
      });
    },
    { legacy: 'stateless', responseMode: 'auto', onerror: onError },
  );

  function accountOptions(userId) {
    return {
      sessionProvider: () => store.loadNeteaseSession(userId),
      sessionConfigurationProvider: () => store.getNeteaseSessionStatus(userId),
    };
  }

  async function getBrowserAccount(request) {
    return store.getBrowserSession(parseCookies(request).nmcp_session);
  }

  async function requireApiAuth(request, response, scopes) {
    const gate = requireBearerAuth({ verifier, requiredScopes: scopes, resourceMetadataUrl: metadataUrl });
    const webRequest = toWebRequest(request);
    const result = await gate(webRequest);
    if (!(result instanceof Response)) return result;
    await writeWebResponse(result, response);
    return null;
  }

  function corsHeaders(request) {
    const requestOrigin = String(request.headers.origin ?? '');
    if (!allowedCorsOrigins.includes(requestOrigin)) return {};
    return {
      'access-control-allow-origin': requestOrigin,
      vary: 'Origin',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    };
  }

  const httpServer = createServer(async (request, response) => {
    try {
      const incoming = new URL(request.url ?? '/', originString);
      const pathname = incoming.pathname;

      if (kugouAgentApi && pathname.startsWith('/agent/v1/')) {
        let body;
        try {
          body = ['GET', 'HEAD'].includes(request.method ?? '')
            ? undefined
            : await readBody(request, kugouAgentApi.maxBodyBytes);
        } catch (error) {
          json(response, error?.statusCode === 413 ? 413 : 400, {
            error: error?.statusCode === 413 ? 'payload_too_large' : 'invalid_request',
          });
          return;
        }
        const agentRequest = toWebRequest(
          request,
          `${originString}${request.url ?? pathname}`,
          body,
        );
        const agentResponse = await kugouAgentApi.fetch(agentRequest);
        await writeWebResponse(agentResponse, response);
        return;
      }

      if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
        response.writeHead(204, corsHeaders(request));
        response.end();
        return;
      }

      const webRequest = toWebRequest(request);
      const metadataResponse = oauthMetadataResponse(webRequest, metadataOptions);
      if (metadataResponse) {
        await writeWebResponse(metadataResponse, response);
        return;
      }

      if (pathname === '/healthz' && request.method === 'GET') {
        json(response, 200, { ok: true, service: 'netease-music-personal-mcp', version: '0.6.0' });
        return;
      }

      if (pathname === '/' && request.method === 'GET') {
        const owner = await store.getOwner();
        html(
          response,
          200,
          page(
            '连接',
            `<div class="card"><h1>网易云音乐 MCP</h1>
              <p>这是一个私有的个人实例：一个所有者、一份网易云会话、一套独立 Token。</p>
              <p><code>${escapeHtml(resource)}</code></p>
              <a class="button" href="${owner ? '/dashboard' : '/setup'}">${owner ? '登录控制台' : '首次初始化'}</a>
              <a class="button secondary" href="/openapi.json">OpenAPI</a></div>`,
          ),
        );
        return;
      }

      if (pathname === '/docs' && request.method === 'GET') {
        html(
          response,
          200,
          page(
            '接入说明',
            `<div class="card"><h1>接入说明</h1>
              <h2>标准远程 MCP</h2><p>服务器地址：<code>${escapeHtml(resource)}</code>。客户端应通过 OAuth 自动授权。</p>
              <h2>自建前端与其他模型</h2><p>使用控制台生成的个人 Token 调用 <code>${escapeHtml(originString)}/api/v1</code>，接口描述见 <a href="/openapi.json">OpenAPI</a>。</p>
              <p class="notice">Token 是本服务凭据，不是网易云密码。请勿公开或写进前端源码。</p></div>`,
          ),
        );
        return;
      }

      if (pathname === '/openapi.json' && request.method === 'GET') {
        json(
          response,
          200,
          createOpenApi(originString, { kugouEnabled: Boolean(kugouBridge) }),
          { 'access-control-allow-origin': '*' },
        );
        return;
      }

      if (pathname === '/oauth/register' && request.method === 'POST') {
        if (!oauthRegistrationLimiter.check(requestIdentity(request))) {
          json(response, 429, { error: 'slow_down' });
          return;
        }
        try {
          const body = await readJson(request);
          const registered = await store.registerClient(body);
          json(response, 201, registered, { 'access-control-allow-origin': '*' });
        } catch (error) {
          json(
            response,
            400,
            { error: 'invalid_client_metadata', error_description: error.message },
            { 'access-control-allow-origin': '*' },
          );
        }
        return;
      }

      if (pathname === '/oauth/token' && request.method === 'POST') {
        try {
          const form = await readForm(request);
          const credentials = getClientCredentials(request, form);
          let tokens;
          if (form.get('grant_type') === 'authorization_code') {
            tokens = await store.exchangeAuthorizationCode({
              code: form.get('code') ?? '',
              clientId: credentials.clientId,
              clientSecret: credentials.clientSecret,
              redirectUri: form.get('redirect_uri') ?? '',
              codeVerifier: form.get('code_verifier') ?? '',
              resource: form.get('resource') ?? resource,
            });
          } else if (form.get('grant_type') === 'refresh_token') {
            tokens = await store.refreshAccessToken({
              refreshToken: form.get('refresh_token') ?? '',
              clientId: credentials.clientId,
              clientSecret: credentials.clientSecret,
              resource: form.get('resource') ?? resource,
              scopes: form.get('scope') || undefined,
            });
          } else {
            json(response, 400, { error: 'unsupported_grant_type' });
            return;
          }
          json(response, 200, tokens, { 'access-control-allow-origin': '*' });
        } catch (error) {
          const isClientError = /客户端认证/.test(error.message);
          json(
            response,
            isClientError ? 401 : 400,
            {
              error: isClientError ? 'invalid_client' : 'invalid_grant',
              error_description: error.message,
            },
            { 'access-control-allow-origin': '*' },
          );
        }
        return;
      }

      if (pathname === '/oauth/revoke' && request.method === 'POST') {
        const form = await readForm(request);
        await store.revokeToken(form.get('token'));
        json(response, 200, {});
        return;
      }

      if (pathname === '/oauth/authorize' && request.method === 'GET') {
        const client = await validateAuthorizationRequest(incoming, store, resource);
        const account = await getBrowserAccount(request);
        if (!account) {
          const returnTo = `${pathname}${incoming.search}`;
          if (!(await store.getOwner())) {
            redirect(
              response,
              `/setup?return_to=${encodeURIComponent(returnTo)}`,
            );
            return;
          }
          html(
            response,
            200,
            page(
              '登录授权',
              `<div class="card"><h1>登录并授权</h1>
                <p class="muted">客户端：${escapeHtml(client.clientName)}</p>
                <form method="post" action="/account/login">
                  <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
                  <label>用户名</label><input name="username" autocomplete="username" required>
                  <label>密码</label><input type="password" name="password" autocomplete="current-password" required>
                  <button type="submit">登录</button>
                </form></div>
                ${
                  ''
                }`,
            ),
          );
          return;
        }
        const scopes = incoming.searchParams.get('scope')?.split(/\s+/).filter(Boolean) ?? [];
        html(
          response,
          200,
          page(
            '确认授权',
            `<div class="card"><h1>允许 ${escapeHtml(client.clientName)} 访问？</h1>
              <p>登录账号：<strong>${escapeHtml(account.user.username)}</strong></p>
              ${scopeLabels(scopes).join('')}
              <form method="post" action="/oauth/authorize">
                ${[...incoming.searchParams.entries()]
                  .map(
                    ([name, value]) =>
                      `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
                  )
                  .join('')}
                <input type="hidden" name="csrf" value="${escapeHtml(account.csrfToken)}">
                <button type="submit" name="decision" value="approve">允许</button>
                <button type="submit" class="secondary" name="decision" value="deny">拒绝</button>
              </form></div>`,
          ),
          {
            'content-security-policy': oauthConsentCsp(
              incoming.searchParams.get('redirect_uri'),
            ),
          },
        );
        return;
      }

      if (pathname === '/oauth/authorize' && request.method === 'POST') {
        const form = await readForm(request);
        const account = await getBrowserAccount(request);
        if (!account) {
          json(response, 401, { error: 'login_required' });
          return;
        }
        if (!store.verifyCsrf(account, form.get('csrf'))) {
          json(response, 403, { error: 'invalid_csrf' });
          return;
        }
        const requestUrl = new URL('/oauth/authorize', originString);
        for (const [name, value] of form.entries()) {
          if (!['decision', 'csrf'].includes(name)) requestUrl.searchParams.append(name, value);
        }
        const client = await validateAuthorizationRequest(requestUrl, store, resource);
        const redirectUri = requestUrl.searchParams.get('redirect_uri');
        const state = requestUrl.searchParams.get('state');
        if (form.get('decision') !== 'approve') {
          redirect(response, appendOAuthResult(redirectUri, { error: 'access_denied', state }));
          return;
        }
        const code = await store.issueAuthorizationCode({
          userId: account.user.id,
          clientId: client.clientId,
          redirectUri,
          codeChallenge: requestUrl.searchParams.get('code_challenge'),
          scopes: requestUrl.searchParams.get('scope'),
          resource,
        });
        redirect(response, appendOAuthResult(redirectUri, { code, state }));
        return;
      }

      if (pathname === '/account/login' && request.method === 'POST') {
        const form = await readForm(request);
        const clientAddress = requestIdentity(request);
        if (!loginLimiter.check(clientAddress)) {
          html(response, 429, page('请求过多', '<div class="card"><h1>请稍后重试</h1></div>'));
          return;
        }
        const user = await store.authenticateOwner(form.get('username'), form.get('password'));
        if (!user) {
          html(response, 401, page('登录失败', '<div class="card"><h1>用户名或密码错误</h1><a class="button" href="/">返回</a></div>'));
          return;
        }
        const session = await store.createBrowserSession(user.id);
        redirect(response, safeReturnTo(form.get('return_to')), [
          sessionCookie(session.token, secureCookies, session.expiresIn),
        ]);
        return;
      }

      if (pathname === '/setup' && request.method === 'POST') {
        if (!setupLimiter.check(requestIdentity(request))) {
          json(response, 429, { error: 'slow_down' });
          return;
        }
        if (await store.getOwner()) {
          json(response, 409, { error: 'already_initialized' });
          return;
        }
        const form = await readForm(request);
        const user = await store.createOwner(form.get('username'), form.get('password'));
        const session = await store.createBrowserSession(user.id);
        redirect(response, safeReturnTo(form.get('return_to')), [
          sessionCookie(session.token, secureCookies, session.expiresIn),
        ]);
        return;
      }

      if (pathname === '/register' && request.method === 'GET') {
        redirect(response, '/setup');
        return;
      }

      if (pathname === '/setup' && request.method === 'GET') {
        if (await store.getOwner()) {
          redirect(response, '/dashboard');
          return;
        }
        html(
          response,
          200,
          page(
            '首次初始化',
            `<div class="card"><h1>初始化你的个人 MCP</h1>
              <p class="notice">每个部署只能创建一个所有者。其他人应部署自己的实例，不能在这里注册。</p>
              <form method="post" action="/setup">
                <input type="hidden" name="return_to" value="${escapeHtml(safeReturnTo(incoming.searchParams.get('return_to')))}">
                <label>所有者名称</label><input name="username" autocomplete="username" required>
                <label>控制台密码（至少10位）</label><input type="password" name="password" autocomplete="new-password" minlength="10" required>
                <button>创建个人实例</button>
              </form></div>`,
          ),
        );
        return;
      }

      if (pathname === '/account/logout' && request.method === 'POST') {
        await store.revokeBrowserSession(parseCookies(request).nmcp_session);
        redirect(response, '/', [sessionCookie('', secureCookies, 0)]);
        return;
      }

      if (pathname === '/dashboard' && request.method === 'GET') {
        const account = await getBrowserAccount(request);
        if (!account) {
          if (!(await store.getOwner())) {
            redirect(response, '/setup?return_to=%2Fdashboard');
            return;
          }
          html(
            response,
            401,
            page(
              '登录',
              `<div class="card"><h1>控制台登录</h1><form method="post" action="/account/login">
                <input type="hidden" name="return_to" value="/dashboard">
                <label>用户名</label><input name="username" required>
                <label>密码</label><input type="password" name="password" required>
                <button>登录</button></form></div>
                <p class="muted">尚未初始化时，请从实例首页进入“首次初始化”。</p>`,
            ),
          );
          return;
        }
        const tokens = await store.listPersonalAccessTokens(account.user.id);
        const neteaseStatus = await store.getNeteaseSessionStatus(account.user.id);
        html(
          response,
          200,
          page(
            '控制台',
            `<div class="card"><h1>你好，${escapeHtml(account.user.username)}</h1>
              <p>MCP 地址：<code>${escapeHtml(resource)}</code></p>
              <form class="inline" method="post" action="/account/logout"><button class="secondary">退出</button></form></div>
            <div class="card"><h2>个人 Token</h2>
              <p class="muted">用于自建前端、ChatGPT Actions、DeepSeek 工具桥或其他不支持 MCP OAuth 的客户端。Token 只会显示一次。</p>
              <form method="post" action="/dashboard/tokens">
                <label>名称</label><input name="label" value="my device" required>
                <label>有效天数</label><input type="number" name="days" value="30" min="1" max="365" required>
                <input type="hidden" name="csrf" value="${escapeHtml(account.csrfToken)}">
                ${PERSONAL_SCOPES.map((scope) => `<label><input style="width:auto" type="checkbox" name="scope" value="${scope}" ${scope === 'music:read' ? 'checked' : ''}> ${scope}</label>`).join('')}
                <button>生成 Token</button>
              </form>
              <h3>已签发</h3>
              ${tokens.length ? tokens.map((token) => `<p><strong>${escapeHtml(token.label)}</strong> · ${escapeHtml(token.scopes.join(', '))} · 到期 ${new Date(token.expiresAt * 1000).toLocaleDateString('zh-CN')}
                <form class="inline" method="post" action="/dashboard/tokens/revoke">
                  <input type="hidden" name="token_id" value="${escapeHtml(token.id)}">
                  <input type="hidden" name="csrf" value="${escapeHtml(account.csrfToken)}">
                  <button class="secondary">撤销</button>
                </form></p>`).join('') : '<p class="muted">暂无</p>'}
            </div>
            <div class="card"><h2>网易云账号会话</h2>
              <p>状态：${neteaseStatus.enabled ? '已连接' : '未连接'}</p>
              <p class="notice">仅粘贴 <code>MUSIC_U=…; __csrf=…</code>，服务端使用主密钥加密保存。不要输入网易云账号密码。</p>
              <form method="post" action="/dashboard/netease-session">
                <label>会话 Cookie</label><input type="password" name="cookie" autocomplete="off" required>
                <input type="hidden" name="csrf" value="${escapeHtml(account.csrfToken)}">
                <button>保存会话</button>
              </form>
              ${neteaseStatus.enabled ? `<form method="post" action="/dashboard/netease-session/delete">
                <input type="hidden" name="csrf" value="${escapeHtml(account.csrfToken)}">
                <button class="secondary">断开网易云会话</button>
              </form>` : ''}
            </div>`,
          ),
        );
        return;
      }

      if (pathname === '/dashboard/tokens' && request.method === 'POST') {
        const account = await getBrowserAccount(request);
        const form = await readForm(request);
        if (!account || !store.verifyCsrf(account, form.get('csrf'))) {
          json(response, 403, { error: 'invalid_csrf' });
          return;
        }
        const issued = await store.createPersonalAccessToken(account.user.id, {
          label: form.get('label'),
          scopes: form.getAll('scope'),
          resource,
          expiresInDays: form.get('days'),
        });
        html(
          response,
          201,
          page(
            'Token 已生成',
            `<div class="card"><h1>请立即保存 Token</h1>
              <p class="notice">关闭此页后无法再次查看。</p>
              <pre>${escapeHtml(issued.token)}</pre>
              <a class="button" href="/dashboard">返回控制台</a></div>`,
          ),
        );
        return;
      }

      if (pathname === '/dashboard/netease-session' && request.method === 'POST') {
        const account = await getBrowserAccount(request);
        const form = await readForm(request);
        if (!account || !store.verifyCsrf(account, form.get('csrf'))) {
          json(response, 403, { error: 'invalid_csrf' });
          return;
        }
        await store.saveNeteaseSession(account.user.id, form.get('cookie'));
        redirect(response, '/dashboard');
        return;
      }

      if (pathname === '/dashboard/tokens/revoke' && request.method === 'POST') {
        const account = await getBrowserAccount(request);
        const form = await readForm(request);
        if (!account || !store.verifyCsrf(account, form.get('csrf'))) {
          json(response, 403, { error: 'invalid_csrf' });
          return;
        }
        await store.revokePersonalAccessToken(account.user.id, form.get('token_id'));
        redirect(response, '/dashboard');
        return;
      }

      if (
        pathname === '/dashboard/netease-session/delete' &&
        request.method === 'POST'
      ) {
        const account = await getBrowserAccount(request);
        const form = await readForm(request);
        if (!account || !store.verifyCsrf(account, form.get('csrf'))) {
          json(response, 403, { error: 'invalid_csrf' });
          return;
        }
        await store.deleteNeteaseSession(account.user.id);
        redirect(response, '/dashboard');
        return;
      }

      if (pathname === '/mcp') {
        if (!['POST', 'GET', 'DELETE'].includes(request.method ?? '')) {
          response.writeHead(405, { allow: 'POST, GET, DELETE' });
          response.end();
          return;
        }
        const body = ['GET', 'HEAD'].includes(request.method ?? '')
          ? undefined
          : await readBody(request);
        const mcpRequest = toWebRequest(request, resource, body);
        const authInfo = await mcpAuthGate(mcpRequest);
        if (authInfo instanceof Response) {
          await writeWebResponse(authInfo, response);
          return;
        }
        const mcpResponse = await mcpHandler.fetch(mcpRequest, { authInfo });
        const finalResponse = isSingleToolsListRequest(body)
          ? await adaptToolsListResponse(mcpResponse)
          : mcpResponse;
        await writeWebResponse(finalResponse, response);
        return;
      }

      if (!kugouBridge && pathname.startsWith('/api/v1/kugou/')) {
        json(response, 404, { error: 'not_found' });
        return;
      }

      if (
        kugouBridge &&
        pathname.startsWith('/api/v1/kugou/') &&
        kugouAgentApi?.matchesAuthorizationHeader(request.headers.authorization)
      ) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }

      if (pathname.startsWith('/api/v1/')) {
        const routeCors = corsHeaders(request);
        const musicMatch = pathname.match(/^\/api\/v1\/lyrics\/(\d{1,20})$/);
        const tracksMatch = pathname.match(/^\/api\/v1\/playlists\/(\d{1,20})\/tracks$/);
        let authInfo;
        if (
          pathname === '/api/v1/search' ||
          pathname === '/api/v1/song-details' ||
          musicMatch ||
          (kugouBridge && pathname === '/api/v1/kugou/status')
        ) {
          authInfo = await requireApiAuth(request, response, ['music:read']);
          if (!authInfo) return;
        } else if (kugouBridge && pathname === '/api/v1/kugou/control') {
          authInfo = await requireApiAuth(request, response, ['player:control']);
          if (!authInfo) return;
        } else if (pathname === '/api/v1/playlists' && request.method === 'GET') {
          authInfo = await requireApiAuth(request, response, ['playlist:read']);
          if (!authInfo) return;
        } else {
          authInfo = await requireApiAuth(request, response, ['playlist:write']);
          if (!authInfo) return;
        }
        const userId = authInfo.extra.userId;
        if (pathname === '/api/v1/search' && request.method === 'GET') {
          json(response, 200, await searchSongs(incoming.searchParams.get('q'), Number(incoming.searchParams.get('limit') ?? 10), Number(incoming.searchParams.get('offset') ?? 0)), routeCors);
          return;
        }
        if (pathname === '/api/v1/song-details' && request.method === 'POST') {
          const body = await readJson(request);
          json(response, 200, await getSongDetails(body.songIds), routeCors);
          return;
        }
        if (musicMatch && request.method === 'GET') {
          json(response, 200, await getLyrics(musicMatch[1]), routeCors);
          return;
        }
        if (
          kugouBridge &&
          pathname === '/api/v1/kugou/status' &&
          request.method === 'GET'
        ) {
          json(response, 200, kugouBridge.getStatus(), routeCors);
          return;
        }
        if (
          kugouBridge &&
          pathname === '/api/v1/kugou/control' &&
          request.method === 'POST'
        ) {
          const body = await readJson(request);
          if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Object.keys(body).length !== 1 ||
            !Object.hasOwn(body, 'action')
          ) {
            const error = new Error('请求体只能包含 action。');
            error.statusCode = 400;
            throw error;
          }
          json(response, 202, kugouBridge.enqueueCommand(body.action), routeCors);
          return;
        }
        if (pathname === '/api/v1/playlists' && request.method === 'GET') {
          json(response, 200, await listOwnPlaylists(accountOptions(userId)), routeCors);
          return;
        }
        if (pathname === '/api/v1/playlists' && request.method === 'POST') {
          const body = await readJson(request);
          if (body.confirm !== true) throw new Error('必须传 confirm=true。');
          json(response, 200, await createPlaylist(body.name, body.isPrivate, accountOptions(userId)), routeCors);
          return;
        }
        if (tracksMatch && request.method === 'POST') {
          const body = await readJson(request);
          if (body.confirm !== true) throw new Error('必须传 confirm=true。');
          json(response, 200, await addSongsToPlaylist(tracksMatch[1], body.songIds, accountOptions(userId)), routeCors);
          return;
        }
        if (tracksMatch && request.method === 'DELETE') {
          const body = await readJson(request);
          if (body.confirm !== true) throw new Error('必须传 confirm=true。');
          json(response, 200, await removeSongsFromPlaylist(tracksMatch[1], body.songIds, accountOptions(userId)), routeCors);
          return;
        }
      }

      json(response, 404, { error: 'not_found' });
    } catch (error) {
      onError(error);
      const status = error?.statusCode ?? 400;
      if (String(request.url ?? '').startsWith('/oauth/')) {
        json(response, status, { error: 'invalid_request', error_description: error.message });
      } else {
        json(response, status, { error: error.message || 'request_failed' });
      }
    }
  });

  return {
    httpServer,
    resource,
    close: async () => {
      await mcpHandler.close();
      await new Promise((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function validateAuthorizationRequest(url, store, resource) {
  if (url.searchParams.get('response_type') !== 'code') {
    throw new Error('仅支持 response_type=code。');
  }
  if (url.searchParams.get('code_challenge_method') !== 'S256') {
    throw new Error('必须使用 PKCE S256。');
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(url.searchParams.get('code_challenge') ?? '')) {
    throw new Error('code_challenge 无效。');
  }
  if ((url.searchParams.get('resource') ?? resource) !== resource) {
    throw new Error('resource 与当前 MCP 不匹配。');
  }
  const client = await store.getClient(url.searchParams.get('client_id'));
  if (!client) throw new Error('未知的 OAuth 客户端。');
  if (!client.redirectUris.includes(url.searchParams.get('redirect_uri'))) {
    throw new Error('redirect_uri 未注册。');
  }
  const scopes = url.searchParams.get('scope')?.split(/\s+/).filter(Boolean) ?? [];
  if (scopes.length < 1 || scopes.some((scope) => !PERSONAL_SCOPES.includes(scope))) {
    throw new Error('scope 无效。');
  }
  return client;
}

function toWebRequest(request, overrideUrl, body) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return new Request(overrideUrl ?? `http://localhost${request.url ?? '/'}`, {
    method: request.method,
    headers,
    body: body ?? (['GET', 'HEAD'].includes(request.method ?? '') ? undefined : undefined),
  });
}

async function writeWebResponse(webResponse, response) {
  const headers = Object.fromEntries(webResponse.headers.entries());
  headers['cache-control'] = 'no-store';
  headers['x-content-type-options'] = 'nosniff';
  response.writeHead(webResponse.status, headers);
  if (!webResponse.body) {
    response.end();
    return;
  }
  Readable.fromWeb(webResponse.body).pipe(response);
}

function readFeatureFlag(name) {
  const value = process.env[name] ?? '0';
  if (!['0', '1'].includes(value)) {
    throw new Error(`${name} 必须是 0 或 1。`);
  }
  return value === '1';
}

async function main() {
  const origin = process.env.NETEASE_PERSONAL_ORIGIN;
  const storePath = process.env.NETEASE_PERSONAL_STORE_FILE;
  const masterKeyFile = process.env.NETEASE_PERSONAL_MASTER_KEY_FILE;
  if (!origin || !storePath || !masterKeyFile) {
    throw new Error(
      '必须配置 NETEASE_PERSONAL_ORIGIN、NETEASE_PERSONAL_STORE_FILE 和 NETEASE_PERSONAL_MASTER_KEY_FILE。',
    );
  }
  const masterKey = parseMasterKey(await readFile(masterKeyFile, 'utf8'));
  const store = new PersonalAuthStore({
    filePath: storePath,
    masterKey,
    allowedScopes: PERSONAL_SCOPES,
  });
  const kugouBridgeEnabled = readFeatureFlag('KUGOU_BRIDGE_ENABLED');
  const kugouControlEnabled = readFeatureFlag('KUGOU_CONTROL_ENABLED');
  let kugouBridge;
  let kugouAgentApi;
  if (kugouBridgeEnabled) {
    const registration = await loadKugouDeviceRegistration({
      devicesConfigFile: process.env.KUGOU_DEVICES_CONFIG_FILE,
      deviceTokenFile: process.env.KUGOU_DEVICE_TOKEN_FILE,
    });
    const activeDeviceId = String(
      process.env.KUGOU_ACTIVE_DEVICE_ID ?? 'pc-mumu',
    ).trim();
    kugouBridge = new KugouBridge({
      controlEnabled: kugouControlEnabled,
      activeDeviceId,
      ...(registration.mode === 'multi'
        ? { devices: registration.bridgeDevices }
        : {}),
    });
    kugouAgentApi = createKugouAgentApi({
      bridge: kugouBridge,
      ...(registration.mode === 'multi'
        ? { devices: registration.agentDevices }
        : { token: registration.token }),
    });
  }
  const instance = await createPersonalNeteaseServer({
    origin,
    store,
    kugouBridge,
    kugouAgentApi,
    allowedCorsOrigins: String(process.env.NETEASE_PERSONAL_CORS_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  });
  const host = process.env.NETEASE_PERSONAL_HOST ?? DEFAULT_HOST;
  const port = Number(process.env.NETEASE_PERSONAL_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('NETEASE_PERSONAL_PORT 必须是 1024–65535 的整数。');
  }
  instance.httpServer.listen(port, host, () => {
    console.log(`[netease-personal] listening on http://${host}:${port}`);
    console.log(`[netease-personal] resource ${instance.resource}`);
  });
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[netease-personal] startup failed: ${error.message}`);
    process.exit(1);
  });
}
