import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PersonalAuthStore, parseMasterKey } from '../src/personal-store.js';
import { createPersonalNeteaseServer, PERSONAL_SCOPES } from '../src/personal-server.js';
import { KugouBridge } from '../src/kugou-bridge.js';
import { createKugouAgentApi } from '../src/kugou-agent-api.js';

const CANONICAL_ORIGIN = 'http://127.0.0.1';
const RESOURCE = `${CANONICAL_ORIGIN}/mcp`;
const DEVICE_TOKEN = 'd'.repeat(64);

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
    });
  } finally {
    await instance.close();
  }
}

async function readMcpResponse(response) {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    return JSON.parse(data);
  }
  return JSON.parse(text);
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
    const challenge = unauthorized.headers.get('www-authenticate');
    assert.match(challenge, /oauth-protected-resource\/mcp/);
    assert.match(challenge, /music:read/);
    assert.doesNotMatch(challenge, /playlist:read|playlist:write/);
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
    assert.deepEqual(errors, []);
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

test('integrates the device API, scoped REST routes and scoped MCP tools', async () => {
  let now = Date.parse('2026-09-27T12:00:00.000Z');
  let commandCounter = 0;
  const bridge = new KugouBridge({
    controlEnabled: true,
    now: () => now,
    uuid: () =>
      `00000000-0000-4000-8000-${String(++commandCounter).padStart(12, '0')}`,
  });
  const agentApi = createKugouAgentApi({ bridge, token: DEVICE_TOKEN });

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
      assert.equal((await statusResponse.json()).player.title, '云端测试歌曲');

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
      assert.equal((await acceptedControl.json()).action, 'next');

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
      assert.ok(listed.result.tools.some((tool) => tool.name === 'kugou_status'));
      assert.ok(listed.result.tools.some((tool) => tool.name === 'kugou_control'));

      const scopedCall = await fetch(`${baseUrl}/mcp`, {
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
          params: { name: 'kugou_control', arguments: { action: 'previous' } },
        }),
      });
      assert.equal(scopedCall.status, 200);
      const denied = await readMcpResponse(scopedCall);
      assert.equal(denied.result.isError, true);
      assert.match(denied.result.content[0].text, /player:control/);
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
