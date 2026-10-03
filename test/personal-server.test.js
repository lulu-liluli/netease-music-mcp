import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';

import { PersonalAuthStore, parseMasterKey } from '../src/personal-store.js';
import { createPersonalNeteaseServer, PERSONAL_SCOPES } from '../src/personal-server.js';
import { KugouBridge } from '../src/kugou-bridge.js';
import { KugouEventQueue } from '../src/kugou-event-queue.js';
import { KugouPlaybackEventAdapter } from '../src/kugou-events.js';
import { createKugouAgentApi } from '../src/kugou-agent-api.js';
import { createNeteaseMcpServer } from '../src/mcp-server.js';

const CANONICAL_ORIGIN = 'http://127.0.0.1';
const RESOURCE = `${CANONICAL_ORIGIN}/mcp`;
const DEVICE_TOKEN = randomBytes(32).toString('hex');
const PHONE_DEVICE_TOKEN = randomBytes(32).toString('hex');

async function withServer(operation, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'netease-personal-server-'));
  const store = new PersonalAuthStore({
    filePath: join(directory, 'auth.json'),
    masterKey: parseMasterKey('2'.repeat(64)),
    allowedScopes: PERSONAL_SCOPES,
  });
  const errors = [];
  const instance = await createPersonalNeteaseServer({
    origin: CANONICAL_ORIGIN,
    store,
    onError: (error) => errors.push(error),
    ...options,
  });
  await new Promise((resolve) => instance.httpServer.listen(0, '127.0.0.1', resolve));
  const address = instance.httpServer.address();
  try {
    return await operation({
      baseUrl: `http://127.0.0.1:${address.port}`,
      store,
      errors,
      instance,
    });
  } finally {
    if (instance.httpServer.listening) await instance.close();
  }
}

function parseMcpResponse(text, contentType) {
  if (contentType?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

async function readMcpResponse(response) {
  return parseMcpResponse(await response.text(), response.headers.get('content-type'));
}

function assertBearerFailure(response, payload, status = 401) {
  assert.equal(response.status, status);
  assert.equal(payload.error, status === 401 ? 'invalid_token' : 'insufficient_scope');
  const challenge = response.headers.get('www-authenticate');
  assert.match(challenge, /^Bearer /);
  assert.ok(challenge.includes(`error="${payload.error}"`));
  assert.ok(challenge.includes('scope="music:read"'));
  assert.ok(challenge.includes(
    `resource_metadata="${CANONICAL_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
  ));
  assert.match(challenge, /^[\x20-\x7e]+$/);
}

function mcpRequestBody(id, method = 'tools/list', params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function collectHttpResponse(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const localPort = response.socket?.localPort;
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        localPort,
        text: Buffer.concat(chunks).toString('utf8'),
      });
    });
    response.on('error', reject);
  });
}

function requestMcpOverHttp(baseUrl, token, body, { agent } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL('/mcp', baseUrl), {
      method: 'POST',
      agent,
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    });
    request.on('response', (response) => {
      collectHttpResponse(response).then(resolve, reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

function beginPartialMcpRequest(baseUrl, token, body, initialBytes, headers = {}) {
  let responseStarted = false;
  const request = httpRequest(new URL('/mcp', baseUrl), {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-length': Buffer.byteLength(body),
      'content-type': 'application/json',
      ...headers,
    },
  });
  const response = new Promise((resolve, reject) => {
    request.on('response', (incoming) => {
      responseStarted = true;
      collectHttpResponse(incoming).then(resolve, reject);
    });
    request.on('error', reject);
  });
  request.flushHeaders();
  request.write(body.slice(0, initialBytes));
  return {
    request,
    response,
    complete() {
      request.end(body.slice(initialBytes));
    },
    responseStarted: () => responseStarted,
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForCondition(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

function kugouPlaybackReport({
  agentInstanceId = '10000000-0000-4000-8000-000000000001',
  sequence,
  title,
  artist = 'Test Artist',
  album = 'Test Album',
  playbackState = 'playing',
  observedAt = `2026-09-27T12:00:${String(sequence).padStart(2, '0')}.000Z`,
} = {}) {
  return {
    protocol_version: 1,
    agent_instance_id: agentInstanceId,
    sequence,
    observed_at: observedAt,
    health: 'ok',
    capabilities: ['status', 'toggle', 'next', 'previous'],
    player: {
      package: 'com.kugou.android.lite',
      playback_state: playbackState,
      state_code: playbackState === 'playing' ? 3 : 2,
      title,
      artist,
      album,
      position_ms: 5_000,
    },
  };
}

async function uploadKugouStatus(baseUrl, report, token = DEVICE_TOKEN) {
  const response = await fetch(`${baseUrl}/agent/v1/status`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(report),
  });
  return { response, body: await response.json() };
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function eventServerOptions({ eventQueue = new KugouEventQueue(), ...bridgeOptions } = {}) {
  const kugouBridge = new KugouBridge({
    ...bridgeOptions,
    eventAdapter: new KugouPlaybackEventAdapter(),
    eventQueue,
  });
  return {
    kugouBridge,
    kugouEventQueue: eventQueue,
    kugouAgentApi: createKugouAgentApi({ bridge: kugouBridge, token: DEVICE_TOKEN }),
  };
}

async function eventAccessToken(store, scopes = ['music:read']) {
  const owner = await store.createOwner('event_owner', 'a sufficiently long password');
  return (await store.createPersonalAccessToken(owner.id, {
    label: 'local event test', scopes, resource: RESOURCE,
  })).token;
}

function eventMcpMessage(method, params, modern = false) {
  return mcpRequestBody(80, method, modern ? {
    ...params,
    _meta: {
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
      [CLIENT_INFO_META_KEY]: { name: 'local-event-test', version: '1.0.0' },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    },
  } : params);
}

function eventMcpHeaders(method, params, modern = false) {
  return modern ? {
    'mcp-method': method,
    ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}),
  } : {};
}

async function postEventMcp(baseUrl, token, method, params, { modern = false } = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...eventMcpHeaders(method, params, modern),
    },
    body: eventMcpMessage(method, params, modern),
  });
  const payload = await readMcpResponse(response);
  return { response, payload, result: payload.result };
}

function callEventMcp(baseUrl, token, name, args = {}, options) {
  return postEventMcp(baseUrl, token, 'tools/call', { name, arguments: args }, options);
}

function beginEventWait(baseUrl, token, args, modern = false) {
  const params = { name: 'kugou_wait', arguments: args };
  const body = eventMcpMessage('tools/call', params, modern);
  const pending = beginPartialMcpRequest(
    baseUrl, token, body, body.length, eventMcpHeaders('tools/call', params, modern),
  );
  // Install rejection handling before a test deliberately disconnects the socket.
  pending.settled = pending.response.catch((error) => error);
  pending.complete();
  return pending;
}

function observeEventWaits(t, queue) {
  const original = queue.waitNext.bind(queue);
  const calls = [];
  const started = [];
  t.mock.method(queue, 'waitNext', (options) => {
    const call = { options, promise: original(options) };
    void call.promise.catch(() => {});
    const index = calls.push(call) - 1;
    started[index]?.resolve(call);
    return call.promise;
  });
  return {
    calls,
    next(index = 0) {
      if (calls[index]) return Promise.resolve(calls[index]);
      started[index] ??= deferred();
      return started[index].promise;
    },
  };
}

function assertEventError(result, code) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.outcome, 'error');
  assert.equal(result.structuredContent.error.code, code);
  assert.match(result.content[0].text, new RegExp(`^${code}:`));
}

async function ackMcpEvent(baseUrl, token, data, options) {
  return callEventMcp(baseUrl, token, 'kugou_wait_ack', {
    eventId: data.event.id, receiptToken: data.reservation.receiptToken,
  }, options);
}

test('publishes OAuth discovery and challenges anonymous MCP clients', async () => {
  await withServer(async ({ baseUrl }) => {
    const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(metadata.status, 200);
    assert.deepEqual((await metadata.json()).authorization_servers, [CANONICAL_ORIGIN]);

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'anonymous', version: '1' },
        },
      }),
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('content-type'), /application\/json/);
    const challenge = unauthorized.headers.get('www-authenticate');
    assert.match(challenge, /oauth-protected-resource\/mcp/);
    assert.match(challenge, /music:read/);
    assert.doesNotMatch(challenge, /playlist:read|playlist:write/);
    assert.equal(typeof (await unauthorized.json()).error, 'string');
  });
});

test('allows one-time owner setup and rejects a second owner', async () => {
  await withServer(async ({ baseUrl, store }) => {
    const setupPage = await fetch(`${baseUrl}/setup`);
    assert.equal(setupPage.status, 200);
    assert.match(await setupPage.text(), /每个部署只能创建一个所有者/);

    const setup = await fetch(`${baseUrl}/setup`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: 'only_owner',
        password: 'one private instance password',
        return_to: '/dashboard',
      }),
    });
    assert.equal(setup.status, 303);
    assert.equal(setup.headers.get('location'), '/dashboard');
    assert.equal((await store.getOwner()).username, 'only_owner');

    const secondSetup = await fetch(`${baseUrl}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: 'second_owner',
        password: 'should never create another owner',
      }),
    });
    assert.equal(secondSetup.status, 409);
    assert.equal((await secondSetup.json()).error, 'already_initialized');
  });
});

test('completes dynamic registration, PKCE authorization and MCP access', async () => {
  await withServer(async ({ baseUrl, store, errors }) => {
    const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'cross-platform test',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(registration.status, 201);
    const client = await registration.json();

    const user = await store.createOwner('personal_user', 'a secure personal password');
    const browserSession = await store.createBrowserSession(user.id);
    const verifier = 'p'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL(`${baseUrl}/oauth/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', client.client_id);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('scope', PERSONAL_SCOPES.join(' '));
    authorize.searchParams.set('state', 'test-state');
    authorize.searchParams.set('resource', RESOURCE);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');

    const consent = await fetch(authorize, {
      headers: { cookie: `nmcp_session=${browserSession.token}` },
    });
    assert.equal(consent.status, 200);
    assert.match(await consent.text(), /cross-platform test/);
    assert.match(
      consent.headers.get('content-security-policy'),
      /form-action 'self' https:\/\/claude\.ai/,
    );

    const form = new URLSearchParams(authorize.searchParams);
    form.set('decision', 'approve');
    form.set('csrf', browserSession.csrfToken);
    const approval = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `nmcp_session=${browserSession.token}`,
      },
      body: form,
    });
    assert.equal(approval.status, 303);
    const callback = new URL(approval.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'test-state');
    assert.ok(callback.searchParams.get('code'));

    const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: callback.searchParams.get('code'),
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();

    const initialized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'authorized', version: '1' },
        },
      }),
    });
    assert.equal(initialized.status, 200);
    const mcp = await readMcpResponse(initialized);
    assert.equal(mcp.result.serverInfo.name, 'netease-music-mcp');
    assert.deepEqual((await store.verifyAccessToken(tokens.access_token, RESOURCE)).scopes, PERSONAL_SCOPES);
    const refreshedResponse = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
        resource: RESOURCE,
      }),
    });
    assert.equal(refreshedResponse.status, 200);
    const refreshed = await refreshedResponse.json();
    assert.equal(refreshed.token_type, 'Bearer');
    assert.equal(refreshed.scope, PERSONAL_SCOPES.join(' '));
    assert.equal(refreshed.refresh_token === tokens.refresh_token, false);
    for (const credential of [tokens.access_token, refreshed.access_token]) {
      const listed = await postEventMcp(baseUrl, credential, 'tools/list', {});
      assert.equal(listed.response.status, 200);
      assert.equal(listed.result.tools.length, 16);
    }
    assert.deepEqual(errors, []);
  });
});

for (const kind of ['unknown', 'revoked', 'expired', 'wrong audience']) {
  test(`rejects ${kind} credentials with a sanitized 401 challenge before tool execution`, async (t) => {
    const options = eventServerOptions({ controlEnabled: true });
    const wait = t.mock.method(options.kugouEventQueue, 'waitNext');
    const ack = t.mock.method(options.kugouEventQueue, 'ack');
    const control = t.mock.method(options.kugouBridge, 'enqueueCommand');
    const status = t.mock.method(options.kugouBridge, 'getStatus');
    await withServer(async ({ baseUrl, store, errors }) => {
      const valid = await eventAccessToken(store, PERSONAL_SCOPES);
      const owner = await store.getOwner();
      let credential = randomBytes(32).toString('base64url');
      if (kind !== 'unknown') {
        credential = (await store.createPersonalAccessToken(owner.id, {
          label: 'rejected credential',
          scopes: PERSONAL_SCOPES,
          resource: kind === 'wrong audience' ? 'https://other.example.test/mcp' : RESOURCE,
        })).token;
      }
      if (kind === 'revoked') await store.revokeToken(credential);
      if (kind === 'expired') {
        const data = JSON.parse(await readFile(store.filePath, 'utf8'));
        const hash = createHash('sha256').update(credential).digest('hex');
        data.accessTokens.find((entry) => entry.tokenHash === hash).expiresAt =
          Math.floor(Date.now() / 1000) - 1;
        await writeFile(store.filePath, JSON.stringify(data));
      }
      const before = await readFile(store.filePath, 'utf8');
      const calls = [
        ['kugou_status', {}],
        ['kugou_control', { action: 'toggle' }],
        ['kugou_wait', { timeout_ms: 1 }],
        ['kugou_wait_ack', { eventId: 'unused', receiptToken: 'unused' }],
      ];
      for (const modern of [false, true]) {
        for (const [name, args] of calls) {
          const denied = await callEventMcp(baseUrl, credential, name, args, { modern });
          assertBearerFailure(denied.response, denied.payload);
          assert.equal(denied.payload.error_description, 'Invalid access token.');
          assert.equal(denied.result, undefined);
          const publicError = JSON.stringify({
            body: denied.payload, challenge: denied.response.headers.get('www-authenticate'),
          });
          for (const secret of [credential, valid, DEVICE_TOKEN, store.filePath]) {
            assert.equal(publicError.includes(secret), false);
          }
        }
      }
      const rest = await fetch(`${baseUrl}/api/v1/kugou/status`, {
        headers: { authorization: `Bearer ${credential}` },
      });
      const restError = await rest.json();
      assertBearerFailure(rest, restError);
      assert.equal(restError.error_description, 'Invalid access token.');
      assert.equal(JSON.stringify(restError).includes(credential), false);
      assert.equal(wait.mock.callCount(), 0);
      assert.equal(ack.mock.callCount(), 0);
      assert.equal(control.mock.callCount(), 0);
      assert.equal(status.mock.callCount(), 0);
      const listed = await postEventMcp(baseUrl, valid, 'tools/list', {});
      assert.equal(listed.response.status, 200);
      assert.equal(listed.result.tools.length, 20);
      assert.equal(await readFile(store.filePath, 'utf8'), before);
      assert.deepEqual(errors, []);
    }, options);
  });
}

for (const kind of ['unavailable storage', 'invalid stored JSON', 'internal verifier error']) {
  test(`keeps ${kind} as a sanitized 500 without an authentication challenge`, async (t) => {
    await withServer(async ({ baseUrl, store, errors }) => {
      const credential = await eventAccessToken(store, PERSONAL_SCOPES);
      const raw = await readFile(store.filePath, 'utf8');
      const privateDetail = `Invalid access token. private backend ${credential} ${DEVICE_TOKEN}`;
      let restore;
      if (kind === 'unavailable storage') {
        const unavailablePath = `${store.filePath}.unavailable`;
        await rename(store.filePath, unavailablePath);
        restore = () => rename(unavailablePath, store.filePath);
      } else if (kind === 'invalid stored JSON') {
        await writeFile(store.filePath, `{"private_detail":"${privateDetail}`);
        restore = () => writeFile(store.filePath, raw);
      } else {
        const verifier = t.mock.method(store, 'verifyAccessToken', () => {
          throw new Error(privateDetail);
        });
        restore = () => verifier.mock.restore();
      }
      try {
        const responses = [];
        for (const modern of [false, true]) {
          const denied = await postEventMcp(baseUrl, credential, 'tools/list', {}, { modern });
          responses.push({ response: denied.response, payload: denied.payload });
        }
        const rest = await fetch(`${baseUrl}/api/v1/kugou/status`, {
          headers: { authorization: `Bearer ${credential}` },
        });
        responses.push({ response: rest, payload: await rest.json() });
        for (const { response, payload } of responses) {
          assert.equal(response.status, 500);
          assert.equal(response.headers.get('www-authenticate'), null);
          assert.deepEqual(payload, {
            error: 'server_error', error_description: 'Internal Server Error',
          });
          for (const secret of [credential, DEVICE_TOKEN, privateDetail, store.filePath, 'stack']) {
            assert.equal(JSON.stringify(payload).includes(secret), false);
          }
        }
      } finally {
        await restore();
      }
      assert.equal((await postEventMcp(baseUrl, credential, 'tools/list', {})).response.status, 200);
      assert.equal(await readFile(store.filePath, 'utf8'), raw);
      assert.deepEqual(errors, []);
    }, eventServerOptions());
  });
}

for (const modern of [false, true]) {
  test(`keeps full-scope tool discovery and all Kugou calls usable (${modern ? 'JSON' : 'SSE'})`, async () => {
    const options = eventServerOptions({ controlEnabled: true });
    await withServer(async ({ baseUrl, store, errors }) => {
      const credential = await eventAccessToken(store, PERSONAL_SCOPES);
      const before = await readFile(store.filePath, 'utf8');
      const listed = await postEventMcp(baseUrl, credential, 'tools/list', {}, { modern });
      assert.equal(listed.response.status, 200);
      assert.equal(listed.result.tools.length, 20);
      assert.deepEqual(listed.result.tools.filter((tool) => tool.name.startsWith('kugou_')).map((tool) => tool.name), [
        'kugou_status', 'kugou_control', 'kugou_wait', 'kugou_wait_ack',
      ]);
      const playlistAuth = await callEventMcp(baseUrl, credential, 'netease_playlist_auth_status', {}, { modern });
      assert.equal(playlistAuth.response.status, 200);
      assert.equal(playlistAuth.result.isError, undefined);
      await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 1, title: 'Song A' }));
      await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 2, title: 'Song B' }));
      const status = await callEventMcp(baseUrl, credential, 'kugou_status', {}, { modern });
      assert.equal(status.response.status, 200);
      assert.equal(status.result.isError, undefined);
      assert.equal(JSON.parse(status.result.content[0].text).player.title, 'Song B');
      const control = await callEventMcp(baseUrl, credential, 'kugou_control', { action: 'toggle' }, { modern });
      assert.equal(control.response.status, 200);
      assert.equal(control.result.isError, undefined);
      assert.equal(JSON.parse(control.result.content[0].text).action, 'toggle');
      const waiting = await callEventMcp(baseUrl, credential, 'kugou_wait', {}, { modern });
      assert.equal(waiting.response.status, 200);
      assert.equal(waiting.result.structuredContent.event.eventType, 'track_changed');
      const ack = await ackMcpEvent(baseUrl, credential, waiting.result.structuredContent, { modern });
      assert.equal(ack.response.status, 200);
      assert.equal(ack.result.structuredContent.outcome, 'acknowledged');
      const timeout = await callEventMcp(baseUrl, credential, 'kugou_wait', { timeout_ms: 1 }, { modern });
      assert.deepEqual(timeout.result.structuredContent, { outcome: 'timeout' });
      assert.equal(await readFile(store.filePath, 'utf8'), before);
      assert.deepEqual(errors, []);
    }, options);
  });
}

test('fully streams MCP SSE responses and preserves HTTP keep-alive', async () => {
  await withServer(async ({ baseUrl, store, errors, instance }) => {
    const owner = await store.createOwner('transport_owner', 'a sufficiently long password');
    const token = await store.createPersonalAccessToken(owner.id, {
      label: 'transport tests',
      scopes: ['music:read'],
      resource: RESOURCE,
    });
    const observed = [];
    const observe = (request, response) => {
      if (request.url === '/mcp') observed.push({ request, response });
    };
    instance.httpServer.on('request', observe);
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    try {
      const first = await requestMcpOverHttp(
        baseUrl,
        token.token,
        mcpRequestBody(20),
        { agent },
      );
      const second = await requestMcpOverHttp(
        baseUrl,
        token.token,
        mcpRequestBody(21),
        { agent },
      );

      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);
      assert.match(first.headers['content-type'], /text\/event-stream/);
      assert.match(second.headers['content-type'], /text\/event-stream/);
      assert.ok(parseMcpResponse(first.text, first.headers['content-type']).result.tools);
      assert.ok(parseMcpResponse(second.text, second.headers['content-type']).result.tools);
      assert.equal(first.localPort, second.localPort);
      assert.equal(observed.length, 2);
      await nextTurn();
      for (const exchange of observed) {
        assert.equal(exchange.request.aborted, false);
        assert.equal(exchange.response.writableFinished, true);
        assert.equal(exchange.request.listenerCount('aborted'), 0);
      }
      assert.deepEqual(errors, []);
    } finally {
      agent.destroy();
      instance.httpServer.off('request', observe);
    }
  });
});

test('isolates an interrupted MCP request body from another request', async () => {
  await withServer(async ({ baseUrl, store, errors, instance }) => {
    const owner = await store.createOwner('abort_owner', 'a sufficiently long password');
    const token = await store.createPersonalAccessToken(owner.id, {
      label: 'abort tests',
      scopes: ['music:read'],
      resource: RESOURCE,
    });
    const observed = [];
    let resolveObserved;
    const bothObserved = new Promise((resolve) => {
      resolveObserved = resolve;
    });
    const observe = (request, response) => {
      if (request.url !== '/mcp') return;
      observed.push({ request, response });
      if (observed.length === 2) resolveObserved();
    };
    instance.httpServer.on('request', observe);
    const first = beginPartialMcpRequest(
      baseUrl,
      token.token,
      mcpRequestBody(30),
      12,
    );
    const second = beginPartialMcpRequest(
      baseUrl,
      token.token,
      mcpRequestBody(31),
      12,
    );
    const firstSettled = first.response.catch((error) => error);
    try {
      await bothObserved;
      first.request.destroy();
      second.complete();

      const [firstResult, secondResult] = await Promise.all([
        firstSettled,
        second.response,
      ]);
      assert.ok(firstResult instanceof Error);
      assert.equal(first.responseStarted(), false);
      assert.equal(secondResult.statusCode, 200);
      assert.ok(
        parseMcpResponse(secondResult.text, secondResult.headers['content-type']).result.tools,
      );
      await nextTurn();
      assert.equal(observed[0].request.listenerCount('aborted'), 0);
      assert.equal(observed[1].request.listenerCount('aborted'), 0);
      assert.equal(observed[1].response.writableFinished, true);
      assert.deepEqual(errors, []);
    } finally {
      second.request.destroy();
      instance.httpServer.off('request', observe);
    }
  });
});

test('treats an MCP response connection closing early as cancellation', async () => {
  await withServer(async ({ baseUrl, store, errors, instance }) => {
    const owner = await store.createOwner('response_abort', 'a sufficiently long password');
    const token = await store.createPersonalAccessToken(owner.id, {
      label: 'response abort',
      scopes: ['music:read'],
      resource: RESOURCE,
    });
    let observed;
    let resolveBodyRead;
    const bodyRead = new Promise((resolve) => {
      resolveBodyRead = resolve;
    });
    const observe = (request, response) => {
      if (request.url !== '/mcp') return;
      observed = { request, response };
      request.once('end', resolveBodyRead);
    };
    instance.httpServer.on('request', observe);
    const body = mcpRequestBody(40);
    const pending = beginPartialMcpRequest(baseUrl, token.token, body, body.length);
    const settled = pending.response.catch((error) => error);
    try {
      pending.complete();
      await bodyRead;
      pending.request.destroy();
      const result = await settled;
      assert.ok(result instanceof Error);
      assert.equal(
        await waitForCondition(
          () =>
            observed.request
              .rawListeners('aborted')
              .every((listener) => listener.name !== 'onRequestAborted') &&
            observed.response
              .rawListeners('finish')
              .every((listener) => listener.name !== 'onResponseFinish') &&
            observed.response
              .rawListeners('close')
              .every((listener) => listener.name !== 'onResponseClose'),
        ),
        true,
      );
      assert.equal(observed.request.aborted, false);
      assert.equal(observed.response.writableFinished, false);
      assert.equal(observed.request.listenerCount('aborted'), 0);
      assert.equal(observed.response.listenerCount('close'), 0);
      assert.deepEqual(errors, []);
    } finally {
      instance.httpServer.off('request', observe);
    }
  });
});

test('server shutdown cancels an active MCP request without waiting for its body', async () => {
  await withServer(async ({ baseUrl, store, errors, instance }) => {
    const owner = await store.createOwner('shutdown_owner', 'a sufficiently long password');
    const token = await store.createPersonalAccessToken(owner.id, {
      label: 'shutdown tests',
      scopes: ['music:read'],
      resource: RESOURCE,
    });
    let resolveObserved;
    const observed = new Promise((resolve) => {
      resolveObserved = resolve;
    });
    const observe = (request) => {
      if (request.url === '/mcp') resolveObserved();
    };
    instance.httpServer.on('request', observe);
    const pending = beginPartialMcpRequest(
      baseUrl,
      token.token,
      mcpRequestBody(50),
      12,
    );
    const settled = pending.response.catch((error) => error);
    try {
      await observed;
      const startedAt = Date.now();
      await instance.close();
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 1_000, `shutdown took ${elapsedMs}ms`);
      assert.ok((await settled) instanceof Error);
      assert.deepEqual(errors, []);
    } finally {
      pending.request.destroy();
      instance.httpServer.off('request', observe);
    }
  });
});

test('hides every Kugou route and tool when the bridge is not injected', async () => {
  await withServer(async ({ baseUrl, store }) => {
    const owner = await store.createOwner('hidden_kugou', 'a sufficiently long password');
    const token = await store.createPersonalAccessToken(owner.id, {
      label: 'read only',
      scopes: ['music:read'],
      resource: RESOURCE,
    });
    const headers = { authorization: `Bearer ${token.token}` };

    assert.equal((await fetch(`${baseUrl}/api/v1/kugou/status`, { headers })).status, 404);
    assert.equal(
      (
        await fetch(`${baseUrl}/agent/v1/status`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      404,
    );
    const openapi = await (await fetch(`${baseUrl}/openapi.json`)).json();
    assert.equal(openapi.paths['/kugou/status'], undefined);

    const listed = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        ...headers,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const payload = await readMcpResponse(listed);
    assert.equal(payload.result.tools.some((tool) => tool.name.startsWith('kugou_')), false);
  });
});

test('shares one startup Event Queue across Agent HTTP status reports', async () => {
  const eventAdapter = new KugouPlaybackEventAdapter();
  const eventQueue = new KugouEventQueue();
  const bridge = new KugouBridge({
    eventAdapter,
    eventQueue,
  });
  const agentApi = createKugouAgentApi({ bridge, token: DEVICE_TOKEN });

  await withServer(
    async ({ baseUrl }) => {
      const baseline = await uploadKugouStatus(
        baseUrl,
        kugouPlaybackReport({ sequence: 1, title: 'Song A' }),
      );
      assert.equal(baseline.response.status, 200);
      assert.deepEqual(
        { ok: baseline.body.ok, accepted: baseline.body.accepted },
        { ok: true, accepted: true },
      );
      assert.equal(eventQueue.reserveNext({ deviceId: 'pc-mumu' }), null);

      const changed = await uploadKugouStatus(
        baseUrl,
        kugouPlaybackReport({ sequence: 2, title: 'Song B' }),
      );
      assert.equal(changed.response.status, 200);
      assert.equal(changed.body.accepted, true);

      const reservation = eventQueue.reserveNext({ deviceId: 'pc-mumu' });
      assert.equal(reservation.event.eventType, 'track_changed');
      assert.equal(reservation.event.previous.track.title, 'Song A');
      assert.equal(reservation.event.previous.track.artist, 'Test Artist');
      assert.equal(reservation.event.current.track.title, 'Song B');
      assert.equal(reservation.event.current.track.artist, 'Test Artist');
      assert.equal(typeof reservation.receiptToken, 'string');
      assert.equal(Number.isFinite(reservation.leaseExpiresAt), true);

      const acknowledged = eventQueue.ack(
        reservation.event.id,
        reservation.receiptToken,
      );
      assert.equal(acknowledged.acknowledged, true);
      assert.equal(acknowledged.alreadyAcknowledged, false);

      const heartbeat = await uploadKugouStatus(
        baseUrl,
        kugouPlaybackReport({ sequence: 3, title: 'Song B' }),
      );
      assert.equal(heartbeat.body.accepted, true);
      assert.equal(eventQueue.reserveNext({ deviceId: 'pc-mumu' }), null);

      const stale = await uploadKugouStatus(
        baseUrl,
        kugouPlaybackReport({ sequence: 2, title: 'Song C' }),
      );
      assert.equal(stale.response.status, 200);
      assert.deepEqual(
        { accepted: stale.body.accepted, reason: stale.body.reason },
        { accepted: false, reason: 'stale_sequence' },
      );
      assert.equal(eventQueue.reserveNext({ deviceId: 'pc-mumu' }), null);

      const restarted = await uploadKugouStatus(
        baseUrl,
        kugouPlaybackReport({
          agentInstanceId: '20000000-0000-4000-8000-000000000002',
          sequence: 0,
          title: 'Song C',
        }),
      );
      assert.equal(restarted.response.status, 200);
      assert.equal(restarted.body.accepted, true);
      assert.equal(eventQueue.reserveNext({ deviceId: 'pc-mumu' }), null);
    },
    { kugouBridge: bridge, kugouEventQueue: eventQueue, kugouAgentApi: agentApi },
  );
});

test('keeps accepted Agent status available when the event layer fails', async () => {
  const eventErrors = [];
  const eventQueue = new KugouEventQueue();
  const bridge = new KugouBridge({
    eventAdapter: {
      accept() {
        throw new Error('sensitive event details must not reach the response');
      },
    },
    eventQueue,
    onEventError(error, context) {
      eventErrors.push({ classification: error.name, context });
    },
  });
  const agentApi = createKugouAgentApi({ bridge, token: DEVICE_TOKEN });

  await withServer(
    async ({ baseUrl }) => {
      const uploaded = await uploadKugouStatus(
        baseUrl,
        kugouPlaybackReport({ sequence: 1, title: 'Private Song' }),
      );
      assert.equal(uploaded.response.status, 200);
      assert.deepEqual(
        { ok: uploaded.body.ok, accepted: uploaded.body.accepted },
        { ok: true, accepted: true },
      );
      assert.equal(JSON.stringify(uploaded.body).includes('sensitive'), false);
      assert.equal(bridge.getStatus().player.title, 'Private Song');
      assert.equal(eventQueue.size(), 0);
      assert.equal(eventErrors.length, 1);
      assert.deepEqual(eventErrors[0], {
        classification: 'Error',
        context: {
          phase: 'adapter',
          deviceId: 'pc-mumu',
          agentInstanceId: '10000000-0000-4000-8000-000000000001',
          sequence: 1,
        },
      });
      assert.equal(JSON.stringify(eventErrors[0].context).includes('Private Song'), false);
      assert.equal(JSON.stringify(eventErrors[0].context).includes(DEVICE_TOKEN), false);
    },
    { kugouBridge: bridge, kugouEventQueue: eventQueue, kugouAgentApi: agentApi },
  );
});

test('integrates the device API, scoped REST routes and scoped MCP tools', async () => {
  let now = Date.parse('2026-09-27T12:00:00.000Z');
  let commandCounter = 0;
  const bridge = new KugouBridge({
    controlEnabled: true,
    devices: [
      {
        deviceId: 'pc-mumu',
        deviceName: 'Lucy-PC-MuMu',
        deviceType: 'windows_mumu',
      },
      {
        deviceId: 'phone',
        deviceName: 'Lucy-Phone',
        deviceType: 'android',
      },
    ],
    activeDeviceId: 'pc-mumu',
    now: () => now,
    uuid: () =>
      `00000000-0000-4000-8000-${String(++commandCounter).padStart(12, '0')}`,
  });
  const agentApi = createKugouAgentApi({
    bridge,
    devices: [
      {
        deviceId: 'pc-mumu',
        deviceName: 'Lucy-PC-MuMu',
        deviceType: 'windows_mumu',
        token: DEVICE_TOKEN,
      },
      {
        deviceId: 'phone',
        deviceName: 'Lucy-Phone',
        deviceType: 'android',
        token: PHONE_DEVICE_TOKEN,
      },
    ],
  });

  await withServer(
    async ({ baseUrl, store, errors }) => {
      const owner = await store.createOwner('kugou_owner', 'a sufficiently long password');
      const musicToken = await store.createPersonalAccessToken(owner.id, {
        label: 'music reader',
        scopes: ['music:read'],
        resource: RESOURCE,
      });
      const controlToken = await store.createPersonalAccessToken(owner.id, {
        label: 'player controller',
        scopes: ['player:control'],
        resource: RESOURCE,
      });
      const fullToken = await store.createPersonalAccessToken(owner.id, {
        label: 'mcp device controller',
        scopes: ['music:read', 'player:control'],
        resource: RESOURCE,
      });

      const report = {
        protocol_version: 1,
        agent_instance_id: '10000000-0000-4000-8000-000000000001',
        sequence: 1,
        observed_at: '2026-09-27T12:00:00.000Z',
        health: 'ok',
        capabilities: ['status', 'toggle', 'next', 'previous'],
        player: {
          package: 'com.kugou.android.lite',
          playback_state: 'playing',
          state_code: 3,
          title: '云端测试歌曲',
          artist: '测试歌手',
          album: '测试专辑',
          position_ms: 5_000,
        },
      };
      const uploaded = await fetch(`${baseUrl}/agent/v1/status`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${DEVICE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(report),
      });
      assert.equal(uploaded.status, 200);
      assert.equal(uploaded.headers.get('access-control-allow-origin'), null);

      const statusResponse = await fetch(`${baseUrl}/api/v1/kugou/status`, {
        headers: { authorization: `Bearer ${musicToken.token}` },
      });
      assert.equal(statusResponse.status, 200);
      const activeStatus = await statusResponse.json();
      assert.equal(activeStatus.device_id, 'pc-mumu');
      assert.equal(activeStatus.device_name, 'Lucy-PC-MuMu');
      assert.equal(activeStatus.device_type, 'windows_mumu');
      assert.equal(activeStatus.active, true);
      assert.equal(activeStatus.player.title, '云端测试歌曲');
      assert.equal(bridge.getStatus('phone').online, false);
      assert.equal(bridge.getStatus('phone').reason, 'never_seen');

      const deviceTokenOnUserApi = await fetch(`${baseUrl}/api/v1/kugou/status`, {
        headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
      });
      assert.equal(deviceTokenOnUserApi.status, 401);

      const forbiddenControl = await fetch(`${baseUrl}/api/v1/kugou/control`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${musicToken.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'next' }),
      });
      assert.equal(forbiddenControl.status, 403);

      const acceptedControl = await fetch(`${baseUrl}/api/v1/kugou/control`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${controlToken.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'next' }),
      });
      assert.equal(acceptedControl.status, 202);
      const acceptedControlBody = await acceptedControl.json();
      assert.equal(acceptedControlBody.device_id, 'pc-mumu');
      assert.equal(acceptedControlBody.action, 'next');
      assert.equal(bridge.claimCommand('phone'), null);

      const openapi = await (await fetch(`${baseUrl}/openapi.json`)).json();
      assert.ok(openapi.paths['/kugou/status']);
      assert.ok(openapi.paths['/kugou/control']);

      const listResponse = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${fullToken.token}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      });
      assert.equal(listResponse.status, 200);
      const listed = await readMcpResponse(listResponse);
      const kugouStatusTool = listed.result.tools.find(
        (tool) => tool.name === 'kugou_status',
      );
      const kugouControlTool = listed.result.tools.find(
        (tool) => tool.name === 'kugou_control',
      );
      const neteaseSearchTool = listed.result.tools.find(
        (tool) => tool.name === 'netease_search',
      );
      assert.deepEqual(kugouStatusTool?.securitySchemes, [
        { type: 'oauth2', scopes: ['music:read'] },
      ]);
      assert.deepEqual(kugouStatusTool?._meta?.securitySchemes, [
        { type: 'oauth2', scopes: ['music:read'] },
      ]);
      assert.deepEqual(kugouControlTool?.securitySchemes, [
        { type: 'oauth2', scopes: ['music:read', 'player:control'] },
      ]);
      assert.deepEqual(kugouControlTool?._meta?.securitySchemes, [
        { type: 'oauth2', scopes: ['music:read', 'player:control'] },
      ]);
      assert.ok(neteaseSearchTool);
      assert.equal(Object.hasOwn(neteaseSearchTool, 'securitySchemes'), false);
      assert.equal(listed.result.tools.some((tool) => tool.name === 'kugou_wait'), false);
      assert.equal(listed.result.tools.some((tool) => tool.name === 'kugou_wait_ack'), false);

      const mcpStatusResponse = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${musicToken.token}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'kugou_status', arguments: {} },
        }),
      });
      assert.equal(mcpStatusResponse.status, 200);
      const mcpStatus = await readMcpResponse(mcpStatusResponse);
      assert.equal(mcpStatus.result.isError, undefined);
      const mcpDeviceStatus = JSON.parse(mcpStatus.result.content[0].text);
      assert.equal(mcpDeviceStatus.device_id, 'pc-mumu');
      assert.equal(mcpDeviceStatus.active, true);
      assert.equal(mcpDeviceStatus.player.title, '云端测试歌曲');

      const scopedCall = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${musicToken.token}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'kugou_control', arguments: { action: 'previous' } },
        }),
      });
      assert.equal(scopedCall.status, 200);
      const denied = await readMcpResponse(scopedCall);
      assert.equal(denied.result.isError, true);
      assert.match(denied.result.content[0].text, /player:control/);
      const challenges = denied.result._meta?.['mcp/www_authenticate'];
      assert.equal(challenges?.length, 1);
      const challenge = challenges[0];
      assert.match(challenge, /^Bearer /);
      assert.match(challenge, /error="insufficient_scope"/);
      assert.match(challenge, /error_description="Required scope missing: player:control"/);
      assert.match(challenge, /scope="music:read player:control"/);
      assert.match(
        challenge,
        /resource_metadata="http:\/\/127\.0\.0\.1\/\.well-known\/oauth-protected-resource\/mcp"/,
      );
      const errorDescription = challenge.match(/error_description="([^"]+)"/)?.[1];
      assert.match(errorDescription, /^[\x20-\x7e]+$/);
      assert.equal(commandCounter, 1);

      const authorizedCall = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${fullToken.token}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'kugou_control', arguments: { action: 'previous' } },
        }),
      });
      assert.equal(authorizedCall.status, 200);
      const accepted = await readMcpResponse(authorizedCall);
      assert.equal(accepted.result.isError, undefined);
      const acceptedMcpCommand = JSON.parse(accepted.result.content[0].text);
      assert.equal(acceptedMcpCommand.device_id, 'pc-mumu');
      assert.equal(acceptedMcpCommand.action, 'previous');
      assert.equal(commandCounter, 2);
      assert.deepEqual(errors, []);
      now += 1;
    },
    { kugouBridge: bridge, kugouAgentApi: agentApi },
  );
});

test('keeps status enabled but rejects command creation when control is disabled', async () => {
  const bridge = new KugouBridge({ controlEnabled: false });
  await withServer(
    async ({ baseUrl, store }) => {
      const owner = await store.createOwner('status_only', 'a sufficiently long password');
      const token = await store.createPersonalAccessToken(owner.id, {
        label: 'status and control scopes',
        scopes: ['music:read', 'player:control'],
        resource: RESOURCE,
      });
      const response = await fetch(`${baseUrl}/api/v1/kugou/control`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'toggle' }),
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, '酷狗设备控制当前未启用。');
    },
    { kugouBridge: bridge },
  );
});

test('lists event tools with schemas, write annotations and read scopes over JSON and SSE', async () => {
  await withServer(async ({ baseUrl, store, errors }) => {
    const token = await eventAccessToken(store);
    for (const modern of [false, true]) {
      const { response, result } = await postEventMcp(baseUrl, token, 'tools/list', {}, { modern });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), modern ? /application\/json/ : /text\/event-stream/);
      const tools = result.tools.filter((tool) => tool.name.startsWith('kugou_'));
      assert.deepEqual(tools.map((tool) => tool.name), [
        'kugou_status', 'kugou_control', 'kugou_wait', 'kugou_wait_ack',
      ]);
      for (const tool of tools.slice(2)) {
        assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['music:read'] }]);
        assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
        assert.equal(tool.annotations.readOnlyHint, false);
        assert.equal(tool.annotations.destructiveHint, false);
        assert.equal(tool.annotations.openWorldHint, false);
        assert.ok(tool.outputSchema);
        assert.equal(tool.inputSchema.additionalProperties, false);
      }
      const wait = tools[2];
      assert.deepEqual(wait.inputSchema.properties.timeout_ms, {
        default: 30_000, type: 'integer', minimum: 1, maximum: 45_000,
      });
      assert.equal(wait.inputSchema.required?.includes('timeout_ms') ?? false, false);
      assert.equal(wait.annotations.idempotentHint, false);
      assert.deepEqual(tools[3].inputSchema.required, ['eventId', 'receiptToken']);
      assert.equal(tools[3].annotations.idempotentHint, true);
    }
    assert.deepEqual(errors, []);
  }, eventServerOptions());
});

test('does not register event tools when only the Queue is injected', async () => {
  await withServer(async ({ baseUrl, store }) => {
    const token = await eventAccessToken(store);
    const { result } = await postEventMcp(baseUrl, token, 'tools/list', {});
    assert.equal(result.tools.length, 16);
    assert.equal(result.tools.some((tool) => tool.name.startsWith('kugou_')), false);
  }, { kugouEventQueue: new KugouEventQueue() });
});

for (const modern of [false, true]) {
  test(`delivers Agent track changes through MCP and requires explicit ACK (${modern ? 'JSON' : 'SSE'})`, async (t) => {
    const options = eventServerOptions();
    const waits = observeEventWaits(t, options.kugouEventQueue);
    const logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args));
    await withServer(async ({ baseUrl, store, errors }) => {
      const token = await eventAccessToken(store);
      assert.equal((await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 1, title: 'Song A' }))).body.accepted, true);
      assert.equal(options.kugouEventQueue.size(), 0);
      const waiting = callEventMcp(baseUrl, token, 'kugou_wait', { timeout_ms: 5_000 }, { modern });
      const call = await waits.next();
      assert.equal(call.options.deviceId, 'pc-mumu');
      assert.equal(call.options.timeoutMs, 5_000);
      assert.ok(call.options.signal instanceof AbortSignal);
      assert.equal(call.options.signal.aborted, false);
      assert.equal((await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 2, title: 'Song B' }))).body.accepted, true);

      const { response, result } = await waiting;
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), modern ? /application\/json/ : /text\/event-stream/);
      assert.equal(result.isError, undefined);
      const data = result.structuredContent;
      assert.equal(data.outcome, 'event');
      const raw = (await call.promise).event;
      assert.deepEqual(data.event, {
        id: raw.id,
        eventType: 'track_changed',
        device: { deviceId: 'pc-mumu', deviceName: 'Lucy-PC-MuMu', deviceType: 'windows_mumu' },
        previous: { track: { title: 'Song A', artist: 'Test Artist', album: 'Test Album' } },
        current: { track: { title: 'Song B', artist: 'Test Artist', album: 'Test Album' } },
        createdAt: raw.createdAt,
        observedAt: '2026-09-27T12:00:02.000Z',
      });
      assert.equal(data.reservation.receiptToken, (await call.promise).receiptToken);
      assert.equal(Number.isFinite(data.reservation.leaseExpiresAt), true);
      assert.equal(options.kugouEventQueue.getState().reserved.length, 1);
      assert.equal(options.kugouEventQueue.getState().delivered.length, 0);
      for (const secret of [
        raw.previous.track.identity, raw.current.track.identity,
        raw.cursor.agentInstanceId, token, DEVICE_TOKEN,
        'stateKey', 'cursor', 'identity', 'position_ms', 'capabilities', 'agent_instance_id',
      ]) {
        assert.equal(JSON.stringify(result).includes(secret), false);
      }
      assert.equal(result.content[0].text.includes(data.reservation.receiptToken), false);
      const beforeAck = options.kugouBridge.getStatus();
      const ack = await ackMcpEvent(baseUrl, token, data, { modern });
      assert.deepEqual(ack.result.structuredContent, {
        outcome: 'acknowledged', eventId: data.event.id,
        acknowledged: true, alreadyAcknowledged: false,
      });
      assert.equal(ack.result.isError, undefined);
      assert.equal(options.kugouEventQueue.getState().delivered.length, 1);
      assert.deepEqual(options.kugouBridge.getStatus().player, beforeAck.player);
      assert.equal(options.kugouBridge.claimCommand('pc-mumu'), null);
      const duplicate = await ackMcpEvent(baseUrl, token, data, { modern });
      assert.equal(duplicate.result.structuredContent.alreadyAcknowledged, true);
      assert.equal(duplicate.result.isError, undefined);
      const empty = await callEventMcp(baseUrl, token, 'kugou_wait', { timeout_ms: 1 }, { modern });
      assert.deepEqual(empty.result.structuredContent, { outcome: 'timeout' });
      assert.equal(empty.result.isError, undefined);
      assert.deepEqual(errors, []);
      assert.deepEqual(logs, []);
    }, options);
  });
}

test('keeps playback events tied to their own state snapshots, without later song metadata', async () => {
  const options = eventServerOptions();
  await withServer(async ({ baseUrl, store, errors }) => {
    const token = await eventAccessToken(store);
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 1, title: 'Song A' }));
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 2, title: 'Song A', playbackState: 'paused' }));
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 3, title: 'Song B', playbackState: 'paused' }));
    assert.equal(options.kugouBridge.getStatus().player.title, 'Song B');
    const paused = (await callEventMcp(baseUrl, token, 'kugou_wait', { timeout_ms: 5_000 })).result.structuredContent;
    assert.equal(paused.event.eventType, 'playback_paused');
    assert.deepEqual(paused.event.previous, { playbackState: 'playing' });
    assert.deepEqual(paused.event.current, { playbackState: 'paused' });
    assert.equal(JSON.stringify(paused.event).includes('Song'), false);
    await ackMcpEvent(baseUrl, token, paused);
    const track = (await callEventMcp(baseUrl, token, 'kugou_wait', {})).result.structuredContent;
    assert.equal(track.event.eventType, 'track_changed');
    await ackMcpEvent(baseUrl, token, track);
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 4, title: 'Song B' }));
    const resumed = (await callEventMcp(baseUrl, token, 'kugou_wait', {})).result.structuredContent;
    assert.equal(resumed.event.eventType, 'playback_resumed');
    assert.deepEqual(resumed.event.previous, { playbackState: 'paused' });
    assert.deepEqual(resumed.event.current, { playbackState: 'playing' });
    assert.equal(JSON.stringify(resumed.event).includes('Song'), false);
    await ackMcpEvent(baseUrl, token, resumed);
    assert.deepEqual(errors, []);
  }, options);
});

test('returns structured parameter errors and honors the default and timeout bounds', async (t) => {
  const options = eventServerOptions();
  const waits = observeEventWaits(t, options.kugouEventQueue);
  const ack = t.mock.method(options.kugouEventQueue, 'ack');
  await withServer(async ({ baseUrl, store, errors }) => {
    const token = await eventAccessToken(store);
    for (const args of [
      { timeout_ms: 0 }, { timeout_ms: -1 }, { timeout_ms: 45_001 },
      { timeout_ms: 1.5 }, { timeout_ms: '5000' }, { timeout_ms: null }, { extra: token },
    ]) {
      const { result } = await callEventMcp(baseUrl, token, 'kugou_wait', args);
      assertEventError(result, 'invalid_params');
      assert.equal(JSON.stringify(result).includes(token), false);
    }
    for (const args of [
      {}, { eventId: '', receiptToken: 'x' }, { eventId: 'x' },
      { eventId: 'x', receiptToken: 1 }, { eventId: 'x', receiptToken: 'x', extra: token },
    ]) {
      assertEventError((await callEventMcp(baseUrl, token, 'kugou_wait_ack', args)).result, 'invalid_params');
    }
    assert.equal(waits.calls.length, 0);
    assert.equal(ack.mock.callCount(), 0);
    const timeout = await callEventMcp(baseUrl, token, 'kugou_wait', { timeout_ms: 1 });
    assert.deepEqual(timeout.result.structuredContent, { outcome: 'timeout' });
    assert.equal(timeout.result.isError, undefined);
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 1, title: 'Song A' }));
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 2, title: 'Song B' }));
    const defaultWait = (await callEventMcp(baseUrl, token, 'kugou_wait')).result.structuredContent;
    assert.equal(defaultWait.outcome, 'event');
    assert.equal(waits.calls[1].options.timeoutMs, 30_000);
    options.kugouEventQueue.release(defaultWait.event.id, defaultWait.reservation.receiptToken);
    const maxWait = (await callEventMcp(baseUrl, token, 'kugou_wait', { timeout_ms: 45_000 })).result.structuredContent;
    assert.equal(maxWait.outcome, 'event');
    assert.equal(waits.calls[2].options.timeoutMs, 45_000);
    await ackMcpEvent(baseUrl, token, maxWait);
    assert.deepEqual(errors, []);
  }, options);
});

for (const modern of [false, true]) {
  test(`HTTP disconnect aborts the actual SDK signal and permits immediate re-wait (${modern ? 'JSON' : 'SSE'})`, { timeout: 5_000 }, async (t) => {
    const options = eventServerOptions();
    const waits = observeEventWaits(t, options.kugouEventQueue);
    const contexts = [];
    const registerTool = McpServer.prototype.registerTool;
    t.mock.method(McpServer.prototype, 'registerTool', function(name, config, callback) {
      return registerTool.call(this, name, config, name === 'kugou_wait' ? (args, ctx) => {
        contexts.push(ctx);
        return callback(args, ctx);
      } : callback);
    });
    await withServer(async ({ baseUrl, store, errors, instance }) => {
      const token = await eventAccessToken(store);
      await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 1, title: 'Song A' }));
      let exchange;
      const closed = deferred();
      instance.httpServer.once('request', (request, response) => {
        exchange = { request, response };
        response.once('close', closed.resolve);
      });
      const pending = beginEventWait(baseUrl, token, { timeout_ms: 5_000 }, modern);
      try {
        const first = await waits.next();
        assert.equal(first.options.signal, contexts[0].mcpReq.signal);
        assert.equal(contexts[0].http.req.signal.aborted, false);
        assert.equal(exchange.request.complete, true);
        pending.request.destroy();
        assert.ok((await pending.settled) instanceof Error);
        await closed.promise;
        await assert.rejects(first.promise, { name: 'AbortError' });
        assert.equal(contexts[0].http.req.signal.aborted, true);
        assert.equal(first.options.signal.aborted, true);
        assert.equal(exchange.response.writableFinished, false);
        assert.equal(options.kugouEventQueue.size(), 0);

        const replacement = callEventMcp(baseUrl, token, 'kugou_wait', { timeout_ms: 5_000 }, { modern });
        const second = await waits.next(1);
        assert.notEqual(second.options.signal, first.options.signal);
        assert.equal(second.options.signal.aborted, false);
        await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 2, title: 'Song B' }));
        const result = (await replacement).result;
        assert.equal(result.isError, undefined);
        assert.equal(result.structuredContent.event.current.track.title, 'Song B');
        await ackMcpEvent(baseUrl, token, result.structuredContent, { modern });
        assert.deepEqual(errors, []);
      } finally {
        pending.request.destroy();
      }
    }, options);
  });
}

test('returns waiter_busy for a concurrent MCP wait without disturbing the first', { timeout: 5_000 }, async (t) => {
  const options = eventServerOptions();
  const waits = observeEventWaits(t, options.kugouEventQueue);
  await withServer(async ({ baseUrl, store, errors }) => {
    const token = await eventAccessToken(store);
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 1, title: 'Song A' }));
    const first = callEventMcp(baseUrl, token, 'kugou_wait', { timeout_ms: 5_000 });
    const call = await waits.next();
    const second = await callEventMcp(baseUrl, token, 'kugou_wait', { timeout_ms: 5_000 }, { modern: true });
    assert.equal(second.response.status, 200);
    assertEventError(second.result, 'waiter_busy');
    assert.equal(call.options.signal.aborted, false);
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 2, title: 'Song B' }));
    const data = (await first).result.structuredContent;
    assert.equal(data.event.current.track.title, 'Song B');
    await ackMcpEvent(baseUrl, token, data);
    const later = await callEventMcp(baseUrl, token, 'kugou_wait', { timeout_ms: 1 });
    assert.deepEqual(later.result.structuredContent, { outcome: 'timeout' });
    assert.deepEqual(errors, []);
  }, options);
});

test('releases the exact reservation when HTTP cancellation precedes tool delivery', { timeout: 5_000 }, async (t) => {
  const options = eventServerOptions();
  const queue = options.kugouEventQueue;
  const originalWait = queue.waitNext.bind(queue);
  const reserved = deferred();
  const deliver = deferred();
  const aborted = deferred();
  t.mock.method(queue, 'waitNext', async (args) => {
    args.signal.addEventListener('abort', aborted.resolve, { once: true });
    const reservation = await originalWait(args);
    reserved.resolve(reservation);
    await deliver.promise;
    return reservation;
  });
  const released = deferred();
  const originalRelease = queue.release.bind(queue);
  const release = t.mock.method(queue, 'release', (...args) => {
    const result = originalRelease(...args);
    released.resolve(result);
    return result;
  });
  const ack = t.mock.method(queue, 'ack');
  await withServer(async ({ baseUrl, store, errors }) => {
    const token = await eventAccessToken(store);
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 1, title: 'Song A' }));
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 2, title: 'Song B' }));
    const pending = beginEventWait(baseUrl, token, { timeout_ms: 5_000 });
    try {
      const reservation = await reserved.promise;
      assert.equal(queue.getState().reserved.length, 1);
      pending.request.destroy();
      await pending.settled;
      await aborted.promise;
      deliver.resolve();
      assert.equal((await released.promise).released, true);
      assert.equal(release.mock.callCount(), 1);
      assert.deepEqual(release.mock.calls[0].arguments, [reservation.event.id, reservation.receiptToken]);
      assert.equal(ack.mock.callCount(), 0);
      assert.equal(queue.getState().pending[0].id, reservation.event.id);
      const replacement = (await callEventMcp(baseUrl, token, 'kugou_wait', {})).result.structuredContent;
      assert.equal(replacement.event.id, reservation.event.id);
      assert.notEqual(replacement.reservation.receiptToken, reservation.receiptToken);
      await ackMcpEvent(baseUrl, token, replacement);
      assert.equal(release.mock.callCount(), 1);
      assert.deepEqual(errors, []);
    } finally {
      deliver.resolve();
      pending.request.destroy();
    }
  }, options);
});

test('preserves ACK failure codes and redelivers after the default 60-second lease with a new token', async () => {
  let now = Date.parse('2026-10-03T00:00:00.000Z');
  const options = eventServerOptions({
    eventQueue: new KugouEventQueue({ now: () => now }),
    now: () => now,
  });
  await withServer(async ({ baseUrl, store, errors }) => {
    const token = await eventAccessToken(store);
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 1, title: 'Song A' }));
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 2, title: 'Song B' }));
    const eventId = options.kugouEventQueue.getState().pending[0].id;
    const ack = (receiptToken, id = eventId) => callEventMcp(baseUrl, token, 'kugou_wait_ack', { eventId: id, receiptToken });
    assertEventError((await ack('not-a-reservation')).result, 'invalid_state');
    assertEventError((await ack('not-a-reservation', 'unknown-event')).result, 'unknown_event');
    const first = (await callEventMcp(baseUrl, token, 'kugou_wait', {})).result.structuredContent;
    assert.equal(first.reservation.leaseExpiresAt, now + 60_000);
    assertEventError((await ack('')).result, 'reservation_required');
    assertEventError((await ack(first.reservation.receiptToken.split(':')[0])).result, 'stale_reservation');
    now = first.reservation.leaseExpiresAt;
    assertEventError((await ack(first.reservation.receiptToken)).result, 'stale_reservation');
    const second = (await callEventMcp(baseUrl, token, 'kugou_wait', {})).result.structuredContent;
    assert.equal(second.event.id, first.event.id);
    assert.notEqual(second.reservation.receiptToken, first.reservation.receiptToken);
    assertEventError((await ack(first.reservation.receiptToken)).result, 'stale_reservation');
    assert.equal(options.kugouEventQueue.getState().reserved.length, 1);
    assert.equal((await ack(second.reservation.receiptToken)).result.structuredContent.alreadyAcknowledged, false);
    assert.equal((await ack(second.reservation.receiptToken)).result.structuredContent.alreadyAcknowledged, true);
    assertEventError((await ack(first.reservation.receiptToken)).result, 'stale_reservation');
    assert.deepEqual(errors, []);
  }, options);
});

test('a disconnect after the event response starts leaves the reservation recoverable by lease', { timeout: 5_000 }, async (t) => {
  let now = Date.parse('2026-10-03T00:00:00.000Z');
  const options = eventServerOptions({ eventQueue: new KugouEventQueue({ now: () => now }) });
  const waits = observeEventWaits(t, options.kugouEventQueue);
  const release = t.mock.method(options.kugouEventQueue, 'release');
  const ack = t.mock.method(options.kugouEventQueue, 'ack');
  await withServer(async ({ baseUrl, store, errors }) => {
    const token = await eventAccessToken(store);
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 1, title: 'Song A' }));
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 2, title: 'Song B' }));
    const disconnected = deferred();
    const request = httpRequest(new URL('/mcp', baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
    });
    request.on('error', () => {});
    request.on('response', (response) => {
      let prefix = '';
      response.on('error', () => {});
      response.on('readable', () => {
        let byte;
        while ((byte = response.read(1)) !== null) {
          prefix += byte.toString('utf8');
          if (prefix.endsWith('data: ')) {
            // The event frame has begun, but this client never consumes its JSON.
            response.destroy();
            request.destroy();
            disconnected.resolve(prefix);
            break;
          }
        }
      });
    });
    request.end(eventMcpMessage('tools/call', {
      name: 'kugou_wait', arguments: { timeout_ms: 5_000 },
    }));
    try {
      assert.match(await disconnected.promise, /data: $/);
      const reservation = await (await waits.next()).promise;
      assert.equal(options.kugouEventQueue.getState().reserved[0].id, reservation.event.id);
      assert.equal(release.mock.callCount(), 0);
      assert.equal(ack.mock.callCount(), 0);
      now = reservation.leaseExpiresAt;
      const stale = await callEventMcp(baseUrl, token, 'kugou_wait_ack', {
        eventId: reservation.event.id, receiptToken: reservation.receiptToken,
      });
      assertEventError(stale.result, 'stale_reservation');
      const recovered = (await callEventMcp(baseUrl, token, 'kugou_wait', {})).result.structuredContent;
      assert.equal(recovered.event.id, reservation.event.id);
      assert.notEqual(recovered.reservation.receiptToken, reservation.receiptToken);
      await ackMcpEvent(baseUrl, token, recovered);
      assert.equal(release.mock.callCount(), 0);
      assert.deepEqual(errors, []);
    } finally {
      request.destroy();
    }
  }, options);
});

test('filters by the active device captured at call start using the shared Agent Queue', { timeout: 5_000 }, async (t) => {
  const devices = [
    { deviceId: 'pc-mumu', deviceName: 'Lucy-PC-MuMu', deviceType: 'windows_mumu' },
    { deviceId: 'phone', deviceName: 'Lucy-Phone', deviceType: 'android' },
  ];
  const options = eventServerOptions({ devices });
  options.kugouAgentApi = createKugouAgentApi({
    bridge: options.kugouBridge,
    devices: devices.map((device, index) => ({ ...device, token: index ? PHONE_DEVICE_TOKEN : DEVICE_TOKEN })),
  });
  const waits = observeEventWaits(t, options.kugouEventQueue);
  await withServer(async ({ baseUrl, store, errors }) => {
    const token = await eventAccessToken(store);
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 1, title: 'Song A' }));
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 1, title: 'Phone A' }), PHONE_DEVICE_TOKEN);
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 2, title: 'Phone B' }), PHONE_DEVICE_TOKEN);
    const waiting = callEventMcp(baseUrl, token, 'kugou_wait', { timeout_ms: 5_000 });
    const call = await waits.next();
    assert.equal(call.options.deviceId, 'pc-mumu');
    assert.equal(options.kugouEventQueue.getState().pending[0].device.deviceId, 'phone');
    options.kugouBridge.activeDeviceId = 'phone';
    await uploadKugouStatus(baseUrl, kugouPlaybackReport({ sequence: 2, title: 'Song B' }));
    const pc = (await waiting).result.structuredContent;
    assert.equal(pc.event.device.deviceId, 'pc-mumu');
    await ackMcpEvent(baseUrl, token, pc);
    const phone = (await callEventMcp(baseUrl, token, 'kugou_wait', {})).result.structuredContent;
    assert.equal(phone.event.device.deviceId, 'phone');
    assert.equal(phone.event.current.track.title, 'Phone B');
    await ackMcpEvent(baseUrl, token, phone);
    assert.deepEqual(errors, []);
  }, options);
});

test('enforces entry Bearer authentication and read scope for both event tools', async (t) => {
  const options = eventServerOptions();
  const wait = t.mock.method(options.kugouEventQueue, 'waitNext');
  const ack = t.mock.method(options.kugouEventQueue, 'ack');
  await withServer(async ({ baseUrl, store, errors }) => {
    const token = await eventAccessToken(store, ['playlist:read']);
    for (const name of ['kugou_wait', 'kugou_wait_ack']) {
      const args = name === 'kugou_wait' ? { timeout_ms: 1 } : { eventId: 'x', receiptToken: 'x' };
      for (const unauthorizedToken of [null, DEVICE_TOKEN]) {
        const denied = await callEventMcp(baseUrl, unauthorizedToken, name, args);
        assertBearerFailure(denied.response, denied.payload);
        assert.equal(JSON.stringify(denied.payload).includes(DEVICE_TOKEN), false);
      }
      const forbidden = await callEventMcp(baseUrl, token, name, args);
      assertBearerFailure(forbidden.response, forbidden.payload, 403);
    }
    assert.equal(wait.mock.callCount(), 0);
    assert.equal(ack.mock.callCount(), 0);
    assert.deepEqual(errors, []);
  }, options);
});

test('retains handler-level read scope checks even when the HTTP entry gate is bypassed', async (t) => {
  const options = eventServerOptions();
  const wait = t.mock.method(options.kugouEventQueue, 'waitNext');
  const ack = t.mock.method(options.kugouEventQueue, 'ack');
  const handler = createMcpHandler(() => createNeteaseMcpServer({
    ...options,
    authInfo: { scopes: ['playlist:read'] },
    resourceMetadataUrl: `${CANONICAL_ORIGIN}/.well-known/oauth-protected-resource/mcp`,
  }), { legacy: 'stateless' });
  try {
    for (const name of ['kugou_wait', 'kugou_wait_ack']) {
      const params = { name, arguments: name === 'kugou_wait' ? { timeout_ms: 1 } : { eventId: 'x', receiptToken: 'x' } };
      const response = await handler.fetch(new Request(RESOURCE, {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        body: eventMcpMessage('tools/call', params),
      }));
      const result = (await readMcpResponse(response)).result;
      assertEventError(result, 'insufficient_scope');
      assert.match(result._meta['mcp/www_authenticate'][0], /scope="music:read"/);
    }
    assert.equal(wait.mock.callCount(), 0);
    assert.equal(ack.mock.callCount(), 0);
  } finally {
    await handler.close();
  }
});

test('sanitizes event tool exceptions and recognizes busy errors only by their code', async (t) => {
  const options = eventServerOptions();
  await withServer(async ({ baseUrl, store, errors }) => {
    const token = await eventAccessToken(store);
    const sensitiveMessage = `private stack and receipt details ${token} ${DEVICE_TOKEN}`;
    t.mock.method(options.kugouEventQueue, 'waitNext', () => {
      const error = new Error(sensitiveMessage);
      error.code = 'waiter_busy';
      throw error;
    });
    const busy = (await callEventMcp(baseUrl, token, 'kugou_wait', { timeout_ms: 1 })).result;
    assertEventError(busy, 'waiter_busy');
    t.mock.method(options.kugouEventQueue, 'waitNext', () => {
      // Matching the old message without its code must not classify this as busy.
      throw new Error('KugouEventQueue already has an active waiter.');
    });
    assertEventError((await callEventMcp(baseUrl, token, 'kugou_wait', { timeout_ms: 1 })).result, 'internal_error');
    t.mock.method(options.kugouEventQueue, 'ack', () => { throw new Error(sensitiveMessage); });
    const failedAck = (await callEventMcp(baseUrl, token, 'kugou_wait_ack', { eventId: 'x', receiptToken: 'x' })).result;
    assertEventError(failedAck, 'internal_error');
    for (const result of [busy, failedAck]) {
      assert.equal(JSON.stringify(result).includes(token), false);
      assert.equal(JSON.stringify(result).includes(DEVICE_TOKEN), false);
      assert.equal(JSON.stringify(result).includes('stack'), false);
    }
    assert.deepEqual(errors, []);
  }, options);
});
