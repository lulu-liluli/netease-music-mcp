import test from 'node:test';
import assert from 'node:assert/strict';

import { KugouBridge, KugouBridgeError } from '../src/kugou-bridge.js';

const IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
];
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

  bridge.recordStatus('pc-mumu', status({ observed_at: '2000-01-01T00:00:00.000Z' }));
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
  assert.equal(bridge.recordStatus('pc-mumu', status()).accepted, true);
  assert.deepEqual(bridge.recordStatus('pc-mumu', status()), {
    accepted: false,
    reason: 'stale_sequence',
  });
  assert.equal(bridge.recordStatus('pc-mumu', status({ sequence: 2 })).accepted, true);

  const replacement = status({
    agent_instance_id: '20000000-0000-4000-8000-000000000002',
    sequence: 0,
  });
  assert.equal(bridge.recordStatus('pc-mumu', replacement).accepted, true);
  assert.deepEqual(bridge.recordStatus('pc-mumu', status({ sequence: 3 })), {
    accepted: false,
    reason: 'retired_agent_instance',
  });
});

test('isolates status sequences and agent instance lifecycles per device', () => {
  const { bridge } = setup({ devices: DEVICES, activeDeviceId: 'phone' });
  const sharedInstance = '10000000-0000-4000-8000-000000000001';
  assert.equal(
    bridge.recordStatus('pc-mumu', status({
      agent_instance_id: sharedInstance,
      sequence: 1,
      player: { ...status().player, title: 'PC song' },
    })).accepted,
    true,
  );
  assert.equal(
    bridge.recordStatus('phone', status({
      agent_instance_id: sharedInstance,
      sequence: 1,
      player: { ...status().player, title: 'Phone song' },
    })).accepted,
    true,
  );

  assert.equal(bridge.getStatus('pc-mumu').player.title, 'PC song');
  assert.equal(bridge.getStatus('phone').player.title, 'Phone song');
  assert.equal(
    bridge.recordStatus('pc-mumu', status({
      agent_instance_id: '20000000-0000-4000-8000-000000000002',
      sequence: 0,
    })).accepted,
    true,
  );
  assert.equal(
    bridge.recordStatus('phone', status({
      agent_instance_id: sharedInstance,
      sequence: 2,
    })).accepted,
    true,
  );
  assert.deepEqual(
    bridge.recordStatus('pc-mumu', status({
      agent_instance_id: sharedInstance,
      sequence: 2,
    })),
    { accepted: false, reason: 'retired_agent_instance' },
  );
});

test('isolates command claim and ACK by device', () => {
  const { bridge } = setup({ devices: DEVICES });
  bridge.recordStatus('pc-mumu', status());
  bridge.recordStatus('phone', status());

  const pcCommand = bridge.enqueueCommand('next', 'pc-mumu');
  assert.equal(bridge.claimCommand('phone'), null);
  assert.equal(bridge.claimCommand('pc-mumu').id, pcCommand.id);
  assert.throws(
    () => bridge.acknowledgeCommand('phone', pcCommand.id, 'succeeded'),
    (error) => error.code === 'command_not_found' && error.statusCode === 404,
  );
  assert.equal(
    bridge.acknowledgeCommand('pc-mumu', pcCommand.id, 'succeeded').result,
    'succeeded',
  );

  const phoneCommand = bridge.enqueueCommand('previous', 'phone');
  assert.equal(bridge.claimCommand('pc-mumu'), null);
  assert.equal(bridge.claimCommand('phone').id, phoneCommand.id);
});

test('applies FIFO, TTL and queue limits independently per device', () => {
  const { bridge, advance } = setup({ devices: DEVICES, maxPendingCommands: 2 });
  bridge.recordStatus('pc-mumu', status());
  bridge.recordStatus('phone', status());

  const firstPcCommand = bridge.enqueueCommand('next', 'pc-mumu');
  bridge.enqueueCommand('previous', 'pc-mumu');
  const firstPhoneCommand = bridge.enqueueCommand('previous', 'phone');
  bridge.enqueueCommand('next', 'phone');
  assert.equal(firstPcCommand.device_id, 'pc-mumu');
  assert.equal(firstPhoneCommand.device_id, 'phone');
  assert.equal(bridge.claimCommand('pc-mumu').id, firstPcCommand.id);
  assert.equal(bridge.claimCommand('phone').id, firstPhoneCommand.id);
  assert.throws(
    () => bridge.enqueueCommand('toggle', 'pc-mumu'),
    (error) => error.code === 'queue_full',
  );
  assert.throws(
    () => bridge.enqueueCommand('toggle', 'phone'),
    (error) => error.code === 'queue_full',
  );

  advance(30_000);
  assert.equal(bridge.claimCommand('pc-mumu'), null);
  assert.equal(bridge.claimCommand('phone'), null);
});

test('routes default status and control only to the active device without fallback', () => {
  const { bridge } = setup({ devices: DEVICES, activeDeviceId: 'phone' });
  bridge.recordStatus('pc-mumu', status());

  const offline = bridge.getStatus();
  assert.equal(offline.device_id, 'phone');
  assert.equal(offline.device_name, 'Lucy-Phone');
  assert.equal(offline.device_type, 'android');
  assert.equal(offline.active, true);
  assert.equal(offline.online, false);
  assert.throws(
    () => bridge.enqueueCommand('next'),
    (error) => error.code === 'device_offline',
  );
  assert.equal(bridge.claimCommand('pc-mumu'), null);

  bridge.recordStatus('phone', status());
  const command = bridge.enqueueCommand('next');
  assert.equal(command.device_id, 'phone');
  assert.equal(bridge.claimCommand('pc-mumu'), null);
  assert.equal(bridge.claimCommand('phone').id, command.id);
});

test('enqueues UUID commands in FIFO order and reclaims the same command until ACK', () => {
  const { bridge } = setup();
  bridge.recordStatus('pc-mumu', status());
  const first = bridge.enqueueCommand('next');
  const second = bridge.enqueueCommand('previous');
  assert.equal(first.id, IDS[0]);
  assert.equal(second.id, IDS[1]);
  assert.equal(first.status, 'queued');

  const claimed = bridge.claimCommand('pc-mumu');
  assert.equal(claimed.id, first.id);
  assert.equal(claimed.status, 'claimed');
  assert.equal(bridge.claimCommand('pc-mumu').id, first.id);

  bridge.acknowledgeCommand('pc-mumu', first.id, 'succeeded');
  assert.equal(bridge.claimCommand('pc-mumu').id, second.id);
});

test('makes identical ACKs idempotent and rejects conflicting ACKs', () => {
  const { bridge } = setup();
  bridge.recordStatus('pc-mumu', status());
  const command = bridge.enqueueCommand('toggle');
  bridge.claimCommand('pc-mumu');

  assert.equal(
    bridge.acknowledgeCommand('pc-mumu', command.id, 'outcome_unknown').result,
    'outcome_unknown',
  );
  assert.equal(
    bridge.acknowledgeCommand('pc-mumu', command.id, 'outcome_unknown').result,
    'outcome_unknown',
  );
  assert.throws(
    () => bridge.acknowledgeCommand('pc-mumu', command.id, 'succeeded'),
    (error) => error instanceof KugouBridgeError && error.statusCode === 409,
  );
});

test('expires commands after 30 seconds and never delivers them', () => {
  const { bridge, advance } = setup();
  bridge.recordStatus('pc-mumu', status());
  const command = bridge.enqueueCommand('next');
  advance(30_000);

  assert.equal(bridge.claimCommand('pc-mumu'), null);
  assert.throws(
    () => bridge.acknowledgeCommand('pc-mumu', command.id, 'succeeded'),
    (error) => error instanceof KugouBridgeError && error.statusCode === 410,
  );
});

test('enforces action, control, health, capability and queue constraints', () => {
  const disabled = new KugouBridge();
  disabled.recordStatus('pc-mumu', status());
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
    'pc-mumu',
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
    'pc-mumu',
    status({ sequence: 2, capabilities: ['status', 'toggle'] }),
  );
  assert.throws(
    () => bridge.enqueueCommand('next'),
    (error) => error.code === 'capability_missing',
  );

  bridge.recordStatus('pc-mumu', status({ sequence: 3 }));
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
  bridge.recordStatus('pc-mumu', status());
  for (let index = 0; index < 20; index += 1) {
    bridge.enqueueCommand('next');
  }
  assert.throws(
    () => bridge.enqueueCommand('next'),
    (error) => error.code === 'queue_full',
  );
});
