import test from 'node:test';
import assert from 'node:assert/strict';

import { KugouEventQueue } from '../src/kugou-event-queue.js';

function stateEvent({
  id,
  stateKey = 'kugou:pc-mumu:track',
  deviceId = 'pc-mumu',
  eventType = 'track_changed',
  value = id,
} = {}) {
  return {
    schemaVersion: 1,
    id,
    source: 'kugou.playback',
    stream: 'state',
    stateKey,
    eventType,
    createdAt: '2026-09-30T12:00:01.000Z',
    observedAt: '2026-09-30T12:00:00.000Z',
    device: { id: deviceId, name: `Device ${deviceId}` },
    cursor: { agentInstanceId: 'agent-1', sequence: 1 },
    previous: { value: 'previous' },
    current: { value },
  };
}

function ids(events) {
  return events.map((event) => event.id);
}

test('enqueue adds one pending event', () => {
  const queue = new KugouEventQueue();
  const result = queue.enqueue(stateEvent({ id: 'event-a' }));

  assert.equal(result.enqueued, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.status, 'pending');
  assert.equal(queue.size(), 1);
  assert.deepEqual(ids(queue.getState().pending), ['event-a']);
});

test('duplicate event IDs retain one authoritative event without throwing', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a', value: 'original' }));

  const duplicate = queue.enqueue(stateEvent({
    id: 'event-a',
    stateKey: 'kugou:pc-mumu:playback',
    value: 'replacement',
  }));

  assert.equal(duplicate.enqueued, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.current.value, 'original');
  assert.equal(queue.size(), 1);
  assert.deepEqual(ids(queue.getState().pending), ['event-a']);
});

test('different state keys are retained in global enqueue order', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'track' }));
  queue.enqueue(stateEvent({
    id: 'playback',
    stateKey: 'kugou:pc-mumu:playback',
    eventType: 'playback_resumed',
  }));

  assert.deepEqual(ids(queue.getState().pending), ['track', 'playback']);
  assert.equal(queue.reserveNext().id, 'track');
  assert.equal(queue.reserveNext().id, 'playback');
});

test('new pending state supersedes the old pending state', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'old-track' }));
  queue.enqueue(stateEvent({
    id: 'playback',
    stateKey: 'kugou:pc-mumu:playback',
  }));
  queue.enqueue(stateEvent({ id: 'new-track' }));

  const state = queue.getState();
  assert.deepEqual(ids(state.superseded), ['old-track']);
  assert.deepEqual(ids(state.pending), ['playback', 'new-track']);
  assert.equal(queue.reserveNext().id, 'playback');
  assert.equal(queue.reserveNext().id, 'new-track');
  assert.equal(queue.reserveNext(), null);
});

test('reserveNext moves the earliest pending event to reserved', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));

  assert.equal(queue.reserveNext().id, 'event-a');
  assert.deepEqual(queue.getState().pending, []);
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);
});

test('ACK delivers a reserved event and repeated ACK is idempotent', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  queue.reserveNext();

  const acknowledged = queue.ack('event-a');
  const repeated = queue.ack('event-a');

  assert.deepEqual(
    [acknowledged.acknowledged, acknowledged.alreadyAcknowledged],
    [true, false],
  );
  assert.equal(acknowledged.status, 'delivered');
  assert.deepEqual(
    [repeated.acknowledged, repeated.alreadyAcknowledged],
    [true, true],
  );
  assert.deepEqual(ids(queue.getState().delivered), ['event-a']);
});

test('ACK explicitly rejects unknown and pending events', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'pending' }));

  assert.deepEqual(queue.ack('missing'), {
    acknowledged: false,
    reason: 'unknown_event',
  });
  const pending = queue.ack('pending');
  assert.equal(pending.acknowledged, false);
  assert.equal(pending.reason, 'invalid_state');
  assert.equal(pending.status, 'pending');
});

test('a newer state stays pending while the older state remains reserved', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));

  const state = queue.getState();
  assert.deepEqual(ids(state.reserved), ['event-a']);
  assert.deepEqual(ids(state.pending), ['event-b']);
});

test('ACK of an older reserved state leaves its newer state consumable', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));

  assert.equal(queue.ack('event-a').acknowledged, true);
  assert.equal(queue.reserveNext().id, 'event-b');
});

test('release supersedes an older reservation when newer state exists', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));

  const released = queue.release('event-a');
  assert.equal(released.released, true);
  assert.equal(released.status, 'superseded');
  assert.deepEqual(ids(queue.getState().pending), ['event-b']);
  assert.equal(queue.reserveNext().id, 'event-b');
});

test('an older reservation cannot revive after newer state was delivered', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));
  queue.reserveNext();
  queue.ack('event-b');

  const released = queue.release('event-a');
  assert.equal(released.status, 'superseded');
  assert.deepEqual(queue.getState().pending, []);
});

test('release without newer state returns a reservation to pending once', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  queue.enqueue(stateEvent({
    id: 'event-b',
    stateKey: 'kugou:pc-mumu:playback',
  }));
  queue.reserveNext();

  const released = queue.release('event-a');
  const repeated = queue.release('event-a');

  assert.equal(released.released, true);
  assert.equal(released.status, 'pending');
  assert.equal(repeated.released, false);
  assert.equal(repeated.reason, 'invalid_state');
  assert.deepEqual(ids(queue.getState().pending), ['event-a', 'event-b']);
  assert.equal(queue.reserveNext().id, 'event-a');
});

test('reserveNext can filter by device without changing other events', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({
    id: 'phone-track',
    stateKey: 'kugou:phone:track',
    deviceId: 'phone',
  }));
  queue.enqueue(stateEvent({ id: 'pc-track' }));

  assert.equal(queue.reserveNext({ deviceId: 'pc-mumu' }).id, 'pc-track');
  assert.equal(queue.reserveNext({ deviceId: 'tablet' }), null);
  assert.equal(queue.reserveNext().id, 'phone-track');
});

test('reserveNext without a filter follows global enqueue order', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'pc-track' }));
  queue.enqueue(stateEvent({
    id: 'phone-track',
    stateKey: 'kugou:phone:track',
    deviceId: 'phone',
  }));

  assert.equal(queue.reserveNext().id, 'pc-track');
  assert.equal(queue.reserveNext().id, 'phone-track');
});

test('event inputs and returned objects cannot mutate queue state', () => {
  const queue = new KugouEventQueue();
  assert.equal('entries' in queue, false);
  assert.equal('pendingByStateKey' in queue, false);
  const input = stateEvent({ id: 'event-a', value: 'stored' });
  const enqueued = queue.enqueue(input);

  input.current.value = 'input mutation';
  enqueued.event.current.value = 'enqueue result mutation';
  const snapshot = queue.getState();
  snapshot.pending[0].current.value = 'state mutation';
  snapshot.pending.length = 0;

  const reserved = queue.reserveNext();
  assert.equal(reserved.current.value, 'stored');
  reserved.current.value = 'reserve mutation';
  assert.equal(queue.ack('event-a').event.current.value, 'stored');
});

test('duplicates remain duplicates in reserved, delivered and superseded states', () => {
  const queue = new KugouEventQueue();
  const original = stateEvent({ id: 'event-a' });
  queue.enqueue(original);
  queue.reserveNext();
  assert.equal(queue.enqueue(original).status, 'reserved');
  queue.ack('event-a');
  assert.equal(queue.enqueue(original).status, 'delivered');

  queue.enqueue(stateEvent({ id: 'old-track' }));
  queue.enqueue(stateEvent({ id: 'new-track' }));
  assert.equal(
    queue.enqueue(stateEvent({ id: 'old-track' })).status,
    'superseded',
  );
  assert.equal(queue.size(), 3);
});

test('only valid state events are accepted', () => {
  const queue = new KugouEventQueue();
  const invalid = [
    { ...stateEvent({ id: 'conversation' }), stream: 'conversation' },
    { ...stateEvent({ id: 'missing-key' }), stateKey: '' },
    { ...stateEvent({ id: 'missing-device' }), device: {} },
  ];

  for (const event of invalid) {
    assert.throws(() => queue.enqueue(event), TypeError);
  }
  assert.equal(queue.size(), 0);
});
