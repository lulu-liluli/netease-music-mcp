import test from 'node:test';
import assert from 'node:assert/strict';

import { KugouBridge, KugouBridgeError } from '../src/kugou-bridge.js';
import { KugouPlaybackEventAdapter } from '../src/kugou-events.js';
import { KugouEventQueue } from '../src/kugou-event-queue.js';

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

function playbackStatus({
  agentInstanceId = '10000000-0000-4000-8000-000000000001',
  sequence = 1,
  title = 'Song A',
  playbackState = 'playing',
  positionMs = 12_300,
} = {}) {
  return status({
    agent_instance_id: agentInstanceId,
    sequence,
    player: {
      ...status().player,
      title,
      playback_state: playbackState,
      position_ms: positionMs,
    },
  });
}

function setupWithEvents(options = {}) {
  const eventQueue = new KugouEventQueue();
  const eventAdapter = new KugouPlaybackEventAdapter();
  return {
    ...setup({ eventAdapter, eventQueue, ...options }),
    eventAdapter,
    eventQueue,
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

test('keeps an online active PC controllable while a registered phone is never seen', () => {
  const { bridge } = setup({ devices: DEVICES, activeDeviceId: 'pc-mumu' });
  bridge.recordStatus('pc-mumu', status());

  assert.equal(bridge.getStatus().device_id, 'pc-mumu');
  assert.equal(bridge.getStatus().online, true);
  assert.equal(bridge.getStatus('phone').reason, 'never_seen');
  const command = bridge.enqueueCommand('next');
  assert.equal(command.device_id, 'pc-mumu');
  assert.equal(bridge.claimCommand('phone'), null);
  assert.equal(bridge.claimCommand('pc-mumu').id, command.id);
});

test('rejects an active device that is not registered', () => {
  assert.throws(
    () => setup({ devices: DEVICES, activeDeviceId: 'missing-device' }),
    /活动酷狗设备不存在/,
  );
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

test('event dependencies are optional but must be supplied together', () => {
  const { bridge } = setup();
  assert.deepEqual(bridge.recordStatus('pc-mumu', playbackStatus()), {
    accepted: true,
  });
  assert.equal(bridge.getStatus().player.title, 'Song A');

  assert.throws(
    () => setup({ eventAdapter: new KugouPlaybackEventAdapter() }),
    /eventAdapter and eventQueue/,
  );
  assert.throws(
    () => setup({ eventQueue: new KugouEventQueue() }),
    /eventAdapter and eventQueue/,
  );
  assert.throws(
    () => setup({ eventAdapter: {}, eventQueue: new KugouEventQueue() }),
    /eventAdapter.accept and eventQueue.enqueue/,
  );
});

test('accepted reports pass trusted identity and real status snapshots to Adapter', () => {
  const calls = [];
  const eventAdapter = { accept: (input) => { calls.push(input); return []; } };
  const { bridge } = setup({ eventAdapter, eventQueue: new KugouEventQueue() });
  const first = playbackStatus();
  const second = playbackStatus({ sequence: 2, title: 'Song B' });

  assert.deepEqual(bridge.recordStatus('pc-mumu', first), { accepted: true });
  assert.deepEqual(bridge.recordStatus('pc-mumu', second), { accepted: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].device, DEVICES[0]);
  assert.equal(calls[0].previousStatus, null);
  assert.equal(calls[0].receivedAt, 1_000_000);
  assert.equal(calls[0].currentStatus.receivedAt, calls[0].receivedAt);
  assert.notStrictEqual(calls[0].currentStatus, first);
  assert.notStrictEqual(calls[0].currentStatus.player, first.player);
  assert.notStrictEqual(calls[0].currentStatus.capabilities, first.capabilities);
  assert.strictEqual(calls[1].previousStatus, calls[0].currentStatus);
  assert.strictEqual(calls[1].currentStatus, bridge.getDeviceRuntime('pc-mumu').latestStatus);
  assert.equal(Object.hasOwn(calls[1].previousStatus, 'online'), false);
  assert.deepEqual(bridge.getStatus().player.title, 'Song B');
});

test('event baseline, track changes, heartbeat and position rules integrate', () => {
  const { bridge, eventQueue } = setupWithEvents();
  const reports = [
    playbackStatus(),
    playbackStatus({ sequence: 2, title: 'Song B' }),
    playbackStatus({ sequence: 3, title: 'Song B' }),
    playbackStatus({ sequence: 4, title: 'Song B', positionMs: 25_000 }),
  ];

  assert.deepEqual(bridge.recordStatus('pc-mumu', reports[0]), { accepted: true });
  assert.equal(eventQueue.size(), 0);
  assert.deepEqual(bridge.recordStatus('pc-mumu', reports[1]), { accepted: true });
  assert.deepEqual(eventQueue.getState().pending.map((event) => event.eventType), [
    'track_changed',
  ]);
  bridge.recordStatus('pc-mumu', reports[2]);
  bridge.recordStatus('pc-mumu', reports[3]);
  assert.equal(eventQueue.size(), 1);

  bridge.recordStatus('pc-mumu', playbackStatus({ sequence: 5, title: 'Song C' }));
  assert.deepEqual(eventQueue.getState().pending.map((event) => event.current.track.title), [
    'Song C',
  ]);
  assert.deepEqual(eventQueue.getState().superseded.map((event) => event.current.track.title), [
    'Song B',
  ]);
});

test('playback pause and resume events retain Queue latest-wins behavior', () => {
  const { bridge, eventQueue } = setupWithEvents();
  bridge.recordStatus('pc-mumu', playbackStatus());
  bridge.recordStatus('pc-mumu', playbackStatus({ sequence: 2, playbackState: 'paused' }));
  assert.deepEqual(eventQueue.getState().pending.map((event) => event.eventType), [
    'playback_paused',
  ]);

  bridge.recordStatus('pc-mumu', playbackStatus({ sequence: 3, playbackState: 'playing' }));
  assert.deepEqual(eventQueue.getState().pending.map((event) => event.eventType), [
    'playback_resumed',
  ]);
  assert.deepEqual(eventQueue.getState().superseded.map((event) => event.eventType), [
    'playback_paused',
  ]);
});

test('stale and retired reports never reach Adapter or Queue', () => {
  const eventQueue = new KugouEventQueue();
  const realAdapter = new KugouPlaybackEventAdapter();
  let adapterCalls = 0;
  const eventAdapter = {
    accept(input) {
      adapterCalls += 1;
      return realAdapter.accept(input);
    },
  };
  const { bridge } = setup({ eventAdapter, eventQueue });
  bridge.recordStatus('pc-mumu', playbackStatus());
  bridge.recordStatus('pc-mumu', playbackStatus({ sequence: 2, title: 'Song B' }));
  assert.equal(adapterCalls, 2);
  assert.equal(eventQueue.size(), 1);

  assert.deepEqual(
    bridge.recordStatus('pc-mumu', playbackStatus({ sequence: 2, title: 'Song C' })),
    { accepted: false, reason: 'stale_sequence' },
  );
  assert.equal(adapterCalls, 2);
  assert.equal(eventQueue.size(), 1);

  const agentB = '20000000-0000-4000-8000-000000000002';
  bridge.recordStatus('pc-mumu', playbackStatus({
    agentInstanceId: agentB,
    sequence: 0,
    title: 'Song C',
  }));
  assert.equal(adapterCalls, 3);
  assert.deepEqual(
    bridge.recordStatus('pc-mumu', playbackStatus({ sequence: 3, title: 'Song D' })),
    { accepted: false, reason: 'retired_agent_instance' },
  );
  assert.equal(adapterCalls, 3);
  assert.equal(eventQueue.size(), 1);
});

test('new Agent instance starts a baseline before its own track transition', () => {
  const { bridge, eventQueue } = setupWithEvents();
  const agentB = '20000000-0000-4000-8000-000000000002';
  bridge.recordStatus('pc-mumu', playbackStatus({ title: 'Song A' }));
  assert.deepEqual(bridge.recordStatus('pc-mumu', playbackStatus({
    agentInstanceId: agentB,
    sequence: 0,
    title: 'Song B',
    playbackState: 'paused',
  })), { accepted: true });
  assert.equal(eventQueue.size(), 0);

  bridge.recordStatus('pc-mumu', playbackStatus({
    agentInstanceId: agentB,
    sequence: 1,
    title: 'Song C',
    playbackState: 'paused',
  }));
  assert.deepEqual(eventQueue.getState().pending.map((event) => event.eventType), [
    'track_changed',
  ]);
  assert.equal(eventQueue.getState().pending[0].previous.track.title, 'Song B');
  assert.equal(eventQueue.getState().pending[0].current.track.title, 'Song C');
});

test('one accepted report enqueues track and playback events in Adapter order', () => {
  const { bridge, eventQueue } = setupWithEvents();
  bridge.recordStatus('pc-mumu', playbackStatus({ playbackState: 'paused' }));
  bridge.recordStatus('pc-mumu', playbackStatus({
    sequence: 2,
    title: 'Song B',
    playbackState: 'playing',
  }));

  const pending = eventQueue.getState().pending;
  assert.deepEqual(pending.map((event) => event.eventType), [
    'track_changed',
    'playback_resumed',
  ]);
  assert.deepEqual(pending.map((event) => event.stateKey), [
    'kugou:pc-mumu:track',
    'kugou:pc-mumu:playback',
  ]);
});

test('Adapter failure is observable while the accepted status remains available', () => {
  const failure = new Error('adapter failed');
  const errors = [];
  const eventAdapter = { accept() { throw failure; } };
  const eventQueue = new KugouEventQueue();
  const { bridge } = setup({
    eventAdapter,
    eventQueue,
    onEventError: (error, context) => errors.push({ error, context }),
  });
  const report = playbackStatus({ title: 'private-title' });
  report.token = 'private-token';

  assert.deepEqual(bridge.recordStatus('pc-mumu', report), { accepted: true });
  assert.equal(bridge.getStatus().player.title, 'private-title');
  assert.equal(eventQueue.size(), 0);
  assert.strictEqual(errors[0].error, failure);
  assert.deepEqual(errors[0].context, {
    phase: 'adapter',
    deviceId: 'pc-mumu',
    agentInstanceId: report.agent_instance_id,
    sequence: report.sequence,
  });
  assert.equal(JSON.stringify(errors[0].context).includes('private'), false);
  assert.equal(errors.length, 1);
});

test('enqueue failure reports event ID and does not roll back earlier events', () => {
  const failure = new Error('queue failed');
  const first = { id: 'track-event' };
  const second = { id: 'playback-event' };
  const enqueued = [];
  const errors = [];
  const eventQueue = {
    enqueue(event) {
      if (event.id === second.id) throw failure;
      enqueued.push(event.id);
    },
  };
  const { bridge } = setup({
    eventAdapter: { accept: () => [first, second] },
    eventQueue,
    onEventError: (error, context) => errors.push({ error, context }),
  });

  assert.deepEqual(bridge.recordStatus('pc-mumu', playbackStatus()), {
    accepted: true,
  });
  assert.deepEqual(enqueued, ['track-event']);
  assert.equal(bridge.getStatus().online, true);
  assert.strictEqual(errors[0].error, failure);
  assert.deepEqual(errors[0].context, {
    phase: 'enqueue',
    deviceId: 'pc-mumu',
    agentInstanceId: '10000000-0000-4000-8000-000000000001',
    sequence: 1,
    eventId: 'playback-event',
  });
  assert.equal(errors.length, 1);
});

test('event errors remain isolated without a handler or with a failing handler', () => {
  const eventAdapter = { accept() { throw new Error('event failure'); } };
  const withoutHandler = setup({ eventAdapter, eventQueue: new KugouEventQueue() }).bridge;
  assert.deepEqual(withoutHandler.recordStatus('pc-mumu', playbackStatus()), {
    accepted: true,
  });

  const withFailingHandler = setup({
    eventAdapter,
    eventQueue: new KugouEventQueue(),
    onEventError() { throw new Error('observer failure'); },
  }).bridge;
  assert.deepEqual(withFailingHandler.recordStatus('pc-mumu', playbackStatus()), {
    accepted: true,
  });
});

test('invalid Adapter output is reported without interrupting status', () => {
  const errors = [];
  const { bridge } = setup({
    eventAdapter: { accept: () => null },
    eventQueue: new KugouEventQueue(),
    onEventError: (error, context) => errors.push({ error, context }),
  });

  assert.deepEqual(bridge.recordStatus('pc-mumu', playbackStatus()), {
    accepted: true,
  });
  assert.equal(bridge.getStatus().online, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context.phase, 'adapter');
});
