import { randomUUID } from 'node:crypto';

export const KUGOU_ACTIONS = Object.freeze(['toggle', 'next', 'previous']);
export const KUGOU_ACK_RESULTS = Object.freeze([
  'succeeded',
  'failed',
  'outcome_unknown',
]);
export const LEGACY_KUGOU_DEVICE = Object.freeze({
  deviceId: 'pc-mumu',
  deviceName: 'Lucy-PC-MuMu',
  deviceType: 'windows_mumu',
});

const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEVICE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_OFFLINE_AFTER_MS = 15_000;
const DEFAULT_COMMAND_TTL_MS = 30_000;
const DEFAULT_MAX_PENDING_COMMANDS = 20;
const DEFAULT_TERMINAL_RETENTION_MS = 5 * 60_000;

export class KugouBridgeError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'KugouBridgeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeDevice(device) {
  if (
    !device ||
    typeof device !== 'object' ||
    !DEVICE_ID_PATTERN.test(device.deviceId ?? '') ||
    typeof device.deviceName !== 'string' ||
    device.deviceName.length < 1 ||
    device.deviceName.length > 80 ||
    !DEVICE_TYPE_PATTERN.test(device.deviceType ?? '')
  ) {
    throw new Error('酷狗设备配置无效。');
  }
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    deviceType: device.deviceType,
  };
}

function createDeviceRuntime(device) {
  return {
    ...normalizeDevice(device),
    latestStatus: null,
    retiredAgentInstances: new Set(),
    commands: [],
  };
}

function publicCommand(command) {
  return {
    id: command.id,
    device_id: command.deviceId,
    action: command.action,
    status: command.status,
    created_at: new Date(command.createdAt).toISOString(),
    expires_at: new Date(command.expiresAt).toISOString(),
    ...(command.result ? { result: command.result } : {}),
  };
}

export class KugouBridge {
  #eventAdapter;
  #eventQueue;
  #onEventError;

  constructor({
    controlEnabled = false,
    devices = [LEGACY_KUGOU_DEVICE],
    activeDeviceId = LEGACY_KUGOU_DEVICE.deviceId,
    now = () => Date.now(),
    uuid = randomUUID,
    offlineAfterMs = DEFAULT_OFFLINE_AFTER_MS,
    commandTtlMs = DEFAULT_COMMAND_TTL_MS,
    maxPendingCommands = DEFAULT_MAX_PENDING_COMMANDS,
    terminalRetentionMs = DEFAULT_TERMINAL_RETENTION_MS,
    eventAdapter,
    eventQueue,
    onEventError,
  } = {}) {
    if ((eventAdapter == null) !== (eventQueue == null)) {
      throw new TypeError('eventAdapter and eventQueue must be provided together.');
    }
    if (
      eventAdapter != null &&
      (typeof eventAdapter.accept !== 'function' ||
        typeof eventQueue.enqueue !== 'function')
    ) {
      throw new TypeError('eventAdapter.accept and eventQueue.enqueue must be functions.');
    }
    if (onEventError !== undefined && typeof onEventError !== 'function') {
      throw new TypeError('onEventError must be a function.');
    }
    if (!Array.isArray(devices) || devices.length < 1) {
      throw new Error('至少需要配置一个酷狗设备。');
    }
    this.devices = new Map();
    for (const device of devices) {
      const runtime = createDeviceRuntime(device);
      if (this.devices.has(runtime.deviceId)) {
        throw new Error(`酷狗设备 ID 重复：${runtime.deviceId}`);
      }
      this.devices.set(runtime.deviceId, runtime);
    }
    if (!this.devices.has(activeDeviceId)) {
      throw new Error(`活动酷狗设备不存在：${activeDeviceId}`);
    }

    this.activeDeviceId = activeDeviceId;
    this.controlEnabled = Boolean(controlEnabled);
    this.now = now;
    this.uuid = uuid;
    this.offlineAfterMs = offlineAfterMs;
    this.commandTtlMs = commandTtlMs;
    this.maxPendingCommands = maxPendingCommands;
    this.terminalRetentionMs = terminalRetentionMs;
    this.#eventAdapter = eventAdapter;
    this.#eventQueue = eventQueue;
    this.#onEventError = onEventError;
  }

  serverTime() {
    return new Date(this.now()).toISOString();
  }

  hasDevice(deviceId) {
    return this.devices.has(deviceId);
  }

  getDeviceIdentity(deviceId) {
    const device = this.getDeviceRuntime(deviceId);
    return {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      deviceType: device.deviceType,
    };
  }

  getDeviceRuntime(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new KugouBridgeError('device_not_found', '酷狗设备不存在。', 404);
    }
    return device;
  }

  cleanup(deviceId) {
    const device = this.getDeviceRuntime(deviceId);
    const now = this.now();
    for (const command of device.commands) {
      if (
        ['queued', 'claimed'].includes(command.status) &&
        now >= command.expiresAt
      ) {
        command.status = 'expired';
        command.terminalAt = now;
      }
    }
    device.commands = device.commands.filter(
      (command) =>
        command.terminalAt === undefined ||
        now - command.terminalAt < this.terminalRetentionMs,
    );
    return device;
  }

  recordStatus(deviceId, report) {
    const device = this.cleanup(deviceId);
    const previousStatus = device.latestStatus;
    if (device.retiredAgentInstances.has(report.agent_instance_id)) {
      return { accepted: false, reason: 'retired_agent_instance' };
    }
    if (previousStatus?.agent_instance_id === report.agent_instance_id) {
      if (report.sequence <= previousStatus.sequence) {
        return { accepted: false, reason: 'stale_sequence' };
      }
    } else if (previousStatus) {
      device.retiredAgentInstances.add(previousStatus.agent_instance_id);
    }

    const receivedAt = this.now();
    const currentStatus = {
      ...report,
      capabilities: [...report.capabilities],
      player: report.player ? { ...report.player } : null,
      receivedAt,
    };
    device.latestStatus = currentStatus;

    if (this.#eventAdapter != null) {
      const context = {
        deviceId: device.deviceId,
        agentInstanceId: currentStatus.agent_instance_id,
        sequence: currentStatus.sequence,
      };
      let events;
      try {
        events = this.#eventAdapter.accept({
          device: {
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            deviceType: device.deviceType,
          },
          previousStatus,
          currentStatus,
          receivedAt,
        });
        if (!Array.isArray(events)) {
          throw new TypeError('eventAdapter.accept must return an array.');
        }
      } catch (error) {
        this.#reportEventError(error, { phase: 'adapter', ...context });
        return { accepted: true };
      }
      for (const event of events) {
        try {
          this.#eventQueue.enqueue(event);
        } catch (error) {
          this.#reportEventError(error, {
            phase: 'enqueue',
            ...context,
            eventId: event?.id,
          });
          break;
        }
      }
    }
    return { accepted: true };
  }

  #reportEventError(error, context) {
    // Until service wiring supplies a handler, event errors stay isolated from status.
    if (!this.#onEventError) return;
    try {
      this.#onEventError(error, context);
    } catch {
      // A failing observer must not interrupt the accepted status report.
    }
  }

  getStatus(deviceId = this.activeDeviceId) {
    const device = this.cleanup(deviceId);
    const deviceFields = {
      device_id: device.deviceId,
      device_name: device.deviceName,
      device_type: device.deviceType,
      active: device.deviceId === this.activeDeviceId,
    };
    if (!device.latestStatus) {
      return {
        ...deviceFields,
        online: false,
        stale: true,
        reason: 'never_seen',
        health: 'unknown',
        control_enabled: this.controlEnabled,
        last_seen_at: null,
        age_ms: null,
        capabilities: [],
        player: null,
      };
    }

    const ageMs = Math.max(0, this.now() - device.latestStatus.receivedAt);
    const online = ageMs <= this.offlineAfterMs;
    return {
      ...deviceFields,
      online,
      stale: !online,
      reason: online ? null : 'heartbeat_timeout',
      health: device.latestStatus.health,
      control_enabled: this.controlEnabled,
      last_seen_at: new Date(device.latestStatus.receivedAt).toISOString(),
      age_ms: ageMs,
      agent_instance_id: device.latestStatus.agent_instance_id,
      sequence: device.latestStatus.sequence,
      observed_at: device.latestStatus.observed_at,
      capabilities: [...device.latestStatus.capabilities],
      player: device.latestStatus.player ? { ...device.latestStatus.player } : null,
      ...(device.latestStatus.error ? { error: { ...device.latestStatus.error } } : {}),
    };
  }

  enqueueCommand(action, deviceId = this.activeDeviceId) {
    const device = this.cleanup(deviceId);
    if (!KUGOU_ACTIONS.includes(action)) {
      throw new KugouBridgeError(
        'invalid_action',
        'action 仅允许 toggle、next、previous。',
      );
    }
    if (!this.controlEnabled) {
      throw new KugouBridgeError(
        'control_disabled',
        '酷狗设备控制当前未启用。',
        503,
      );
    }

    const status = this.getStatus(deviceId);
    if (!status.online) {
      throw new KugouBridgeError('device_offline', '酷狗设备当前离线。', 409);
    }
    if (status.health !== 'ok' || !status.player) {
      throw new KugouBridgeError(
        'device_degraded',
        '酷狗设备当前不可用于控制。',
        409,
      );
    }
    if (!status.capabilities.includes(action)) {
      throw new KugouBridgeError(
        'capability_missing',
        `酷狗设备未声明 ${action} 能力。`,
        409,
      );
    }

    const pending = device.commands.filter((command) =>
      ['queued', 'claimed'].includes(command.status),
    );
    if (pending.length >= this.maxPendingCommands) {
      throw new KugouBridgeError('queue_full', '酷狗命令队列已满。', 429);
    }

    const now = this.now();
    const command = {
      id: this.uuid(),
      deviceId,
      action,
      status: 'queued',
      createdAt: now,
      expiresAt: now + this.commandTtlMs,
    };
    device.commands.push(command);
    return publicCommand(command);
  }

  claimCommand(deviceId) {
    const device = this.cleanup(deviceId);
    const command = device.commands.find((entry) =>
      ['queued', 'claimed'].includes(entry.status),
    );
    if (!command) return null;
    if (command.status === 'queued') {
      command.status = 'claimed';
      command.claimedAt = this.now();
    }
    return publicCommand(command);
  }

  acknowledgeCommand(deviceId, commandId, result) {
    const device = this.cleanup(deviceId);
    if (!KUGOU_ACK_RESULTS.includes(result)) {
      throw new KugouBridgeError('invalid_ack_result', '命令确认结果无效。');
    }
    const command = device.commands.find((entry) => entry.id === commandId);
    if (!command || command.deviceId !== deviceId) {
      throw new KugouBridgeError('command_not_found', '命令不存在。', 404);
    }
    if (KUGOU_ACK_RESULTS.includes(command.result)) {
      if (command.result !== result) {
        throw new KugouBridgeError(
          'ack_conflict',
          '命令已经使用不同结果确认。',
          409,
        );
      }
      return publicCommand(command);
    }
    if (command.status === 'expired') {
      throw new KugouBridgeError('command_expired', '命令已经过期。', 410);
    }

    command.status = result;
    command.result = result;
    command.terminalAt = this.now();
    return publicCommand(command);
  }
}
