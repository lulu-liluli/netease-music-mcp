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

function reservationEventId(reservation) {
  return reservation?.event.id ?? null;
}

function acknowledge(queue, reservation) {
  return queue.ack(reservation.event.id, reservation.receiptToken);
}

function release(queue, reservation) {
  return queue.release(reservation.event.id, reservation.receiptToken);
}

function independentEvent(id, deviceId = id) {
  return stateEvent({
    id,
    stateKey: `kugou:${deviceId}:${id}`,
    deviceId,
  });
}

function deliver(queue, event) {
  const enqueued = queue.enqueue(event);
  assert.equal(enqueued.enqueued, true);
  const reservation = queue.reserveNext({ deviceId: event.device.id });
  assert.equal(reservation.event.id, event.id);
  assert.equal(acknowledge(queue, reservation).acknowledged, true);
  return reservation;
}

function enableFakeTimeouts(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
}

function enableLeaseClock(t, now = 1_000) {
  t.mock.timers.enable({
    apis: ['Date', 'setTimeout'],
    now,
  });
  return {
    now: () => Date.now(),
    tick: (milliseconds) => t.mock.timers.tick(milliseconds),
    setTime: (timestamp) => t.mock.timers.setTime(timestamp),
  };
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function trackedAbortSignal(signal) {
  let abortListeners = 0;
  return {
    get aborted() {
      return signal.aborted;
    },
    addEventListener(type, listener, options) {
      signal.addEventListener(type, listener, options);
      if (type === 'abort') {
        abortListeners += 1;
      }
    },
    removeEventListener(type, listener, options) {
      signal.removeEventListener(type, listener, options);
      if (type === 'abort') {
        abortListeners -= 1;
      }
    },
    abortListenerCount() {
      return abortListeners;
    },
  };
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
  assert.equal(reservationEventId(queue.reserveNext()), 'track');
  assert.equal(reservationEventId(queue.reserveNext()), 'playback');
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
  assert.equal(reservationEventId(queue.reserveNext()), 'playback');
  assert.equal(reservationEventId(queue.reserveNext()), 'new-track');
  assert.equal(queue.reserveNext(), null);
});

test('reserveNext moves the earliest pending event to reserved', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));

  assert.equal(reservationEventId(queue.reserveNext()), 'event-a');
  assert.deepEqual(queue.getState().pending, []);
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);
});

test('ACK delivers a reserved event and repeated ACK is idempotent', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const reservation = queue.reserveNext();

  const acknowledged = acknowledge(queue, reservation);
  const repeated = acknowledge(queue, reservation);
  const wrongToken = queue.ack('event-a', 'wrong-token');

  assert.deepEqual(
    [acknowledged.acknowledged, acknowledged.alreadyAcknowledged],
    [true, false],
  );
  assert.equal(acknowledged.status, 'delivered');
  assert.deepEqual(
    [repeated.acknowledged, repeated.alreadyAcknowledged],
    [true, true],
  );
  assert.equal(wrongToken.acknowledged, false);
  assert.equal(wrongToken.reason, 'stale_reservation');
  assert.deepEqual(ids(queue.getState().delivered), ['event-a']);
});

test('ACK explicitly rejects unknown and pending events', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'pending' }));

  assert.deepEqual(queue.ack('missing', 'unknown-token'), {
    acknowledged: false,
    reason: 'unknown_event',
  });
  const pending = queue.ack('pending', 'unknown-token');
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
  const older = queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));

  assert.equal(acknowledge(queue, older).acknowledged, true);
  assert.equal(reservationEventId(queue.reserveNext()), 'event-b');
});

test('release supersedes an older reservation when newer state exists', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const older = queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));

  const released = release(queue, older);
  assert.equal(released.released, true);
  assert.equal(released.status, 'superseded');
  assert.deepEqual(ids(queue.getState().pending), ['event-b']);
  assert.equal(reservationEventId(queue.reserveNext()), 'event-b');
});

test('an older reservation cannot revive after newer state was delivered', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const older = queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));
  const newer = queue.reserveNext();
  acknowledge(queue, newer);

  const released = release(queue, older);
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
  const reservation = queue.reserveNext();

  const released = release(queue, reservation);
  const repeated = release(queue, reservation);

  assert.equal(released.released, true);
  assert.equal(released.status, 'pending');
  assert.equal(repeated.released, false);
  assert.equal(repeated.reason, 'stale_reservation');
  assert.deepEqual(ids(queue.getState().pending), ['event-a', 'event-b']);
  assert.equal(reservationEventId(queue.reserveNext()), 'event-a');
});

test('reserveNext can filter by device without changing other events', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({
    id: 'phone-track',
    stateKey: 'kugou:phone:track',
    deviceId: 'phone',
  }));
  queue.enqueue(stateEvent({ id: 'pc-track' }));

  assert.equal(
    reservationEventId(queue.reserveNext({ deviceId: 'pc-mumu' })),
    'pc-track',
  );
  assert.equal(queue.reserveNext({ deviceId: 'tablet' }), null);
  assert.equal(reservationEventId(queue.reserveNext()), 'phone-track');
});

test('reserveNext without a filter follows global enqueue order', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'pc-track' }));
  queue.enqueue(stateEvent({
    id: 'phone-track',
    stateKey: 'kugou:phone:track',
    deviceId: 'phone',
  }));

  assert.equal(reservationEventId(queue.reserveNext()), 'pc-track');
  assert.equal(reservationEventId(queue.reserveNext()), 'phone-track');
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
  assert.equal(reserved.event.current.value, 'stored');
  reserved.event.current.value = 'reserve mutation';
  assert.equal(acknowledge(queue, reserved).event.current.value, 'stored');
});

test('duplicates remain duplicates in reserved, delivered and superseded states', () => {
  const queue = new KugouEventQueue();
  const original = stateEvent({ id: 'event-a' });
  queue.enqueue(original);
  const reservation = queue.reserveNext();
  assert.equal(queue.enqueue(original).status, 'reserved');
  acknowledge(queue, reservation);
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

test('waitNext immediately reserves an existing event without ACK', async () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));

  const reservation = await queue.waitNext({
    deviceId: 'pc-mumu',
    timeoutMs: 10,
  });

  assert.equal(reservation.event.id, 'event-a');
  assert.deepEqual(queue.getState().pending, []);
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);
  assert.deepEqual(queue.getState().delivered, []);
});

test('waitNext wakes when a matching event is enqueued', async () => {
  const queue = new KugouEventQueue();
  const waiting = queue.waitNext({ deviceId: 'pc-mumu' });

  const enqueued = queue.enqueue(stateEvent({ id: 'event-a' }));
  const reservation = await waiting;

  assert.equal(enqueued.status, 'pending');
  assert.equal(reservation.event.id, 'event-a');
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);
});

test('waitNext double-check closes the empty-check registration gap', async () => {
  const queue = new KugouEventQueue();
  const reserveNext = queue.reserveNext.bind(queue);
  let firstCheck = true;
  queue.reserveNext = (options) => {
    const reservation = reserveNext(options);
    if (firstCheck) {
      firstCheck = false;
      assert.equal(reservation, null);
      queue.enqueue(stateEvent({ id: 'event-in-gap' }));
    }
    return reservation;
  };

  const reservation = await queue.waitNext({ timeoutMs: 10 });

  assert.equal(reservation.event.id, 'event-in-gap');
  assert.deepEqual(ids(queue.getState().reserved), ['event-in-gap']);
});

test('waitNext ignores other devices until a matching event arrives', async () => {
  const queue = new KugouEventQueue();
  const waiting = queue.waitNext({ deviceId: 'pc-mumu' });
  let settled = false;
  void waiting.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  queue.enqueue(stateEvent({
    id: 'phone-track',
    stateKey: 'kugou:phone:track',
    deviceId: 'phone',
  }));
  await Promise.resolve();

  assert.equal(settled, false);
  assert.deepEqual(ids(queue.getState().pending), ['phone-track']);

  queue.enqueue(stateEvent({ id: 'pc-track' }));
  assert.equal((await waiting).event.id, 'pc-track');
  assert.deepEqual(ids(queue.getState().pending), ['phone-track']);
  assert.deepEqual(ids(queue.getState().reserved), ['pc-track']);
});

test('waitNext without a device filter wakes for any device', async () => {
  const queue = new KugouEventQueue();
  const waiting = queue.waitNext();

  queue.enqueue(stateEvent({
    id: 'phone-track',
    stateKey: 'kugou:phone:track',
    deviceId: 'phone',
  }));

  assert.equal((await waiting).event.id, 'phone-track');
  assert.deepEqual(ids(queue.getState().reserved), ['phone-track']);
});

test('waitNext timeout returns null without changing event state', async (t) => {
  enableFakeTimeouts(t);
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({
    id: 'phone-track',
    stateKey: 'kugou:phone:track',
    deviceId: 'phone',
  }));
  const waiting = queue.waitNext({
    deviceId: 'pc-mumu',
    timeoutMs: 25,
  });

  t.mock.timers.tick(25);

  assert.equal(await waiting, null);
  assert.deepEqual(ids(queue.getState().pending), ['phone-track']);
  assert.deepEqual(queue.getState().reserved, []);
});

test('a timed-out waiter stays detached and a new wait succeeds', async (t) => {
  enableFakeTimeouts(t);
  const queue = new KugouEventQueue();
  const expired = queue.waitNext({ timeoutMs: 10 });

  t.mock.timers.tick(10);
  assert.equal(await expired, null);

  const enqueued = queue.enqueue(stateEvent({ id: 'event-after-timeout' }));
  assert.equal(enqueued.status, 'pending');
  assert.deepEqual(ids(queue.getState().pending), ['event-after-timeout']);

  const reservation = await queue.waitNext({ timeoutMs: 1 });
  assert.equal(reservation.event.id, 'event-after-timeout');
});

test('an already aborted signal rejects before reserving an event', async () => {
  const queue = new KugouEventQueue();
  const controller = new AbortController();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  controller.abort();

  await assert.rejects(
    queue.waitNext({ signal: controller.signal }),
    isAbortError,
  );
  assert.deepEqual(ids(queue.getState().pending), ['event-a']);
  assert.deepEqual(queue.getState().reserved, []);
});

test('abort while waiting rejects, cleans up and allows another wait', async () => {
  const queue = new KugouEventQueue();
  const controller = new AbortController();
  const signal = trackedAbortSignal(controller.signal);
  const waiting = queue.waitNext({ signal, timeoutMs: 100 });
  const rejected = assert.rejects(waiting, isAbortError);

  assert.equal(signal.abortListenerCount(), 1);
  controller.abort();
  await rejected;
  assert.equal(signal.abortListenerCount(), 0);

  const enqueued = queue.enqueue(stateEvent({ id: 'event-after-abort' }));
  assert.equal(enqueued.status, 'pending');
  assert.deepEqual(ids(queue.getState().pending), ['event-after-abort']);
  assert.equal(
    (await queue.waitNext({ timeoutMs: 10 })).event.id,
    'event-after-abort',
  );
});

test('timeout removes its abort listener before a later wait', async (t) => {
  enableFakeTimeouts(t);
  const queue = new KugouEventQueue();
  const controller = new AbortController();
  const signal = trackedAbortSignal(controller.signal);
  const expired = queue.waitNext({ signal, timeoutMs: 10 });

  assert.equal(signal.abortListenerCount(), 1);
  t.mock.timers.tick(10);
  assert.equal(await expired, null);
  assert.equal(signal.abortListenerCount(), 0);

  const waiting = queue.waitNext({ timeoutMs: 20 });
  let settled = false;
  void waiting.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  controller.abort();
  await Promise.resolve();
  assert.equal(settled, false);

  queue.enqueue(stateEvent({ id: 'event-after-old-abort' }));
  assert.equal((await waiting).event.id, 'event-after-old-abort');
});

test('a second concurrent wait is rejected until the first completes', async () => {
  const queue = new KugouEventQueue();
  const first = queue.waitNext({ timeoutMs: 100 });

  await assert.rejects(
    queue.waitNext({ timeoutMs: 100 }),
    {
      name: 'Error',
      message: 'KugouEventQueue already has an active waiter.',
      code: 'waiter_busy',
    },
  );

  queue.enqueue(stateEvent({ id: 'event-a' }));
  const firstReservation = await first;
  assert.equal(firstReservation.event.id, 'event-a');
  acknowledge(queue, firstReservation);

  const later = queue.waitNext({ timeoutMs: 100 });
  queue.enqueue(stateEvent({ id: 'event-b' }));
  assert.equal((await later).event.id, 'event-b');
});

test('duplicate enqueue causes only one waitNext delivery', async (t) => {
  enableFakeTimeouts(t);
  const queue = new KugouEventQueue();
  const event = stateEvent({ id: 'event-a' });
  const first = queue.waitNext({ timeoutMs: 20 });

  assert.equal(queue.enqueue(event).status, 'pending');
  const duplicateWhileReserved = queue.enqueue(event);
  assert.equal(duplicateWhileReserved.duplicate, true);
  assert.equal(duplicateWhileReserved.status, 'reserved');
  const firstReservation = await first;
  assert.equal(firstReservation.event.id, 'event-a');
  acknowledge(queue, firstReservation);

  const second = queue.waitNext({ timeoutMs: 20 });
  const duplicateAfterAck = queue.enqueue(event);
  assert.equal(duplicateAfterAck.duplicate, true);
  assert.equal(duplicateAfterAck.status, 'delivered');
  t.mock.timers.tick(20);
  assert.equal(await second, null);
});

test('waitNext honors latest-wins without reviving superseded state', async () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'old-track' }));
  queue.enqueue(stateEvent({ id: 'new-track' }));

  const reservation = await queue.waitNext({ timeoutMs: 10 });

  assert.equal(reservation.event.id, 'new-track');
  assert.deepEqual(ids(queue.getState().superseded), ['old-track']);
  assert.deepEqual(ids(queue.getState().reserved), ['new-track']);
});

test('release to pending wakes waitNext and reserves the event again', async () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const original = queue.reserveNext();
  const waiting = queue.waitNext({ deviceId: 'pc-mumu' });

  const released = release(queue, original);
  const reservation = await waiting;

  assert.equal(released.released, true);
  assert.equal(released.status, 'pending');
  assert.equal(reservation.event.id, 'event-a');
  assert.notEqual(reservation.receiptToken, original.receiptToken);
  assert.deepEqual(queue.getState().pending, []);
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);
});

test('ACK after waitNext prevents the event from being delivered again', async (t) => {
  enableFakeTimeouts(t);
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const reservation = await queue.waitNext({ timeoutMs: 10 });

  assert.equal(acknowledge(queue, reservation).status, 'delivered');
  const repeated = queue.waitNext({ timeoutMs: 10 });
  t.mock.timers.tick(10);

  assert.equal(await repeated, null);
  assert.deepEqual(ids(queue.getState().delivered), ['event-a']);
});

test('waitNext validates timeoutMs and accepts both bounds', async () => {
  const queue = new KugouEventQueue();
  const invalidTimeouts = [0, -1, 1.5, 45_001, NaN, Infinity, '10', null];

  for (const timeoutMs of invalidTimeouts) {
    await assert.rejects(
      queue.waitNext({ timeoutMs }),
      RangeError,
    );
  }

  for (const timeoutMs of [1, 45_000]) {
    const boundedQueue = new KugouEventQueue();
    boundedQueue.enqueue(stateEvent({ id: `event-${timeoutMs}` }));
    assert.equal(
      (await boundedQueue.waitNext({ timeoutMs })).event.id,
      `event-${timeoutMs}`,
    );
  }
});

test('abort racing with delivery safely releases the reservation', async () => {
  const queue = new KugouEventQueue();
  const controller = new AbortController();
  const reserveNext = queue.reserveNext.bind(queue);
  let abortAfterReservation = true;
  queue.reserveNext = (options) => {
    const reservation = reserveNext(options);
    if (reservation && abortAfterReservation) {
      abortAfterReservation = false;
      controller.abort();
    }
    return reservation;
  };
  const waiting = queue.waitNext({
    signal: controller.signal,
    timeoutMs: 100,
  });
  const rejected = assert.rejects(waiting, isAbortError);

  queue.enqueue(stateEvent({ id: 'raced-event' }));
  await rejected;

  assert.deepEqual(queue.getState().reserved, []);
  assert.deepEqual(ids(queue.getState().pending), ['raced-event']);
  queue.reserveNext = reserveNext;
  assert.equal(
    (await queue.waitNext({ timeoutMs: 10 })).event.id,
    'raced-event',
  );
});

test('signal listener registration failure does not retain the waiter', async () => {
  const queue = new KugouEventQueue();
  let removeCalls = 0;
  const signal = {
    aborted: false,
    addEventListener() {
      throw new Error('listener registration failed');
    },
    removeEventListener() {
      removeCalls += 1;
    },
  };

  await assert.rejects(
    queue.waitNext({ signal, timeoutMs: 10 }),
    /listener registration failed/,
  );
  assert.equal(removeCalls, 1);

  const waiting = queue.waitNext({ timeoutMs: 10 });
  queue.enqueue(stateEvent({ id: 'event-after-registration-error' }));
  assert.equal((await waiting).event.id, 'event-after-registration-error');
});

test('synchronous abort during listener registration keeps AbortError', async () => {
  const queue = new KugouEventQueue();
  let aborted = false;
  let registeredListener = null;
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener(type, listener) {
      assert.equal(type, 'abort');
      registeredListener = listener;
      aborted = true;
      listener();
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort');
      assert.equal(listener, registeredListener);
      registeredListener = null;
    },
  };

  await assert.rejects(
    queue.waitNext({ signal, timeoutMs: 10 }),
    isAbortError,
  );
  assert.equal(registeredListener, null);

  const waiting = queue.waitNext({ timeoutMs: 10 });
  queue.enqueue(stateEvent({ id: 'event-after-reentrant-abort' }));
  assert.equal((await waiting).event.id, 'event-after-reentrant-abort');
});

test('reserveNext returns a receipt envelope without changing the event schema', () => {
  const queue = new KugouEventQueue({ now: () => 1_000 });
  queue.enqueue(stateEvent({ id: 'event-a' }));

  const reservation = queue.reserveNext();

  assert.deepEqual(
    Object.keys(reservation).sort(),
    ['event', 'leaseExpiresAt', 'receiptToken'],
  );
  assert.equal(reservation.event.id, 'event-a');
  assert.match(
    reservation.receiptToken,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]*$/u,
  );
  assert.equal(reservation.leaseExpiresAt, 61_000);
  assert.equal('receiptToken' in reservation.event, false);
  assert.equal('leaseExpiresAt' in reservation.event, false);
  assert.equal('receiptToken' in queue.getState().reserved[0], false);
  release(queue, reservation);
});

test('reservationLeaseMs is configurable', () => {
  const queue = new KugouEventQueue({
    now: () => 2_000,
    reservationLeaseMs: 25,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));

  const reservation = queue.reserveNext();

  assert.equal(reservation.leaseExpiresAt, 2_025);
  release(queue, reservation);
});

test('old ACK and release cannot affect a re-reserved event', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const first = queue.reserveNext();
  assert.equal(release(queue, first).released, true);

  const second = queue.reserveNext();
  assert.notEqual(second.receiptToken, first.receiptToken);

  const oldAck = acknowledge(queue, first);
  const oldRelease = release(queue, first);
  assert.equal(oldAck.acknowledged, false);
  assert.equal(oldAck.reason, 'stale_reservation');
  assert.equal(oldRelease.released, false);
  assert.equal(oldRelease.reason, 'stale_reservation');
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);
  assert.equal(acknowledge(queue, second).acknowledged, true);
});

test('a receipt token is never reused across an A-B-A UUID collision', () => {
  const tokenA = '00000000-0000-4000-8000-00000000000a';
  const tokenB = '00000000-0000-4000-8000-00000000000b';
  const tokens = [tokenA, tokenB, tokenA];
  const queue = new KugouEventQueue({
    createReceiptToken: () => tokens.shift(),
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));

  const first = queue.reserveNext();
  release(queue, first);
  const second = queue.reserveNext();
  release(queue, second);
  const third = queue.reserveNext();

  assert.equal(first.receiptToken, `${tokenA}:1`);
  assert.equal(second.receiptToken, `${tokenB}:2`);
  assert.equal(third.receiptToken, `${tokenA}:3`);
  assert.equal(new Set([
    first.receiptToken,
    second.receiptToken,
    third.receiptToken,
  ]).size, 3);
  assert.equal(acknowledge(queue, first).reason, 'stale_reservation');
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);
  assert.equal(acknowledge(queue, third).acknowledged, true);
});

test('repeated reserve and release cycles need no per-event token history', () => {
  const receiptUuid = '00000000-0000-4000-8000-00000000000a';
  const queue = new KugouEventQueue({
    createReceiptToken: () => receiptUuid,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const receiptTokens = [];

  for (let sequence = 1; sequence <= 128; sequence += 1) {
    const reservation = queue.reserveNext();
    receiptTokens.push(reservation.receiptToken);
    assert.equal(
      reservation.receiptToken,
      `${receiptUuid}:${sequence}`,
    );
    assert.equal(release(queue, reservation).released, true);
  }

  assert.equal(new Set(receiptTokens).size, receiptTokens.length);
  const current = queue.reserveNext();
  assert.equal(acknowledge(queue, {
    event: current.event,
    receiptToken: receiptTokens[0],
  }).reason, 'stale_reservation');
  assert.equal(release(queue, {
    event: current.event,
    receiptToken: receiptTokens[0],
  }).reason, 'stale_reservation');
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);
  release(queue, current);
});

test('reservation sequence is shared by every event in one Queue', () => {
  const receiptUuid = '00000000-0000-4000-8000-00000000000a';
  const queue = new KugouEventQueue({
    createReceiptToken: () => receiptUuid,
  });
  queue.enqueue(independentEvent('event-a'));
  queue.enqueue(independentEvent('event-b'));

  const first = queue.reserveNext({ deviceId: 'event-a' });
  const second = queue.reserveNext({ deviceId: 'event-b' });

  assert.equal(first.receiptToken, `${receiptUuid}:1`);
  assert.equal(second.receiptToken, `${receiptUuid}:2`);
  release(queue, first);
  release(queue, second);
});

test('ACK and release require a receipt token', () => {
  const queue = new KugouEventQueue();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const reservation = queue.reserveNext();

  assert.deepEqual(queue.ack('event-a'), {
    acknowledged: false,
    reason: 'reservation_required',
  });
  assert.deepEqual(queue.release('event-a'), {
    released: false,
    reason: 'reservation_required',
  });
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);
  release(queue, reservation);
});

test('ACK before lease expiry succeeds', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const reservation = queue.reserveNext();

  clock.setTime(reservation.leaseExpiresAt - 1);

  assert.equal(acknowledge(queue, reservation).acknowledged, true);
  assert.deepEqual(ids(queue.getState().delivered), ['event-a']);
});

test('ACK exactly at lease expiry is stale and restores pending', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const reservation = queue.reserveNext();

  clock.setTime(reservation.leaseExpiresAt);
  const acknowledged = acknowledge(queue, reservation);

  assert.equal(acknowledged.acknowledged, false);
  assert.equal(acknowledged.reason, 'stale_reservation');
  assert.deepEqual(ids(queue.getState().pending), ['event-a']);
  assert.deepEqual(queue.getState().reserved, []);
});

test('release after lease expiry is stale and restores pending', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const reservation = queue.reserveNext();

  clock.setTime(reservation.leaseExpiresAt + 1);
  const released = release(queue, reservation);

  assert.equal(released.released, false);
  assert.equal(released.reason, 'stale_reservation');
  assert.deepEqual(ids(queue.getState().pending), ['event-a']);
});

test('lease timer returns an event to pending when no newer state exists', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const reservation = queue.reserveNext();

  clock.tick(10);

  assert.deepEqual(ids(queue.getState().pending), ['event-a']);
  assert.equal(acknowledge(queue, reservation).reason, 'stale_reservation');
});

test('lease expiry supersedes an old reservation after newer state is delivered', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const older = queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));
  const newer = queue.reserveNext();
  acknowledge(queue, newer);

  clock.tick(10);

  assert.deepEqual(ids(queue.getState().superseded), ['event-a']);
  assert.deepEqual(ids(queue.getState().delivered), ['event-b']);
  assert.equal(acknowledge(queue, older).reason, 'stale_reservation');
});

test('an old lease stays superseded when its newer event is superseded', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const older = queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));
  queue.enqueue(stateEvent({ id: 'event-c' }));

  clock.tick(10);

  assert.deepEqual(ids(queue.getState().pending), ['event-c']);
  assert.deepEqual(ids(queue.getState().superseded), ['event-a', 'event-b']);
  assert.equal(acknowledge(queue, older).reason, 'stale_reservation');
});

test('lease expiry wakes waitNext with a new receipt token', async (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const first = queue.reserveNext();
  const waiting = queue.waitNext({
    deviceId: 'pc-mumu',
    timeoutMs: 100,
  });

  clock.tick(10);
  const second = await waiting;

  assert.equal(second.event.id, first.event.id);
  assert.notEqual(second.receiptToken, first.receiptToken);
  assert.equal(second.leaseExpiresAt, Date.now() + 10);
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);
  release(queue, second);
});

test('abort before lease expiry detaches without losing the event', async (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10,
  });
  const controller = new AbortController();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  queue.reserveNext();
  const waiting = queue.waitNext({
    signal: controller.signal,
    timeoutMs: 100,
  });
  const rejected = assert.rejects(waiting, isAbortError);

  controller.abort();
  await rejected;
  clock.tick(10);

  assert.deepEqual(ids(queue.getState().pending), ['event-a']);
  const recovered = queue.reserveNext();
  assert.equal(recovered.event.id, 'event-a');
  release(queue, recovered);
});

test('lease delivery before abort leaves the new reservation intact', async (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10,
  });
  const controller = new AbortController();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const first = queue.reserveNext();
  const waiting = queue.waitNext({
    signal: controller.signal,
    timeoutMs: 100,
  });

  clock.tick(10);
  const second = await waiting;
  controller.abort();

  assert.notEqual(second.receiptToken, first.receiptToken);
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);
  assert.equal(acknowledge(queue, second).acknowledged, true);
});

test('waitNext immediate abort rollback releases the exact reservation', async () => {
  const queue = new KugouEventQueue();
  const controller = new AbortController();
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const reserveNext = queue.reserveNext.bind(queue);
  queue.reserveNext = (options) => {
    const reservation = reserveNext(options);
    if (reservation) controller.abort();
    return reservation;
  };

  await assert.rejects(
    queue.waitNext({ signal: controller.signal }),
    isAbortError,
  );

  assert.deepEqual(queue.getState().reserved, []);
  assert.deepEqual(ids(queue.getState().pending), ['event-a']);
});

test('lease expiry preserves device isolation for a waiting consumer', async (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10,
  });
  queue.enqueue(stateEvent({
    id: 'phone-track',
    stateKey: 'kugou:phone:track',
    deviceId: 'phone',
  }));
  const phone = queue.reserveNext({ deviceId: 'phone' });
  clock.tick(5);
  queue.enqueue(stateEvent({ id: 'pc-track' }));
  const pc = queue.reserveNext({ deviceId: 'pc-mumu' });
  const waiting = queue.waitNext({
    deviceId: 'pc-mumu',
    timeoutMs: 100,
  });
  let settled = false;
  void waiting.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  clock.tick(5);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(ids(queue.getState().pending), ['phone-track']);
  assert.deepEqual(ids(queue.getState().reserved), ['pc-track']);

  clock.tick(5);
  const nextPc = await waiting;
  assert.equal(nextPc.event.id, pc.event.id);
  assert.notEqual(nextPc.receiptToken, pc.receiptToken);
  assert.deepEqual(ids(queue.getState().pending), ['phone-track']);
  assert.equal(queue.ack(phone.event.id, phone.receiptToken).reason, 'stale_reservation');
  release(queue, nextPc);
});

test('multiple reservations share one Queue lease timer', (t) => {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const activeTimers = new Set();
  let maxActiveTimers = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    let timer;
    timer = nativeSetTimeout(() => {
      activeTimers.delete(timer);
      callback();
    }, delay, ...args);
    activeTimers.add(timer);
    maxActiveTimers = Math.max(maxActiveTimers, activeTimers.size);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    activeTimers.delete(timer);
    nativeClearTimeout(timer);
  });
  t.after(() => {
    for (const timer of activeTimers) nativeClearTimeout(timer);
  });

  const queue = new KugouEventQueue({
    now: () => 1_000,
    reservationLeaseMs: 10_000,
  });
  queue.enqueue(stateEvent({ id: 'track' }));
  queue.enqueue(stateEvent({
    id: 'playback',
    stateKey: 'kugou:pc-mumu:playback',
  }));
  const track = queue.reserveNext();
  const playback = queue.reserveNext();

  assert.equal(activeTimers.size, 1);
  assert.equal(maxActiveTimers, 1);
  acknowledge(queue, track);
  assert.equal(activeTimers.size, 1);
  acknowledge(queue, playback);
  assert.equal(activeTimers.size, 0);
});

test('the Queue lease timer moves to the next distinct expiry', async (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10,
  });
  queue.enqueue(stateEvent({ id: 'track' }));
  const track = queue.reserveNext();
  clock.tick(5);
  queue.enqueue(stateEvent({
    id: 'playback',
    stateKey: 'kugou:pc-mumu:playback',
  }));
  const playback = queue.reserveNext();

  acknowledge(queue, track);
  const waiting = queue.waitNext({ timeoutMs: 100 });
  let settled = false;
  void waiting.then(() => { settled = true; });

  clock.tick(9);
  await Promise.resolve();
  assert.equal(settled, false);

  clock.tick(1);
  const next = await waiting;
  assert.equal(next.event.id, playback.event.id);
  assert.notEqual(next.receiptToken, playback.receiptToken);
  release(queue, next);
});

test('terminal retention options require positive safe integers', () => {
  const invalidValues = [0, -1, 1.5, Number.NaN, Infinity, '10', null];

  for (const terminalRetentionMs of invalidValues) {
    assert.throws(
      () => new KugouEventQueue({ terminalRetentionMs }),
      /terminalRetentionMs must be a positive integer/u,
    );
  }
  for (const maxTerminalEntries of invalidValues) {
    assert.throws(
      () => new KugouEventQueue({ maxTerminalEntries }),
      /maxTerminalEntries must be a positive integer/u,
    );
  }
  assert.doesNotThrow(() => new KugouEventQueue({
    terminalRetentionMs: 1,
    maxTerminalEntries: 1,
  }));
});

test('delivered entries use the default TTL and expire at its exact boundary', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({ now: clock.now });
  deliver(queue, independentEvent('event-a'));

  clock.setTime(300_999);
  assert.deepEqual(ids(queue.getState().delivered), ['event-a']);

  clock.setTime(301_000);
  assert.deepEqual(queue.getState().delivered, []);
  assert.equal(queue.size(), 0);
});

test('terminalAt is the Queue time when an event enters terminal state', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    terminalRetentionMs: 10,
  });
  queue.enqueue(independentEvent('event-a'));
  const reservation = queue.reserveNext();

  clock.setTime(5_000);
  acknowledge(queue, reservation);
  clock.setTime(5_009);
  assert.deepEqual(ids(queue.getState().delivered), ['event-a']);

  clock.setTime(5_010);
  assert.equal(queue.size(), 0);
});

test('repeated ACK does not extend delivered retention', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    terminalRetentionMs: 10,
  });
  const reservation = deliver(queue, independentEvent('event-a'));

  clock.setTime(1_009);
  const repeated = acknowledge(queue, reservation);
  assert.equal(repeated.acknowledged, true);
  assert.equal(repeated.alreadyAcknowledged, true);

  clock.setTime(1_010);
  assert.deepEqual(acknowledge(queue, reservation), {
    acknowledged: false,
    reason: 'unknown_event',
  });
});

test('duplicate enqueue does not extend terminal retention', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    terminalRetentionMs: 10,
  });
  const event = independentEvent('event-a');
  deliver(queue, event);

  clock.setTime(1_009);
  const duplicate = queue.enqueue(event);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.status, 'delivered');

  clock.setTime(1_010);
  const reenqueued = queue.enqueue(event);
  assert.equal(reenqueued.enqueued, true);
  assert.equal(reenqueued.duplicate, false);
  assert.deepEqual(ids(queue.getState().pending), ['event-a']);
});

test('superseded entries retain from their transition time then expire', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    terminalRetentionMs: 10,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));

  clock.setTime(1_004);
  queue.enqueue(stateEvent({ id: 'event-b' }));
  clock.setTime(1_013);
  assert.deepEqual(ids(queue.getState().superseded), ['event-a']);

  clock.setTime(1_014);
  const state = queue.getState();
  assert.deepEqual(state.superseded, []);
  assert.deepEqual(ids(state.pending), ['event-b']);
});

test('lease-expired superseded entries record terminalAt at lease expiry cleanup', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 5,
    terminalRetentionMs: 10,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));
  queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));

  clock.setTime(1_005);
  assert.deepEqual(ids(queue.getState().superseded), ['event-a']);
  clock.setTime(1_014);
  assert.deepEqual(ids(queue.getState().superseded), ['event-a']);

  clock.setTime(1_015);
  assert.deepEqual(queue.getState().superseded, []);
});

test('released superseded entries record terminalAt at release time', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 100,
    terminalRetentionMs: 10,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const older = queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));

  clock.setTime(1_005);
  release(queue, older);
  clock.setTime(1_014);
  assert.deepEqual(ids(queue.getState().superseded), ['event-a']);

  clock.setTime(1_015);
  assert.deepEqual(queue.getState().superseded, []);
  assert.deepEqual(ids(queue.getState().pending), ['event-b']);
});

test('terminal capacity evicts the oldest terminalAt first', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    terminalRetentionMs: 10_000,
    maxTerminalEntries: 2,
  });
  deliver(queue, independentEvent('event-a'));
  clock.setTime(1_001);
  deliver(queue, independentEvent('event-b'));
  clock.setTime(1_002);
  deliver(queue, independentEvent('event-c'));

  assert.deepEqual(ids(queue.getState().delivered), ['event-b', 'event-c']);
  assert.equal(queue.size(), 2);
});

test('delivered and superseded entries share one capacity limit', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    terminalRetentionMs: 10_000,
    maxTerminalEntries: 2,
  });
  deliver(queue, independentEvent('delivered-old'));

  clock.setTime(1_001);
  queue.enqueue(stateEvent({
    id: 'superseded',
    stateKey: 'kugou:shared:track',
    deviceId: 'shared',
  }));
  queue.enqueue(stateEvent({
    id: 'shared-pending',
    stateKey: 'kugou:shared:track',
    deviceId: 'shared',
  }));

  clock.setTime(1_002);
  deliver(queue, independentEvent('delivered-new'));
  const state = queue.getState();

  assert.deepEqual(ids(state.delivered), ['delivered-new']);
  assert.deepEqual(ids(state.superseded), ['superseded']);
  assert.deepEqual(ids(state.pending), ['shared-pending']);
  assert.equal(queue.size(), 3);
});

test('capacity eviction is stable when terminalAt values are equal', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    terminalRetentionMs: 10_000,
    maxTerminalEntries: 2,
  });
  queue.enqueue(independentEvent('event-a'));
  queue.enqueue(independentEvent('event-b'));
  queue.enqueue(independentEvent('event-c'));
  const eventA = queue.reserveNext({ deviceId: 'event-a' });
  const eventB = queue.reserveNext({ deviceId: 'event-b' });
  const eventC = queue.reserveNext({ deviceId: 'event-c' });

  acknowledge(queue, eventB);
  acknowledge(queue, eventA);
  acknowledge(queue, eventC);

  assert.deepEqual(ids(queue.getState().delivered), ['event-a', 'event-c']);
});

test('pending entries are never removed by terminal TTL', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    terminalRetentionMs: 10,
  });
  queue.enqueue(independentEvent('pending'));

  clock.setTime(10_000);
  assert.deepEqual(ids(queue.getState().pending), ['pending']);
  assert.equal(queue.size(), 1);
});

test('reserved entries are never removed by terminal TTL', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10_000,
    terminalRetentionMs: 10,
  });
  queue.enqueue(independentEvent('reserved'));
  const reservation = queue.reserveNext();

  clock.setTime(2_000);
  assert.deepEqual(ids(queue.getState().reserved), ['reserved']);
  assert.equal(queue.size(), 1);
  release(queue, reservation);
});

test('terminal capacity does not count or reorder active entries', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10_000,
    terminalRetentionMs: 10_000,
    maxTerminalEntries: 1,
  });
  queue.enqueue(independentEvent('pending', 'pending-device'));
  queue.enqueue(independentEvent('reserved', 'reserved-device'));
  const reserved = queue.reserveNext({ deviceId: 'reserved-device' });
  deliver(queue, independentEvent('terminal-old'));
  deliver(queue, independentEvent('terminal-new'));

  const state = queue.getState();
  assert.deepEqual(ids(state.pending), ['pending']);
  assert.deepEqual(ids(state.reserved), ['reserved']);
  assert.deepEqual(ids(state.delivered), ['terminal-new']);
  assert.equal(queue.size(), 3);
  assert.equal(
    queue.reserveNext({ deviceId: 'pending-device' }).event.id,
    'pending',
  );
  release(queue, reserved);
});

test('capacity eviction permits the same eventId to be enqueued again', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    terminalRetentionMs: 10_000,
    maxTerminalEntries: 1,
  });
  const eventA = independentEvent('event-a');
  deliver(queue, eventA);
  clock.setTime(1_001);
  deliver(queue, independentEvent('event-b'));

  const reenqueued = queue.enqueue(eventA);
  assert.equal(reenqueued.enqueued, true);
  assert.equal(reenqueued.duplicate, false);
});

test('TTL cleanup makes old ACK and release unknown without affecting active events', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10_000,
    terminalRetentionMs: 10,
  });
  const old = deliver(queue, independentEvent('old'));
  queue.enqueue(independentEvent('active'));
  const active = queue.reserveNext();

  clock.setTime(1_010);
  assert.deepEqual(acknowledge(queue, old), {
    acknowledged: false,
    reason: 'unknown_event',
  });
  assert.deepEqual(release(queue, old), {
    released: false,
    reason: 'unknown_event',
  });
  assert.deepEqual(ids(queue.getState().reserved), ['active']);
  assert.equal(acknowledge(queue, active).acknowledged, true);
});

test('an old receipt cannot affect a re-enqueued event after cleanup', (t) => {
  const clock = enableLeaseClock(t);
  const receiptUuid = '00000000-0000-4000-8000-00000000000a';
  const queue = new KugouEventQueue({
    now: clock.now,
    createReceiptToken: () => receiptUuid,
    terminalRetentionMs: 10,
  });
  const event = independentEvent('event-a');
  const old = deliver(queue, event);

  clock.setTime(1_010);
  assert.equal(queue.enqueue(event).enqueued, true);
  const current = queue.reserveNext();
  assert.equal(old.receiptToken, `${receiptUuid}:1`);
  assert.equal(current.receiptToken, `${receiptUuid}:2`);
  assert.notEqual(current.receiptToken, old.receiptToken);

  const stale = acknowledge(queue, old);
  assert.equal(stale.acknowledged, false);
  assert.equal(stale.reason, 'stale_reservation');
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);
  assert.equal(acknowledge(queue, current).acknowledged, true);
});

test('cleaning a newer terminal entry cannot revive an older lease', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 20,
    terminalRetentionMs: 5,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const older = queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));
  const newer = queue.reserveNext();
  acknowledge(queue, newer);

  clock.setTime(1_005);
  assert.equal(queue.size(), 1);
  assert.deepEqual(ids(queue.getState().reserved), ['event-a']);

  clock.setTime(1_020);
  const state = queue.getState();
  assert.deepEqual(state.pending, []);
  assert.deepEqual(ids(state.superseded), ['event-a']);
  assert.equal(acknowledge(queue, older).reason, 'stale_reservation');
});

test('capacity-cleaned newer state cannot make an older release pending', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    terminalRetentionMs: 10_000,
    maxTerminalEntries: 1,
  });
  queue.enqueue(stateEvent({ id: 'event-a' }));
  const older = queue.reserveNext();
  queue.enqueue(stateEvent({ id: 'event-b' }));
  acknowledge(queue, queue.reserveNext());
  deliver(queue, independentEvent('capacity-evictor'));

  assert.deepEqual(queue.ack('event-b', 'old-token'), {
    acknowledged: false,
    reason: 'unknown_event',
  });
  const released = release(queue, older);
  assert.equal(released.released, true);
  assert.equal(released.status, 'superseded');
  assert.deepEqual(queue.getState().pending, []);
  assert.deepEqual(ids(queue.getState().superseded), ['event-a']);
});

test('size and getState expose only active entries after terminal cleanup', (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    reservationLeaseMs: 10_000,
    terminalRetentionMs: 10,
  });
  deliver(queue, independentEvent('delivered'));
  queue.enqueue(stateEvent({
    id: 'superseded',
    stateKey: 'kugou:shared:playback',
    deviceId: 'shared',
  }));
  queue.enqueue(stateEvent({
    id: 'pending',
    stateKey: 'kugou:shared:playback',
    deviceId: 'shared',
  }));
  queue.enqueue(independentEvent('reserved'));
  const reserved = queue.reserveNext({ deviceId: 'reserved' });

  clock.setTime(1_010);
  assert.equal(queue.size(), 2);
  const state = queue.getState();
  assert.deepEqual(ids(state.pending), ['pending']);
  assert.deepEqual(ids(state.reserved), ['reserved']);
  assert.deepEqual(state.delivered, []);
  assert.deepEqual(state.superseded, []);
  release(queue, reserved);
});

test('waitNext prunes terminal entries before an already-aborted rejection', async (t) => {
  const clock = enableLeaseClock(t);
  const queue = new KugouEventQueue({
    now: clock.now,
    terminalRetentionMs: 10,
  });
  deliver(queue, independentEvent('event-a'));
  const controller = new AbortController();
  controller.abort();

  clock.setTime(1_010);
  await assert.rejects(
    queue.waitNext({ signal: controller.signal }),
    isAbortError,
  );

  clock.setTime(1_000);
  assert.equal(queue.size(), 0);
});
