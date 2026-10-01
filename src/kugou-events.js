import { createHash } from 'node:crypto';

const EVENT_SOURCE = 'kugou.playback';
const EVENT_STREAM = 'state';
const EVENT_SCHEMA_VERSION = 1;
const STABLE_PLAYBACK_STATES = new Set(['playing', 'paused']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeMetadata(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function trackFromStatus(status) {
  const player = status?.player;
  if (!player || typeof player !== 'object') return null;

  const track = {
    title: normalizeMetadata(player.title),
    artist: normalizeMetadata(player.artist),
    album: normalizeMetadata(player.album),
  };
  if (!track.title && !track.artist && !track.album) return null;

  return {
    ...track,
    identity: sha256(JSON.stringify([track.title, track.artist, track.album])),
  };
}

function stablePlaybackState(status) {
  const playbackState = status?.player?.playback_state;
  return STABLE_PLAYBACK_STATES.has(playbackState)
    ? playbackState
    : 'unknown';
}

function normalizeCreatedAt(receivedAt) {
  const date = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('receivedAt must be a valid date or timestamp.');
  }
  return date.toISOString();
}

function normalizeDevice(device) {
  if (!device || typeof device !== 'object' || typeof device.deviceId !== 'string') {
    throw new TypeError('device.deviceId is required.');
  }
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName ?? '',
    deviceType: device.deviceType ?? '',
  };
}

function cursorFromStatus(status) {
  if (
    !status ||
    typeof status.agent_instance_id !== 'string' ||
    !Number.isSafeInteger(status.sequence)
  ) {
    throw new TypeError('currentStatus must contain agent_instance_id and sequence.');
  }
  return {
    agentInstanceId: status.agent_instance_id,
    sequence: status.sequence,
  };
}

function eventId({
  deviceId,
  eventType,
  cursor,
  previousSemanticValue,
  currentSemanticValue,
}) {
  const identity = JSON.stringify([
    'kugou-event-v1',
    deviceId,
    eventType,
    cursor.agentInstanceId,
    cursor.sequence,
    previousSemanticValue,
    currentSemanticValue,
  ]);
  return `kugou:${sha256(identity)}`;
}

function createEvent({
  device,
  currentStatus,
  receivedAt,
  eventType,
  stateKey,
  previous,
  current,
  previousSemanticValue,
  currentSemanticValue,
}) {
  const cursor = cursorFromStatus(currentStatus);
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: eventId({
      deviceId: device.deviceId,
      eventType,
      cursor,
      previousSemanticValue,
      currentSemanticValue,
    }),
    source: EVENT_SOURCE,
    stream: EVENT_STREAM,
    stateKey,
    eventType,
    createdAt: normalizeCreatedAt(receivedAt),
    observedAt: currentStatus.observed_at,
    device: { ...device },
    cursor,
    previous,
    current,
  };
}

export class KugouPlaybackEventAdapter {
  constructor() {
    this.deviceState = new Map();
  }

  accept({ device, previousStatus, currentStatus, receivedAt } = {}) {
    const normalizedDevice = normalizeDevice(device);
    if (!currentStatus || typeof currentStatus !== 'object') {
      throw new TypeError('currentStatus is required.');
    }
    normalizeCreatedAt(receivedAt);

    const previousTrack = trackFromStatus(previousStatus);
    const currentTrack = trackFromStatus(currentStatus);
    const previousPlaybackState = stablePlaybackState(previousStatus);
    const currentPlaybackState = stablePlaybackState(currentStatus);
    const currentAgentInstanceId = currentStatus.agent_instance_id;
    const previousAgentInstanceId = previousStatus?.agent_instance_id;
    let state = this.deviceState.get(normalizedDevice.deviceId);

    const startsNewObservationEpoch =
      previousStatus == null ||
      previousAgentInstanceId !== currentAgentInstanceId ||
      (state && state.agentInstanceId !== currentAgentInstanceId);
    if (startsNewObservationEpoch) {
      state = {
        agentInstanceId: currentAgentInstanceId,
        stablePlaybackState:
          currentPlaybackState === 'unknown' ? null : currentPlaybackState,
      };
      this.deviceState.set(normalizedDevice.deviceId, state);
      return [];
    }
    if (!state) {
      state = {
        agentInstanceId: currentAgentInstanceId,
        stablePlaybackState:
          previousPlaybackState === 'unknown' ? null : previousPlaybackState,
      };
      this.deviceState.set(normalizedDevice.deviceId, state);
    }

    const events = [];
    if (
      previousTrack &&
      currentTrack &&
      previousTrack.identity !== currentTrack.identity
    ) {
      events.push(
        createEvent({
          device: normalizedDevice,
          currentStatus,
          receivedAt,
          eventType: 'track_changed',
          stateKey: `kugou:${normalizedDevice.deviceId}:track`,
          previous: { track: { ...previousTrack } },
          current: { track: { ...currentTrack } },
          previousSemanticValue: previousTrack.identity,
          currentSemanticValue: currentTrack.identity,
        }),
      );
    }

    const effectivePreviousPlaybackState =
      previousPlaybackState === 'unknown'
        ? state.stablePlaybackState
        : previousPlaybackState;
    if (
      currentPlaybackState !== 'unknown' &&
      effectivePreviousPlaybackState &&
      effectivePreviousPlaybackState !== currentPlaybackState
    ) {
      const eventType =
        currentPlaybackState === 'paused'
          ? 'playback_paused'
          : 'playback_resumed';
      events.push(
        createEvent({
          device: normalizedDevice,
          currentStatus,
          receivedAt,
          eventType,
          stateKey: `kugou:${normalizedDevice.deviceId}:playback`,
          previous: { playbackState: effectivePreviousPlaybackState },
          current: { playbackState: currentPlaybackState },
          previousSemanticValue: effectivePreviousPlaybackState,
          currentSemanticValue: currentPlaybackState,
        }),
      );
    }
    if (currentPlaybackState !== 'unknown') {
      state.stablePlaybackState = currentPlaybackState;
    }

    return events;
  }
}
