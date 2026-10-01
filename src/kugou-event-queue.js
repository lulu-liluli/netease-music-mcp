const EVENT_STATUSES = [
  'pending',
  'reserved',
  'delivered',
  'superseded',
];

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

export class KugouEventQueue {
  #entries = new Map();
  #pendingByStateKey = new Map();
  #nextOrder = 0;

  enqueue(event) {
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
    const previousPending = this.#pendingByStateKey.get(stateKey);
    if (previousPending) {
      previousPending.status = 'superseded';
    }

    const entry = {
      event: clone(event),
      status: 'pending',
      stateKey,
      deviceId,
      order: this.#nextOrder++,
    };
    this.#entries.set(eventId, entry);
    this.#pendingByStateKey.set(stateKey, entry);

    return {
      enqueued: true,
      duplicate: false,
      ...eventResult(entry),
    };
  }

  reserveNext(options = {}) {
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

      entry.status = 'reserved';
      if (this.#pendingByStateKey.get(entry.stateKey) === entry) {
        this.#pendingByStateKey.delete(entry.stateKey);
      }
      return clone(entry.event);
    }

    return null;
  }

  ack(eventId) {
    requireNonEmptyString(eventId, 'eventId');
    const entry = this.#entries.get(eventId);
    if (!entry) {
      return {
        acknowledged: false,
        reason: 'unknown_event',
      };
    }
    if (entry.status === 'delivered') {
      return {
        acknowledged: true,
        alreadyAcknowledged: true,
        ...eventResult(entry),
      };
    }
    if (entry.status !== 'reserved') {
      return {
        acknowledged: false,
        reason: 'invalid_state',
        ...eventResult(entry),
      };
    }

    entry.status = 'delivered';
    return {
      acknowledged: true,
      alreadyAcknowledged: false,
      ...eventResult(entry),
    };
  }

  release(eventId) {
    requireNonEmptyString(eventId, 'eventId');
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
        reason: 'invalid_state',
        ...eventResult(entry),
      };
    }

    entry.status = this.#hasNewerState(entry) ? 'superseded' : 'pending';
    if (entry.status === 'pending') {
      this.#pendingByStateKey.set(entry.stateKey, entry);
    }
    return {
      released: true,
      ...eventResult(entry),
    };
  }

  size() {
    return this.#entries.size;
  }

  getState() {
    const state = Object.fromEntries(
      EVENT_STATUSES.map((status) => [status, []]),
    );
    for (const entry of this.#entries.values()) {
      state[entry.status].push(clone(entry.event));
    }
    return state;
  }

  #hasNewerState(entry) {
    for (const candidate of this.#entries.values()) {
      if (
        candidate.stateKey === entry.stateKey &&
        candidate.order > entry.order
      ) {
        return true;
      }
    }
    return false;
  }
}
