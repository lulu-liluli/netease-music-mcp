import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KugouBridge } from '../src/kugou-bridge.js';
import {
  createKugouAgentApi,
  readKugouDeviceToken,
} from '../src/kugou-agent-api.js';

const TOKEN = 'a'.repeat(64);
const PHONE_TOKEN = 'b'.repeat(64);
const COMMAND_ID = '00000000-0000-4000-8000-000000000001';
const PHONE_COMMAND_ID = '00000000-0000-4000-8000-000000000002';
const DEVICES = [
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
];

function validStatus(overrides = {}) {
  return {
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
      title: '中文歌名',
      artist: '歌手',
      album: '专辑',
      position_ms: 1_234,
    },
    ...overrides,
  };
}

function setup({ controlEnabled = true, maxBodyBytes } = {}) {
  let now = Date.parse('2026-09-27T12:00:00.000Z');
  const bridge = new KugouBridge({
    controlEnabled,
    now: () => now,
    uuid: () => COMMAND_ID,
  });
  const errors = [];
  const api = createKugouAgentApi({
    bridge,
    token: TOKEN,
    maxBodyBytes,
    onError: (error) => errors.push(error),
  });
  return { bridge, api, errors, advance: (value) => (now += value) };
}

function setupMultiple() {
  let idIndex = 0;
  const commandIds = [COMMAND_ID, PHONE_COMMAND_ID];
  const bridge = new KugouBridge({
    controlEnabled: true,
    devices: DEVICES,
    now: () => Date.parse('2026-09-27T12:00:00.000Z'),
    uuid: () => commandIds[idIndex++],
  });
  const api = createKugouAgentApi({
    bridge,
    devices: [
      { ...DEVICES[0], token: TOKEN },
      { ...DEVICES[1], token: PHONE_TOKEN },
    ],
  });
  return { bridge, api };
}

function request(path, {
  method = 'POST',
  token = TOKEN,
  body,
  contentType = 'application/json',
} = {}) {
  const headers = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = contentType;
  return new Request(`https://music.example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('reads a device token from a file and does not expose failed paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kugou-token-'));
  const tokenFile = join(directory, 'device.secret');
  await writeFile(tokenFile, `${TOKEN}\n`, 'utf8');
  assert.equal(await readKugouDeviceToken(tokenFile), TOKEN);

  await writeFile(tokenFile, 'w'.repeat(32), 'utf8');
  await assert.rejects(readKugouDeviceToken(tokenFile), /内容无效/);

  const minimumToken = 'm'.repeat(43);
  await writeFile(tokenFile, minimumToken, 'utf8');
  assert.equal(await readKugouDeviceToken(tokenFile), minimumToken);

  const missing = join(directory, 'private-missing-token.secret');
  await assert.rejects(
    readKugouDeviceToken(missing),
    (error) => !error.message.includes(missing) && !error.message.includes('private-missing'),
  );
});

test('enforces the 43-character minimum when constructing the agent API', () => {
  const bridge = new KugouBridge();
  assert.throws(
    () => createKugouAgentApi({ bridge, token: 'w'.repeat(32) }),
    /缺少有效/,
  );
  assert.doesNotThrow(() =>
    createKugouAgentApi({ bridge, token: 'm'.repeat(43) }),
  );
});

test('maps the legacy single token to the pc-mumu identity', () => {
  const { api } = setup();
  assert.deepEqual(api.authenticateAuthorizationHeader(`Bearer ${TOKEN}`), {
    deviceId: 'pc-mumu',
    deviceName: 'Lucy-PC-MuMu',
    deviceType: 'windows_mumu',
  });
});

test('rejects duplicate device IDs and duplicate tokens', () => {
  const bridge = new KugouBridge({ devices: DEVICES });
  assert.throws(
    () => createKugouAgentApi({
      bridge,
      devices: [
        { ...DEVICES[0], token: TOKEN },
        { ...DEVICES[0], token: PHONE_TOKEN },
      ],
    }),
    /ID 重复/,
  );
  assert.throws(
    () => createKugouAgentApi({
      bridge,
      devices: [
        { ...DEVICES[0], token: TOKEN },
        { ...DEVICES[1], token: TOKEN },
      ],
    }),
    /Token 重复/,
  );
});

test('requires the independent bearer token without enabling CORS', async () => {
  const { api } = setup();
  for (const token of [null, 'wrong-token-value-that-is-long-enough']) {
    const response = await api.fetch(
      request('/agent/v1/commands/claim', { token }),
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
});

test('accepts strict status payloads and rejects unknown or sensitive fields', async () => {
  const { api, bridge } = setup();
  const accepted = await api.fetch(
    request('/agent/v1/status', {
      method: 'PUT',
      body: validStatus(),
    }),
  );
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).accepted, true);
  assert.equal(bridge.getStatus().player.title, '中文歌名');

  const rejected = await api.fetch(
    request('/agent/v1/status', {
      method: 'PUT',
      body: { ...validStatus({ sequence: 2 }), raw_description: 'must not upload' },
    }),
  );
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'invalid_request');
});

test('isolates status, claim and ACK by the token-bound device identity', async () => {
  const { api, bridge } = setupMultiple();
  assert.deepEqual(api.authenticateAuthorizationHeader(`Bearer ${PHONE_TOKEN}`), {
    deviceId: 'phone',
    deviceName: 'Lucy-Phone',
    deviceType: 'android',
  });

  const pcStatus = await api.fetch(
    request('/agent/v1/status', {
      method: 'PUT',
      token: TOKEN,
      body: validStatus({
        player: { ...validStatus().player, title: 'PC song' },
      }),
    }),
  );
  const phoneStatus = await api.fetch(
    request('/agent/v1/status', {
      method: 'PUT',
      token: PHONE_TOKEN,
      body: validStatus({
        player: { ...validStatus().player, title: 'Phone song' },
      }),
    }),
  );
  assert.equal(pcStatus.status, 200);
  assert.equal(phoneStatus.status, 200);
  assert.equal(bridge.getStatus('pc-mumu').player.title, 'PC song');
  assert.equal(bridge.getStatus('phone').player.title, 'Phone song');

  const pcCommand = bridge.enqueueCommand('next', 'pc-mumu');
  const phoneCommand = bridge.enqueueCommand('previous', 'phone');
  const claimedByPc = await api.fetch(
    request('/agent/v1/commands/claim', {
      token: TOKEN,
      body: { protocol_version: 1 },
    }),
  );
  const claimedByPhone = await api.fetch(
    request('/agent/v1/commands/claim', {
      token: PHONE_TOKEN,
      body: { protocol_version: 1 },
    }),
  );
  assert.equal((await claimedByPc.json()).command.id, pcCommand.id);
  assert.equal((await claimedByPhone.json()).command.id, phoneCommand.id);

  const ackBody = {
    protocol_version: 1,
    result: 'succeeded',
    completed_at: '2026-09-27T12:00:02.000Z',
  };
  const crossDeviceAck = await api.fetch(
    request(`/agent/v1/commands/${pcCommand.id}/ack`, {
      token: PHONE_TOKEN,
      body: ackBody,
    }),
  );
  assert.equal(crossDeviceAck.status, 404);
  assert.equal((await crossDeviceAck.json()).error, 'command_not_found');
  assert.equal(
    (await api.fetch(request(`/agent/v1/commands/${pcCommand.id}/ack`, {
      token: TOKEN,
      body: ackBody,
    }))).status,
    200,
  );
});

test('limits request bodies before parsing JSON', async () => {
  const { api } = setup({ maxBodyBytes: 32 });
  const response = await api.fetch(
    request('/agent/v1/status', {
      method: 'PUT',
      body: validStatus(),
    }),
  );
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: 'payload_too_large',
    message: '请求体过大。',
  });
});

test('claims commands and makes repeated ACKs idempotent', async () => {
  const { api, bridge } = setup();
  bridge.recordStatus('pc-mumu', validStatus());
  bridge.enqueueCommand('next');

  const claimed = await api.fetch(
    request('/agent/v1/commands/claim', { body: { protocol_version: 1 } }),
  );
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).command.id, COMMAND_ID);

  const ackBody = {
    protocol_version: 1,
    result: 'succeeded',
    completed_at: '2026-09-27T12:00:02.000Z',
  };
  const first = await api.fetch(
    request(`/agent/v1/commands/${COMMAND_ID}/ack`, { body: ackBody }),
  );
  assert.equal(first.status, 200);
  const repeated = await api.fetch(
    request(`/agent/v1/commands/${COMMAND_ID}/ack`, { body: ackBody }),
  );
  assert.equal(repeated.status, 200);

  const conflict = await api.fetch(
    request(`/agent/v1/commands/${COMMAND_ID}/ack`, {
      body: { ...ackBody, result: 'outcome_unknown' },
    }),
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'ack_conflict');
  assert.equal(
    (await api.fetch(request('/agent/v1/commands/claim'))).status,
    204,
  );
});

test('accepts only bounded failure codes in failed ACKs', async () => {
  const { api, bridge } = setup();
  bridge.recordStatus('pc-mumu', validStatus());
  bridge.enqueueCommand('toggle');
  bridge.claimCommand('pc-mumu');

  const missingError = await api.fetch(
    request(`/agent/v1/commands/${COMMAND_ID}/ack`, {
      body: {
        protocol_version: 1,
        result: 'failed',
        completed_at: '2026-09-27T12:00:02.000Z',
      },
    }),
  );
  assert.equal(missingError.status, 400);

  const accepted = await api.fetch(
    request(`/agent/v1/commands/${COMMAND_ID}/ack`, {
      body: {
        protocol_version: 1,
        result: 'failed',
        completed_at: '2026-09-27T12:00:02.000Z',
        error: { code: 'adb_command_failed' },
      },
    }),
  );
  assert.equal(accepted.status, 200);
});
