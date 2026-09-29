import test from 'node:test';
import assert from 'node:assert/strict';

import { KugouBridge, KugouBridgeError } from '../src/kugou-bridge.js';

const IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];

function status(overrides = {}) {
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
      title: '测试歌曲',
      artist: '测试歌手',
      album: '测试专辑',
      position_ms: 12_300,
    },
    ...overrides,
  };
}

function setup(options = {}) {
  let now = 1_000_000;
  let idIndex = 0;
  const bridge = new KugouBridge({
    controlEnabled: true,
    now: () => now,
    uuid: () => IDS[idIndex++],
    ...options,
  });
  return {
    bridge,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

test('uses server receipt time for online and offline status', () => {
  const { bridge, advance } = setup();
  assert.deepEqual(bridge.getStatus().reason, 'never_seen');

  bridge.recordStatus(status({ observed_at: '2000-01-01T00:00:00.000Z' }));
  assert.equal(bridge.getStatus().online, true);
  assert.equal(bridge.getStatus().age_ms, 0);

  advance(15_000);
  assert.equal(bridge.getStatus().online, true);
  advance(1);
  assert.equal(bridge.getStatus().online, false);
  assert.equal(bridge.getStatus().reason, 'heartbeat_timeout');
});

test('rejects stale sequences and retired agent instances', () => {
  const { bridge } = setup();
  assert.equal(bridge.recordStatus(status()).accepted, true);
  assert.deepEqual(bridge.recordStatus(status()), {
    accepted: false,
    reason: 'stale_sequence',
  });
  assert.equal(bridge.recordStatus(status({ sequence: 2 })).accepted, true);

  const replacement = status({
    agent_instance_id: '20000000-0000-4000-8000-000000000002',
    sequence: 0,
  });
  assert.equal(bridge.recordStatus(replacement).accepted, true);
  assert.deepEqual(bridge.recordStatus(status({ sequence: 3 })), {
    accepted: false,
    reason: 'retired_agent_instance',
  });
});

test('enqueues UUID commands in FIFO order and reclaims the same command until ACK', () => {
  const { bridge } = setup();
  bridge.recordStatus(status());
  const first = bridge.enqueueCommand('next');
  const second = bridge.enqueueCommand('previous');
  assert.equal(first.id, IDS[0]);
  assert.equal(second.id, IDS[1]);
  assert.equal(first.status, 'queued');

  const claimed = bridge.claimCommand();
  assert.equal(claimed.id, first.id);
  assert.equal(claimed.status, 'claimed');
  assert.equal(bridge.claimCommand().id, first.id);

  bridge.acknowledgeCommand(first.id, 'succeeded');
  assert.equal(bridge.claimCommand().id, second.id);
});

test('makes identical ACKs idempotent and rejects conflicting ACKs', () => {
  const { bridge } = setup();
  bridge.recordStatus(status());
  const command = bridge.enqueueCommand('toggle');
  bridge.claimCommand();

  assert.equal(
    bridge.acknowledgeCommand(command.id, 'outcome_unknown').result,
    'outcome_unknown',
  );
  assert.equal(
    bridge.acknowledgeCommand(command.id, 'outcome_unknown').result,
    'outcome_unknown',
  );
  assert.throws(
    () => bridge.acknowledgeCommand(command.id, 'succeeded'),
    (error) => error instanceof KugouBridgeError && error.statusCode === 409,
  );
});

test('expires commands after 30 seconds and never delivers them', () => {
  const { bridge, advance } = setup();
  bridge.recordStatus(status());
  const command = bridge.enqueueCommand('next');
  advance(30_000);

  assert.equal(bridge.claimCommand(), null);
  assert.throws(
    () => bridge.acknowledgeCommand(command.id, 'succeeded'),
    (error) => error instanceof KugouBridgeError && error.statusCode === 410,
  );
});

test('enforces action, control, health, capability and queue constraints', () => {
  const disabled = new KugouBridge();
  disabled.recordStatus(status());
  assert.throws(
    () => disabled.enqueueCommand('next'),
    (error) => error.code === 'control_disabled',
  );

  const { bridge } = setup({ maxPendingCommands: 1 });
  assert.throws(() => bridge.enqueueCommand('play'), /仅允许/);
  assert.throws(
    () => bridge.enqueueCommand('next'),
    (error) => error.code === 'device_offline',
  );

  bridge.recordStatus(
    status({
      health: 'degraded',
      player: null,
      error: { code: 'adb_unavailable' },
    }),
  );
  assert.throws(
    () => bridge.enqueueCommand('next'),
    (error) => error.code === 'device_degraded',
  );

  bridge.recordStatus(
    status({ sequence: 2, capabilities: ['status', 'toggle'] }),
  );
  assert.throws(
    () => bridge.enqueueCommand('next'),
    (error) => error.code === 'capability_missing',
  );

  bridge.recordStatus(status({ sequence: 3 }));
  bridge.enqueueCommand('next');
  assert.throws(
    () => bridge.enqueueCommand('previous'),
    (error) => error.code === 'queue_full' && error.statusCode === 429,
  );
});

test('uses the required default limit of 20 pending commands', () => {
  let counter = 0;
  const bridge = new KugouBridge({
    controlEnabled: true,
    uuid: () =>
      `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  });
  bridge.recordStatus(status());
  for (let index = 0; index < 20; index += 1) {
    bridge.enqueueCommand('next');
  }
  assert.throws(
    () => bridge.enqueueCommand('next'),
    (error) => error.code === 'queue_full',
  );
});
