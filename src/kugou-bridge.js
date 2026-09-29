import { randomUUID } from 'node:crypto';

export const KUGOU_ACTIONS = Object.freeze(['toggle', 'next', 'previous']);
export const KUGOU_ACK_RESULTS = Object.freeze([
  'succeeded',
  'failed',
  'outcome_unknown',
]);

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

function publicCommand(command) {
  return {
    id: command.id,
    action: command.action,
    status: command.status,
    created_at: new Date(command.createdAt).toISOString(),
    expires_at: new Date(command.expiresAt).toISOString(),
    ...(command.result ? { result: command.result } : {}),
  };
}

export class KugouBridge {
  constructor({
    controlEnabled = false,
    now = () => Date.now(),
    uuid = randomUUID,
    offlineAfterMs = DEFAULT_OFFLINE_AFTER_MS,
    commandTtlMs = DEFAULT_COMMAND_TTL_MS,
    maxPendingCommands = DEFAULT_MAX_PENDING_COMMANDS,
    terminalRetentionMs = DEFAULT_TERMINAL_RETENTION_MS,
  } = {}) {
    this.controlEnabled = Boolean(controlEnabled);
    this.now = now;
    this.uuid = uuid;
    this.offlineAfterMs = offlineAfterMs;
    this.commandTtlMs = commandTtlMs;
    this.maxPendingCommands = maxPendingCommands;
    this.terminalRetentionMs = terminalRetentionMs;
    this.latestStatus = null;
    this.retiredAgentInstances = new Set();
    this.commands = [];
  }

  serverTime() {
    return new Date(this.now()).toISOString();
  }

  cleanup() {
    const now = this.now();
    for (const command of this.commands) {
      if (
        ['queued', 'claimed'].includes(command.status) &&
        now >= command.expiresAt
      ) {
        command.status = 'expired';
        command.terminalAt = now;
      }
    }
    this.commands = this.commands.filter(
      (command) =>
        command.terminalAt === undefined ||
        now - command.terminalAt < this.terminalRetentionMs,
    );
  }

  recordStatus(report) {
    this.cleanup();
    const current = this.latestStatus;
    if (this.retiredAgentInstances.has(report.agent_instance_id)) {
      return { accepted: false, reason: 'retired_agent_instance' };
    }
    if (current?.agent_instance_id === report.agent_instance_id) {
      if (report.sequence <= current.sequence) {
        return { accepted: false, reason: 'stale_sequence' };
      }
    } else if (current) {
      this.retiredAgentInstances.add(current.agent_instance_id);
    }

    this.latestStatus = {
      ...report,
      capabilities: [...report.capabilities],
      player: report.player ? { ...report.player } : null,
      receivedAt: this.now(),
    };
    return { accepted: true };
  }

  getStatus() {
    this.cleanup();
    if (!this.latestStatus) {
      return {
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

    const ageMs = Math.max(0, this.now() - this.latestStatus.receivedAt);
    const online = ageMs <= this.offlineAfterMs;
    return {
      online,
      stale: !online,
      reason: online ? null : 'heartbeat_timeout',
      health: this.latestStatus.health,
      control_enabled: this.controlEnabled,
      last_seen_at: new Date(this.latestStatus.receivedAt).toISOString(),
      age_ms: ageMs,
      agent_instance_id: this.latestStatus.agent_instance_id,
      sequence: this.latestStatus.sequence,
      observed_at: this.latestStatus.observed_at,
      capabilities: [...this.latestStatus.capabilities],
      player: this.latestStatus.player ? { ...this.latestStatus.player } : null,
      ...(this.latestStatus.error ? { error: { ...this.latestStatus.error } } : {}),
    };
  }

  enqueueCommand(action) {
    this.cleanup();
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

    const status = this.getStatus();
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

    const pending = this.commands.filter((command) =>
      ['queued', 'claimed'].includes(command.status),
    );
    if (pending.length >= this.maxPendingCommands) {
      throw new KugouBridgeError('queue_full', '酷狗命令队列已满。', 429);
    }

    const now = this.now();
    const command = {
      id: this.uuid(),
      action,
      status: 'queued',
      createdAt: now,
      expiresAt: now + this.commandTtlMs,
    };
    this.commands.push(command);
    return publicCommand(command);
  }

  claimCommand() {
    this.cleanup();
    const command = this.commands.find((entry) =>
      ['queued', 'claimed'].includes(entry.status),
    );
    if (!command) return null;
    if (command.status === 'queued') {
      command.status = 'claimed';
      command.claimedAt = this.now();
    }
    return publicCommand(command);
  }

  acknowledgeCommand(commandId, result) {
    this.cleanup();
    if (!KUGOU_ACK_RESULTS.includes(result)) {
      throw new KugouBridgeError('invalid_ack_result', '命令确认结果无效。');
    }
    const command = this.commands.find((entry) => entry.id === commandId);
    if (!command) {
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
