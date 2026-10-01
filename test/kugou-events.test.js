import test from 'node:test';
import assert from 'node:assert/strict';

import { KugouPlaybackEventAdapter } from '../src/kugou-events.js';

const DEVICE = {
  deviceId: 'pc-mumu',
  deviceName: 'Lucy-PC-MuMu',
  deviceType: 'windows_mumu',
};
const RECEIVED_AT = '2026-09-30T12:00:01.000Z';

function status({
  agentInstanceId = '10000000-0000-4000-8000-000000000001',
  sequence = 1,
  playbackState = 'playing',
  title = 'Song A',
  artist = 'Artist',
  album = 'Album',
  positionMs = 1_000,
  observedAt = '2026-09-30T12:00:00.000Z',
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
      position_ms: positionMs,
    },
  };
}

function accept(adapter, previousStatus, currentStatus) {
  return adapter.accept({
    device: DEVICE,
    previousStatus,
    currentStatus,
    receivedAt: RECEIVED_AT,
  });
}

test('first status establishes a baseline without emitting events', () => {
  const adapter = new KugouPlaybackEventAdapter();
  assert.deepEqual(accept(adapter, null, status()), []);
});

test('emits one track_changed event for A to B', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const first = status();
  const second = status({ sequence: 2, title: 'Song B' });
  accept(adapter, null, first);

  const events = accept(adapter, first, second);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'track_changed');
  assert.equal(events[0].stateKey, 'kugou:pc-mumu:track');
  assert.equal(events[0].previous.track.title, 'Song A');
  assert.equal(events[0].current.track.title, 'Song B');
  assert.equal(events[0].createdAt, RECEIVED_AT);
  assert.equal(events[0].observedAt, second.observed_at);
  assert.equal(events[0].cursor.sequence, 2);
  assert.equal(JSON.stringify(events[0]).includes('position_ms'), false);
});

test('does not emit when the track identity is unchanged', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const first = status();
  accept(adapter, null, first);
  assert.deepEqual(accept(adapter, first, status({ sequence: 2 })), []);
});

test('ignores position-only changes', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const first = status({ positionMs: 1_000 });
  const second = status({ sequence: 2, positionMs: 25_000 });
  accept(adapter, null, first);
  assert.deepEqual(accept(adapter, first, second), []);
});

test('does not emit track_changed for temporarily empty metadata', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const first = status();
  const empty = status({ sequence: 2, title: '', artist: '', album: '' });
  const different = status({ sequence: 3, title: 'Song B' });
  accept(adapter, null, first);

  assert.deepEqual(accept(adapter, first, empty), []);
  assert.deepEqual(accept(adapter, empty, different), []);
});

test('emits playback_paused for playing to paused', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const playing = status();
  const paused = status({ sequence: 2, playbackState: 'paused' });
  accept(adapter, null, playing);

  const events = accept(adapter, playing, paused);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'playback_paused');
  assert.equal(events[0].stateKey, 'kugou:pc-mumu:playback');
  assert.deepEqual(events[0].previous, { playbackState: 'playing' });
  assert.deepEqual(events[0].current, { playbackState: 'paused' });
});

test('emits playback_resumed for paused to playing', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const paused = status({ playbackState: 'paused' });
  const playing = status({ sequence: 2, playbackState: 'playing' });
  accept(adapter, null, paused);

  const events = accept(adapter, paused, playing);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'playback_resumed');
  assert.deepEqual(events[0].previous, { playbackState: 'paused' });
  assert.deepEqual(events[0].current, { playbackState: 'playing' });
});

test('does not emit for playing to buffering', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const playing = status();
  const buffering = status({ sequence: 2, playbackState: 'buffering' });
  accept(adapter, null, playing);
  assert.deepEqual(accept(adapter, playing, buffering), []);
});

test('retains playing across buffering and emits one playback_paused', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const playing = status();
  const buffering = status({ sequence: 2, playbackState: 'buffering' });
  const paused = status({ sequence: 3, playbackState: 'paused' });
  accept(adapter, null, playing);
  assert.deepEqual(accept(adapter, playing, buffering), []);

  const events = accept(adapter, buffering, paused);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'playback_paused');
});

test('new agent instance starts a baseline without cross-epoch events', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const oldStatus = status({ title: 'Song A', playbackState: 'playing' });
  const newStatus = status({
    agentInstanceId: '20000000-0000-4000-8000-000000000002',
    sequence: 0,
    title: 'Song B',
    playbackState: 'paused',
  });
  accept(adapter, null, oldStatus);

  assert.deepEqual(accept(adapter, oldStatus, newStatus), []);
});

test('input agent mismatch establishes a baseline without cached state', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const oldStatus = status({ title: 'Song A', playbackState: 'playing' });
  const newStatus = status({
    agentInstanceId: '20000000-0000-4000-8000-000000000002',
    sequence: 0,
    title: 'Song B',
    playbackState: 'paused',
  });

  assert.deepEqual(accept(adapter, oldStatus, newStatus), []);
});

test('input agent mismatch establishes a baseline when cache is current', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const oldStatus = status({ title: 'Song A', playbackState: 'playing' });
  const newStatus = status({
    agentInstanceId: '20000000-0000-4000-8000-000000000002',
    sequence: 0,
    title: 'Song B',
    playbackState: 'paused',
  });
  accept(adapter, null, newStatus);

  assert.deepEqual(accept(adapter, oldStatus, newStatus), []);
});

test('same-agent snapshots retain normal behavior without cached state', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const previous = status({ title: 'Song A' });
  const current = status({ sequence: 2, title: 'Song B' });

  const events = accept(adapter, previous, current);
  assert.deepEqual(events.map((event) => event.eventType), ['track_changed']);
});

test('new agent baseline permits only later same-instance track changes', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const oldStatus = status({ title: 'Song A', playbackState: 'playing' });
  const newBaseline = status({
    agentInstanceId: '20000000-0000-4000-8000-000000000002',
    sequence: 0,
    title: 'Song B',
    playbackState: 'paused',
  });
  const nextStatus = status({
    agentInstanceId: newBaseline.agent_instance_id,
    sequence: 1,
    title: 'Song C',
    playbackState: 'paused',
  });
  accept(adapter, null, oldStatus);
  accept(adapter, oldStatus, newBaseline);

  const events = accept(adapter, newBaseline, nextStatus);
  assert.deepEqual(events.map((event) => event.eventType), ['track_changed']);
});

test('new agent stable baseline permits later same-instance pause', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const oldStatus = status({ playbackState: 'paused' });
  const newBaseline = status({
    agentInstanceId: '20000000-0000-4000-8000-000000000002',
    sequence: 0,
    playbackState: 'playing',
  });
  const paused = status({
    agentInstanceId: newBaseline.agent_instance_id,
    sequence: 1,
    playbackState: 'paused',
  });
  accept(adapter, null, oldStatus);
  accept(adapter, oldStatus, newBaseline);

  const events = accept(adapter, newBaseline, paused);
  assert.deepEqual(events.map((event) => event.eventType), ['playback_paused']);
});

test('unknown new-agent baseline waits for the first stable playback state', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const oldStatus = status({ playbackState: 'playing' });
  const unknown = status({
    agentInstanceId: '20000000-0000-4000-8000-000000000002',
    sequence: 0,
    playbackState: 'unknown',
  });
  const paused = status({
    agentInstanceId: unknown.agent_instance_id,
    sequence: 1,
    playbackState: 'paused',
  });
  const playing = status({
    agentInstanceId: unknown.agent_instance_id,
    sequence: 2,
    playbackState: 'playing',
  });
  accept(adapter, null, oldStatus);

  assert.deepEqual(accept(adapter, oldStatus, unknown), []);
  assert.deepEqual(accept(adapter, unknown, paused), []);
  const events = accept(adapter, paused, playing);
  assert.deepEqual(events.map((event) => event.eventType), ['playback_resumed']);
});

test('null previous status resets an existing stable playback baseline', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const playingBaseline = status({ playbackState: 'playing' });
  const unknown = status({ sequence: 2, playbackState: 'unknown' });
  const paused = status({ sequence: 3, playbackState: 'paused' });
  const playing = status({ sequence: 4, playbackState: 'playing' });
  accept(adapter, null, playingBaseline);

  assert.deepEqual(accept(adapter, null, unknown), []);
  assert.deepEqual(accept(adapter, unknown, paused), []);
  const events = accept(adapter, paused, playing);
  assert.deepEqual(events.map((event) => event.eventType), ['playback_resumed']);
});

test('internal agent epoch mismatch also establishes a baseline', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const oldStatus = status({ title: 'Song A', playbackState: 'playing' });
  const newPrevious = status({
    agentInstanceId: '20000000-0000-4000-8000-000000000002',
    sequence: 0,
    title: 'Song B',
    playbackState: 'playing',
  });
  const newCurrent = status({
    agentInstanceId: newPrevious.agent_instance_id,
    sequence: 1,
    title: 'Song C',
    playbackState: 'paused',
  });
  accept(adapter, null, oldStatus);

  assert.deepEqual(accept(adapter, newPrevious, newCurrent), []);
});

test('generates the same eventId for the same accepted report', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const first = status();
  const second = status({ sequence: 2, title: 'Song B' });
  accept(adapter, null, first);

  const firstPass = accept(adapter, first, second);
  const repeatedPass = accept(adapter, first, second);
  assert.equal(firstPass.length, 1);
  assert.equal(repeatedPass.length, 1);
  assert.equal(firstPass[0].id, repeatedPass[0].id);
  assert.match(firstPass[0].id, /^kugou:[0-9a-f]{64}$/);
});

test('generates different eventIds for the same transition at different sequences', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const first = status();
  accept(adapter, null, first);

  const atSequenceTwo = accept(
    adapter,
    first,
    status({ sequence: 2, title: 'Song B' }),
  );
  const atSequenceThree = accept(
    adapter,
    first,
    status({ sequence: 3, title: 'Song B' }),
  );
  assert.equal(atSequenceTwo.length, 1);
  assert.equal(atSequenceThree.length, 1);
  assert.notEqual(atSequenceTwo[0].id, atSequenceThree[0].id);
});

test('normalizes whitespace and Unicode NFKC in track identity', () => {
  const adapter = new KugouPlaybackEventAdapter();
  const previous = status({
    title: '  Ｓｏｎｇ　A  ',
    artist: 'Artist\tName',
    album: '  Album  ',
  });
  const current = status({
    sequence: 2,
    title: 'Song A',
    artist: 'Artist Name',
    album: 'Album',
  });

  assert.deepEqual(accept(adapter, previous, current), []);
});
