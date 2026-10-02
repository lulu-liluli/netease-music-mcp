import { randomUUID } from 'node:crypto';

const EVENT_STATUSES = [
  'pending',
  'reserved',
  'delivered',
  'superseded',
];
const MAX_WAIT_TIMEOUT_MS = 45_000;
const DEFAULT_RESERVATION_LEASE_MS = 60_000;
const DEFAULT_TERMINAL_RETENTION_MS = 300_000;
const DEFAULT_MAX_TERMINAL_ENTRIES = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RECEIPT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function clone(value) {
  return structuredClone(value);
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function eventIdOf(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('event must be an object.');
  }
  return requireNonEmptyString(event.id, 'event.id');
}

function deviceIdOf(event) {
  if (!event.device || typeof event.device !== 'object') {
    throw new TypeError('event.device must be an object.');
  }
  return requireNonEmptyString(
    event.device.id ?? event.device.deviceId,
    'event.device.id',
  );
}

function validateNewEvent(event) {
  if (event.stream !== 'state') {
    throw new TypeError('event.stream must be "state".');
  }
  return {
    stateKey: requireNonEmptyString(event.stateKey, 'event.stateKey'),
    deviceId: deviceIdOf(event),
  };
}

function eventResult(entry) {
  return {
    status: entry.status,
    event: clone(entry.event),
  };
}

function reservationResult(entry) {
  return {
    event: clone(entry.event),
    receiptToken: entry.reservation.receiptToken,
    leaseExpiresAt: entry.reservation.leaseExpiresAt,
  };
}

function abortError() {
  const error = new Error('The wait was aborted.');
  error.name = 'AbortError';
  return error;
}

function validateSignal(signal) {
  if (signal === undefined) {
    return null;
  }
  if (
    !signal ||
    typeof signal !== 'object' ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  ) {
    throw new TypeError('options.signal must be an AbortSignal.');
  }
  return signal;
}

export class KugouEventQueue {
  #entries = new Map();
  #pendingByStateKey = new Map();
  #reservedEntries = new Set();
  #reservedByStateKey = new Map();
  #terminalEntries = new Set();
  #nextOrder = 0;
  #nextTerminalOrder = 0;
  #nextReservationSequence = 0n;
  #waiter = null;
  #leaseTimer = null;
  #leaseTimerAt = null;
  #sweepingLeases = false;
  #now;
  #createReceiptToken;
  #reservationLeaseMs;
  #terminalRetentionMs;
  #maxTerminalEntries;

  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object.');
    }
    const {
      now = () => Date.now(),
      createReceiptToken = randomUUID,
      reservationLeaseMs = DEFAULT_RESERVATION_LEASE_MS,
      terminalRetentionMs = DEFAULT_TERMINAL_RETENTION_MS,
      maxTerminalEntries = DEFAULT_MAX_TERMINAL_ENTRIES,
    } = options;
    if (typeof now !== 'function') {
      throw new TypeError('options.now must be a function.');
    }
    if (typeof createReceiptToken !== 'function') {
      throw new TypeError('options.createReceiptToken must be a function.');
    }
    if (
      !Number.isSafeInteger(reservationLeaseMs) ||
      reservationLeaseMs < 1
    ) {
      throw new RangeError('options.reservationLeaseMs must be a positive integer.');
    }
    if (
      !Number.isSafeInteger(terminalRetentionMs) ||
      terminalRetentionMs < 1
    ) {
      throw new RangeError('options.terminalRetentionMs must be a positive integer.');
    }
    if (
      !Number.isSafeInteger(maxTerminalEntries) ||
      maxTerminalEntries < 1
    ) {
      throw new RangeError('options.maxTerminalEntries must be a positive integer.');
    }

    this.#now = now;
    this.#createReceiptToken = createReceiptToken;
    this.#reservationLeaseMs = reservationLeaseMs;
    this.#terminalRetentionMs = terminalRetentionMs;
    this.#maxTerminalEntries = maxTerminalEntries;
  }

  enqueue(event) {
    const now = this.#currentTime();
    this.#maintain(now);
    const eventId = eventIdOf(event);
    const existing = this.#entries.get(eventId);
    if (existing) {
      return {
        enqueued: false,
        duplicate: true,
        ...eventResult(existing),
      };
    }

    const { stateKey, deviceId } = validateNewEvent(event);
    const reservedForState = this.#reservedByStateKey.get(stateKey);
    if (reservedForState) {
      for (const reservedEntry of reservedForState) {
        reservedEntry.hasNewerState = true;
      }
    }
    const previousPending = this.#pendingByStateKey.get(stateKey);
    if (previousPending) {
      this.#enterTerminal(previousPending, 'superseded', now);
    }

    const entry = {
      event: clone(event),
      status: 'pending',
      stateKey,
      deviceId,
      order: this.#nextOrder++,
      hasNewerState: false,
      hasBeenReserved: false,
      reservation: null,
      completedReceiptToken: null,
      terminalAt: null,
      terminalOrder: null,
    };
    this.#entries.set(eventId, entry);
    this.#pendingByStateKey.set(stateKey, entry);

    const result = {
      enqueued: true,
      duplicate: false,
      ...eventResult(entry),
    };
    this.#wakeWaiter(deviceId);
    return result;
  }

  reserveNext(options = {}) {
    const now = this.#currentTime();
    this.#maintain(now);
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object.');
    }
    const deviceId = options.deviceId === undefined
      ? null
      : requireNonEmptyString(options.deviceId, 'options.deviceId');

    for (const entry of this.#entries.values()) {
      if (
        entry.status !== 'pending' ||
        (deviceId !== null && entry.deviceId !== deviceId)
      ) {
        continue;
      }

      const receiptToken = this.#issueReceiptToken();
      const leaseExpiresAt = now + this.#reservationLeaseMs;
      if (!Number.isFinite(leaseExpiresAt)) {
        throw new RangeError('reservation lease expiry must be finite.');
      }

      entry.status = 'reserved';
      entry.reservation = {
        receiptToken,
        reservedAt: now,
        leaseExpiresAt,
      };
      entry.hasBeenReserved = true;
      entry.completedReceiptToken = null;
      if (this.#pendingByStateKey.get(entry.stateKey) === entry) {
        this.#pendingByStateKey.delete(entry.stateKey);
      }
      this.#trackReserved(entry);
      this.#scheduleLeaseTimer(now);
      return reservationResult(entry);
    }

    return null;
  }

  async waitNext(options = {}) {
    this.#maintain(this.#currentTime());
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object.');
    }
    const deviceId = options.deviceId === undefined
      ? null
      : requireNonEmptyString(options.deviceId, 'options.deviceId');
    const timeoutMs = options.timeoutMs === undefined
      ? 30_000
      : options.timeoutMs;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_WAIT_TIMEOUT_MS
    ) {
      throw new RangeError(
        `options.timeoutMs must be an integer between 1 and ${MAX_WAIT_TIMEOUT_MS}.`,
      );
    }
    const signal = validateSignal(options.signal);
    if (signal?.aborted) {
      throw abortError();
    }
    if (this.#waiter) {
      throw new Error('KugouEventQueue already has an active waiter.');
    }

    const reserveOptions = deviceId === null ? {} : { deviceId };
    const available = this.reserveNext(reserveOptions);
    if (available) {
      if (signal?.aborted) {
        this.release(available.event.id, available.receiptToken);
        throw abortError();
      }
      return available;
    }
    if (signal?.aborted) {
      throw abortError();
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        deviceId,
        signal,
        resolve,
        reject,
        timer: null,
        onAbort: null,
        abortListenerAttached: false,
        settled: false,
      };
      const onAbort = () => {
        this.#settleWaiter(waiter, { error: abortError() });
      };
      waiter.onAbort = onAbort;

      this.#waiter = waiter;
      waiter.timer = setTimeout(() => {
        this.#settleWaiter(waiter, { value: null });
      }, timeoutMs);
      if (signal) {
        waiter.abortListenerAttached = true;
        try {
          signal.addEventListener('abort', onAbort, { once: true });
        } catch (error) {
          this.#settleWaiter(waiter, { error });
          return;
        }
        if (signal.aborted) {
          onAbort();
        }
      }

      // Close the gap between the initial empty check and waiter registration.
      this.#deliverToWaiter(waiter);
    });
  }

  ack(eventId, receiptToken) {
    requireNonEmptyString(eventId, 'eventId');
    const now = this.#currentTime();
    this.#maintain(now);
    if (typeof receiptToken !== 'string' || receiptToken.length === 0) {
      return {
        acknowledged: false,
        reason: 'reservation_required',
      };
    }
    const entry = this.#entries.get(eventId);
    if (!entry) {
      return {
        acknowledged: false,
        reason: 'unknown_event',
      };
    }
    if (entry.status === 'delivered') {
      if (entry.completedReceiptToken !== receiptToken) {
        return {
          acknowledged: false,
          reason: 'stale_reservation',
          ...eventResult(entry),
        };
      }
      return {
        acknowledged: true,
        alreadyAcknowledged: true,
        ...eventResult(entry),
      };
    }
    if (entry.status !== 'reserved') {
      return {
        acknowledged: false,
        reason: entry.hasBeenReserved
          ? 'stale_reservation'
          : 'invalid_state',
        ...eventResult(entry),
      };
    }
    if (entry.reservation.receiptToken !== receiptToken) {
      return {
        acknowledged: false,
        reason: 'stale_reservation',
        ...eventResult(entry),
      };
    }

    this.#untrackReserved(entry);
    entry.completedReceiptToken = receiptToken;
    entry.reservation = null;
    this.#enterTerminal(entry, 'delivered', now);
    this.#scheduleLeaseTimer(now);
    return {
      acknowledged: true,
      alreadyAcknowledged: false,
      ...eventResult(entry),
    };
  }

  release(eventId, receiptToken) {
    requireNonEmptyString(eventId, 'eventId');
    const now = this.#currentTime();
    this.#maintain(now);
    if (typeof receiptToken !== 'string' || receiptToken.length === 0) {
      return {
        released: false,
        reason: 'reservation_required',
      };
    }
    const entry = this.#entries.get(eventId);
    if (!entry) {
      return {
        released: false,
        reason: 'unknown_event',
      };
    }
    if (entry.status !== 'reserved') {
      return {
        released: false,
        reason: entry.hasBeenReserved
          ? 'stale_reservation'
          : 'invalid_state',
        ...eventResult(entry),
      };
    }
    if (entry.reservation.receiptToken !== receiptToken) {
      return {
        released: false,
        reason: 'stale_reservation',
        ...eventResult(entry),
      };
    }

    this.#untrackReserved(entry);
    entry.reservation = null;
    if (entry.hasNewerState) {
      this.#enterTerminal(entry, 'superseded', now);
    } else {
      entry.status = 'pending';
      this.#pendingByStateKey.set(entry.stateKey, entry);
    }
    const result = {
      released: true,
      ...eventResult(entry),
    };
    this.#scheduleLeaseTimer(now);
    if (entry.status === 'pending') {
      this.#wakeWaiter(entry.deviceId);
    }
    return result;
  }

  size() {
    this.#maintain(this.#currentTime());
    return this.#entries.size;
  }

  getState() {
    this.#maintain(this.#currentTime());
    const state = Object.fromEntries(
      EVENT_STATUSES.map((status) => [status, []]),
    );
    for (const entry of this.#entries.values()) {
      state[entry.status].push(clone(entry.event));
    }
    return state;
  }

  #wakeWaiter(deviceId) {
    const waiter = this.#waiter;
    if (
      !waiter ||
      (waiter.deviceId !== null && waiter.deviceId !== deviceId)
    ) {
      return;
    }
    this.#deliverToWaiter(waiter);
  }

  #deliverToWaiter(waiter) {
    if (this.#waiter !== waiter || waiter.settled) {
      return;
    }
    const options = waiter.deviceId === null
      ? {}
      : { deviceId: waiter.deviceId };
    const reservation = this.reserveNext(options);
    if (!reservation) {
      return;
    }
    if (!this.#settleWaiter(waiter, { value: reservation })) {
      this.release(
        reservation.event.id,
        reservation.receiptToken,
      );
    }
  }

  #settleWaiter(waiter, { value, error } = {}) {
    if (this.#waiter !== waiter || waiter.settled) {
      return false;
    }

    waiter.settled = true;
    this.#waiter = null;
    if (waiter.timer !== null) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
    }
    if (waiter.signal && waiter.abortListenerAttached) {
      waiter.abortListenerAttached = false;
      try {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      } catch {
        // A malformed signal must not retain the Queue waiter or alter its result.
      }
    }
    waiter.onAbort = null;

    if (error) {
      waiter.reject(error);
    } else {
      waiter.resolve(value);
    }
    return true;
  }

  #currentTime() {
    const now = this.#now();
    if (!Number.isFinite(now)) {
      throw new TypeError('options.now must return a finite number.');
    }
    return now;
  }

  #maintain(now) {
    this.#pruneTerminalEntries(now);
    this.#expireLeases(now);
  }

  #enterTerminal(entry, status, now) {
    if (this.#pendingByStateKey.get(entry.stateKey) === entry) {
      this.#pendingByStateKey.delete(entry.stateKey);
    }
    entry.status = status;
    entry.terminalAt = now;
    entry.terminalOrder = this.#nextTerminalOrder++;
    this.#terminalEntries.add(entry);
    this.#pruneTerminalEntries(now);
  }

  #pruneTerminalEntries(now) {
    for (const entry of [...this.#terminalEntries]) {
      if (now >= entry.terminalAt + this.#terminalRetentionMs) {
        this.#deleteTerminalEntry(entry);
      }
    }

    while (this.#terminalEntries.size > this.#maxTerminalEntries) {
      let oldest = null;
      for (const entry of this.#terminalEntries) {
        if (
          oldest === null ||
          entry.terminalAt < oldest.terminalAt ||
          (
            entry.terminalAt === oldest.terminalAt &&
            entry.terminalOrder < oldest.terminalOrder
          )
        ) {
          oldest = entry;
        }
      }
      this.#deleteTerminalEntry(oldest);
    }
  }

  #deleteTerminalEntry(entry) {
    this.#terminalEntries.delete(entry);
    if (this.#entries.get(entry.event.id) === entry) {
      this.#entries.delete(entry.event.id);
    }
    entry.completedReceiptToken = null;
    entry.terminalAt = null;
    entry.terminalOrder = null;
  }

  #issueReceiptToken() {
    const receiptUuid = requireNonEmptyString(
      this.#createReceiptToken(),
      'createReceiptToken result',
    );
    if (!RECEIPT_UUID_PATTERN.test(receiptUuid)) {
      throw new TypeError('createReceiptToken must return a UUID v4.');
    }
    this.#nextReservationSequence += 1n;
    return `${receiptUuid}:${this.#nextReservationSequence}`;
  }

  #trackReserved(entry) {
    this.#reservedEntries.add(entry);
    let entries = this.#reservedByStateKey.get(entry.stateKey);
    if (!entries) {
      entries = new Set();
      this.#reservedByStateKey.set(entry.stateKey, entries);
    }
    entries.add(entry);
  }

  #untrackReserved(entry) {
    this.#reservedEntries.delete(entry);
    const entries = this.#reservedByStateKey.get(entry.stateKey);
    if (!entries) return;
    entries.delete(entry);
    if (entries.size === 0) {
      this.#reservedByStateKey.delete(entry.stateKey);
    }
  }

  #expireLeases(now) {
    if (this.#sweepingLeases) return;

    const wakeDeviceIds = new Set();
    this.#sweepingLeases = true;
    try {
      for (const entry of [...this.#reservedEntries]) {
        if (
          !entry.reservation ||
          now < entry.reservation.leaseExpiresAt
        ) {
          continue;
        }

        this.#untrackReserved(entry);
        entry.reservation = null;
        if (entry.hasNewerState) {
          this.#enterTerminal(entry, 'superseded', now);
        } else {
          entry.status = 'pending';
          this.#pendingByStateKey.set(entry.stateKey, entry);
          wakeDeviceIds.add(entry.deviceId);
        }
      }
    } finally {
      this.#sweepingLeases = false;
    }

    this.#scheduleLeaseTimer(now);
    for (const deviceId of wakeDeviceIds) {
      this.#wakeWaiter(deviceId);
    }
  }

  #scheduleLeaseTimer(now) {
    let earliestExpiry = null;
    for (const entry of this.#reservedEntries) {
      const expiry = entry.reservation?.leaseExpiresAt;
      if (
        expiry !== undefined &&
        (earliestExpiry === null || expiry < earliestExpiry)
      ) {
        earliestExpiry = expiry;
      }
    }

    if (earliestExpiry === null) {
      if (this.#leaseTimer !== null) {
        clearTimeout(this.#leaseTimer);
      }
      this.#leaseTimer = null;
      this.#leaseTimerAt = null;
      return;
    }
    if (
      this.#leaseTimer !== null &&
      this.#leaseTimerAt === earliestExpiry
    ) {
      return;
    }
    if (this.#leaseTimer !== null) {
      clearTimeout(this.#leaseTimer);
    }

    const delay = Math.min(
      Math.max(0, earliestExpiry - now),
      MAX_TIMER_DELAY_MS,
    );
    const timer = setTimeout(() => {
      if (this.#leaseTimer !== timer) return;
      this.#leaseTimer = null;
      this.#leaseTimerAt = null;
      this.#expireLeases(this.#currentTime());
    }, delay);
    timer?.unref?.();
    this.#leaseTimer = timer;
    this.#leaseTimerAt = earliestExpiry;
  }
}
