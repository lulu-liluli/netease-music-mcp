import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import {
  KUGOU_ACK_RESULTS,
  LEGACY_KUGOU_DEVICE,
  KugouBridgeError,
} from './kugou-bridge.js';

export const KUGOU_AGENT_MAX_BODY_BYTES = 16 * 1024;
export const KUGOU_DEVICES_CONFIG_MAX_BYTES = 64 * 1024;
export const KUGOU_DEVICES_CONFIG_MAX_DEVICES = 32;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{43,256}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;
const CAPABILITIES = new Set(['status', 'toggle', 'next', 'previous']);
const PLAYBACK_STATES = new Set([
  'none',
  'stopped',
  'paused',
  'playing',
  'fast_forwarding',
  'rewinding',
  'buffering',
  'error',
  'connecting',
  'unknown',
]);
const CONFIG_ROOT_KEYS = new Set(['version', 'devices']);
const CONFIG_DEVICE_KEYS = new Set([
  'device_id',
  'device_name',
  'device_type',
  'token_file',
]);
const INLINE_CREDENTIAL_KEYS = new Set([
  'token',
  'secret',
  'password',
  'authorization',
]);

class AgentApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'AgentApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function jsonResponse(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function emptyResponse(status, extraHeaders = {}) {
  return new Response(null, {
    status,
    headers: { 'cache-control': 'no-store', ...extraHeaders },
  });
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentApiError(400, 'invalid_request', `${name} 必须是对象。`);
  }
}

function assertKeys(value, allowed, required = []) {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) {
    throw new AgentApiError(400, 'invalid_request', '请求包含未知字段。');
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new AgentApiError(400, 'invalid_request', '请求缺少必要字段。');
  }
}

function assertString(value, name, maxLength, { pattern } = {}) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    (pattern && !pattern.test(value))
  ) {
    throw new AgentApiError(400, 'invalid_request', `${name} 无效。`);
  }
  return value;
}

function assertTimestamp(value, name) {
  assertString(value, name, 40);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new AgentApiError(400, 'invalid_request', `${name} 无效。`);
  }
  return value;
}

function validatePlayer(value) {
  assertPlainObject(value, 'player');
  const allowed = [
    'package',
    'playback_state',
    'state_code',
    'title',
    'artist',
    'album',
    'position_ms',
  ];
  assertKeys(value, allowed, allowed);
  if (value.package !== 'com.kugou.android.lite') {
    throw new AgentApiError(400, 'invalid_request', 'player.package 无效。');
  }
  if (!PLAYBACK_STATES.has(value.playback_state)) {
    throw new AgentApiError(400, 'invalid_request', 'player.playback_state 无效。');
  }
  if (!Number.isInteger(value.state_code) || value.state_code < 0 || value.state_code > 100) {
    throw new AgentApiError(400, 'invalid_request', 'player.state_code 无效。');
  }
  for (const name of ['title', 'artist', 'album']) {
    if (typeof value[name] !== 'string' || value[name].length > 512) {
      throw new AgentApiError(400, 'invalid_request', `player.${name} 无效。`);
    }
  }
  if (
    !Number.isSafeInteger(value.position_ms) ||
    value.position_ms < 0 ||
    value.position_ms > 7 * 24 * 60 * 60 * 1000
  ) {
    throw new AgentApiError(400, 'invalid_request', 'player.position_ms 无效。');
  }
  return { ...value };
}

function validateStatus(payload) {
  assertPlainObject(payload, '请求');
  assertKeys(
    payload,
    [
      'protocol_version',
      'agent_instance_id',
      'sequence',
      'observed_at',
      'health',
      'capabilities',
      'player',
      'error',
    ],
    [
      'protocol_version',
      'agent_instance_id',
      'sequence',
      'observed_at',
      'health',
      'capabilities',
      'player',
    ],
  );
  if (payload.protocol_version !== 1) {
    throw new AgentApiError(400, 'invalid_request', 'protocol_version 无效。');
  }
  assertString(payload.agent_instance_id, 'agent_instance_id', 36, {
    pattern: UUID_PATTERN,
  });
  if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 0) {
    throw new AgentApiError(400, 'invalid_request', 'sequence 无效。');
  }
  assertTimestamp(payload.observed_at, 'observed_at');
  if (!['ok', 'degraded'].includes(payload.health)) {
    throw new AgentApiError(400, 'invalid_request', 'health 无效。');
  }
  if (
    !Array.isArray(payload.capabilities) ||
    payload.capabilities.length < 1 ||
    payload.capabilities.length > CAPABILITIES.size ||
    payload.capabilities.some((item) => typeof item !== 'string' || !CAPABILITIES.has(item)) ||
    new Set(payload.capabilities).size !== payload.capabilities.length ||
    !payload.capabilities.includes('status')
  ) {
    throw new AgentApiError(400, 'invalid_request', 'capabilities 无效。');
  }

  let player = null;
  if (payload.player !== null) player = validatePlayer(payload.player);
  if (payload.health === 'ok' && !player) {
    throw new AgentApiError(400, 'invalid_request', 'health=ok 时必须提供 player。');
  }

  let error;
  if (payload.error !== undefined) {
    assertPlainObject(payload.error, 'error');
    assertKeys(payload.error, ['code'], ['code']);
    error = {
      code: assertString(payload.error.code, 'error.code', 64, {
        pattern: ERROR_CODE_PATTERN,
      }),
    };
  }
  if (payload.health === 'degraded' && !error) {
    throw new AgentApiError(400, 'invalid_request', 'degraded 状态必须提供错误码。');
  }
  if (payload.health === 'ok' && error) {
    throw new AgentApiError(400, 'invalid_request', 'ok 状态不能包含错误码。');
  }

  return {
    protocol_version: 1,
    agent_instance_id: payload.agent_instance_id,
    sequence: payload.sequence,
    observed_at: payload.observed_at,
    health: payload.health,
    capabilities: [...payload.capabilities],
    player,
    ...(error ? { error } : {}),
  };
}

function validateClaim(payload) {
  assertPlainObject(payload, '请求');
  assertKeys(payload, ['protocol_version']);
  if (payload.protocol_version !== undefined && payload.protocol_version !== 1) {
    throw new AgentApiError(400, 'invalid_request', 'protocol_version 无效。');
  }
}

function validateAck(payload) {
  assertPlainObject(payload, '请求');
  assertKeys(
    payload,
    ['protocol_version', 'result', 'completed_at', 'error'],
    ['protocol_version', 'result', 'completed_at'],
  );
  if (payload.protocol_version !== 1) {
    throw new AgentApiError(400, 'invalid_request', 'protocol_version 无效。');
  }
  if (!KUGOU_ACK_RESULTS.includes(payload.result)) {
    throw new AgentApiError(400, 'invalid_request', 'result 无效。');
  }
  assertTimestamp(payload.completed_at, 'completed_at');
  let error;
  if (payload.error !== undefined) {
    assertPlainObject(payload.error, 'error');
    assertKeys(payload.error, ['code'], ['code']);
    error = {
      code: assertString(payload.error.code, 'error.code', 64, {
        pattern: ERROR_CODE_PATTERN,
      }),
    };
  }
  if (payload.result === 'failed' && !error) {
    throw new AgentApiError(400, 'invalid_request', 'failed 结果必须提供错误码。');
  }
  if (payload.result !== 'failed' && error) {
    throw new AgentApiError(400, 'invalid_request', '当前结果不能包含错误码。');
  }
  return { result: payload.result, ...(error ? { error } : {}) };
}

async function readJson(request, maxBodyBytes, { allowEmpty = false } = {}) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw new AgentApiError(413, 'payload_too_large', '请求体过大。');
  }
  const contentType = String(request.headers.get('content-type') ?? '').split(';')[0];
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBodyBytes) {
    throw new AgentApiError(413, 'payload_too_large', '请求体过大。');
  }
  if (bytes.byteLength === 0 && allowEmpty) return {};
  if (contentType !== 'application/json') {
    throw new AgentApiError(415, 'unsupported_media_type', '必须使用 application/json。');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AgentApiError(400, 'invalid_json', 'JSON 无效。');
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function buildDeviceCredentials(bridge, token, devices) {
  let configuredDevices = devices;
  if (configuredDevices === undefined) {
    if (!TOKEN_PATTERN.test(token ?? '')) {
      throw new Error('缺少有效的酷狗设备 Token。');
    }
    configuredDevices = [{ ...LEGACY_KUGOU_DEVICE, token }];
  } else if (token !== undefined) {
    throw new Error('不能同时配置单设备 Token 和多设备凭据。');
  }
  if (!Array.isArray(configuredDevices) || configuredDevices.length < 1) {
    throw new Error('至少需要配置一个酷狗设备凭据。');
  }

  const deviceIds = new Set();
  const tokens = new Set();
  return configuredDevices.map((device) => {
    const identity = bridge.getDeviceIdentity(device?.deviceId);
    if (
      identity.deviceName !== device.deviceName ||
      identity.deviceType !== device.deviceType ||
      !TOKEN_PATTERN.test(device.token ?? '')
    ) {
      throw new Error('酷狗设备凭据无效。');
    }
    if (deviceIds.has(identity.deviceId)) {
      throw new Error(`酷狗设备凭据 ID 重复：${identity.deviceId}`);
    }
    if (tokens.has(device.token)) {
      throw new Error('酷狗设备 Token 重复。');
    }
    deviceIds.add(identity.deviceId);
    tokens.add(device.token);
    return { identity, tokenDigest: digest(device.token) };
  });
}

export async function readKugouDeviceToken(filePath) {
  if (!filePath) throw new Error('必须配置 KUGOU_DEVICE_TOKEN_FILE。');
  let token;
  try {
    token = (await readFile(filePath, 'utf8')).trim();
  } catch {
    throw new Error('无法读取酷狗设备 Token 文件。');
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('酷狗设备 Token 文件内容无效。');
  }
  return token;
}

function assertConfigObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyConfigKeys(value, allowedKeys, context) {
  for (const key of Object.keys(value)) {
    if (INLINE_CREDENTIAL_KEYS.has(key.toLowerCase())) {
      throw new Error(`${context}不允许内联凭据字段。`);
    }
    if (!allowedKeys.has(key)) {
      throw new Error(`${context}包含未知字段。`);
    }
  }
}

async function readKugouDevicesConfigJson(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('必须配置 KUGOU_DEVICES_CONFIG_FILE。');
  }

  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    throw new Error('无法读取酷狗多设备配置文件。');
  }
  if (!fileStats.isFile() || fileStats.size > KUGOU_DEVICES_CONFIG_MAX_BYTES) {
    throw new Error('酷狗多设备配置文件无效或过大。');
  }

  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    throw new Error('无法读取酷狗多设备配置文件。');
  }
  if (Buffer.byteLength(raw, 'utf8') > KUGOU_DEVICES_CONFIG_MAX_BYTES) {
    throw new Error('酷狗多设备配置文件无效或过大。');
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('酷狗多设备配置文件不是有效 JSON。');
  }
}

export async function readKugouDevicesConfig(filePath) {
  const config = await readKugouDevicesConfigJson(filePath);
  if (!assertConfigObject(config)) {
    throw new Error('酷狗多设备配置必须是对象。');
  }
  assertOnlyConfigKeys(config, CONFIG_ROOT_KEYS, '酷狗多设备配置');
  if (config.version !== 1) {
    throw new Error('酷狗多设备配置 version 必须为 1。');
  }
  if (
    !Array.isArray(config.devices) ||
    config.devices.length < 1 ||
    config.devices.length > KUGOU_DEVICES_CONFIG_MAX_DEVICES
  ) {
    throw new Error('酷狗多设备配置 devices 数量无效。');
  }

  const deviceIds = new Set();
  const tokenFiles = new Set();
  const tokens = new Set();
  const bridgeDevices = [];
  const agentDevices = [];

  for (const device of config.devices) {
    if (!assertConfigObject(device)) {
      throw new Error('酷狗多设备配置中的设备必须是对象。');
    }
    assertOnlyConfigKeys(device, CONFIG_DEVICE_KEYS, '酷狗设备配置');
    if (
      typeof device.device_id !== 'string' ||
      typeof device.device_name !== 'string' ||
      typeof device.device_type !== 'string' ||
      typeof device.token_file !== 'string'
    ) {
      throw new Error('酷狗设备配置字段无效。');
    }
    if (!isAbsolute(device.token_file)) {
      throw new Error('酷狗设备 token_file 必须是绝对路径。');
    }
    if (deviceIds.has(device.device_id)) {
      throw new Error(`酷狗设备 ID 重复：${device.device_id}`);
    }
    if (tokenFiles.has(device.token_file)) {
      throw new Error('酷狗设备 token_file 重复。');
    }

    const token = await readKugouDeviceToken(device.token_file);
    if (tokens.has(token)) {
      throw new Error('酷狗设备 Token 重复。');
    }

    const identity = {
      deviceId: device.device_id,
      deviceName: device.device_name,
      deviceType: device.device_type,
    };
    deviceIds.add(identity.deviceId);
    tokenFiles.add(device.token_file);
    tokens.add(token);
    bridgeDevices.push(identity);
    agentDevices.push({ ...identity, token });
  }

  return { bridgeDevices, agentDevices };
}

export async function loadKugouDeviceRegistration({
  devicesConfigFile,
  deviceTokenFile,
} = {}) {
  const multiDeviceFile = String(devicesConfigFile ?? '').trim();
  const legacyTokenFile = String(deviceTokenFile ?? '').trim();
  if (multiDeviceFile && legacyTokenFile) {
    throw new Error(
      'KUGOU_DEVICES_CONFIG_FILE 与 KUGOU_DEVICE_TOKEN_FILE 不能同时配置。',
    );
  }
  if (multiDeviceFile) {
    return {
      mode: 'multi',
      ...(await readKugouDevicesConfig(multiDeviceFile)),
    };
  }
  if (legacyTokenFile) {
    return {
      mode: 'legacy',
      token: await readKugouDeviceToken(legacyTokenFile),
    };
  }
  throw new Error(
    '启用酷狗设备桥时必须配置 KUGOU_DEVICES_CONFIG_FILE 或 KUGOU_DEVICE_TOKEN_FILE。',
  );
}

export function createKugouAgentApi({
  bridge,
  token,
  devices,
  maxBodyBytes = KUGOU_AGENT_MAX_BODY_BYTES,
  onError = () => console.error('[kugou-agent-api] internal request error'),
} = {}) {
  if (!bridge) throw new Error('缺少 KugouBridge。');
  const credentials = buildDeviceCredentials(bridge, token, devices);

  function authenticateAuthorizationHeader(value) {
    const match = String(value ?? '').match(/^Bearer (.+)$/);
    const supplied = match && TOKEN_PATTERN.test(match[1]) ? match[1] : '';
    const suppliedDigest = digest(supplied);
    let identity = null;
    for (const credential of credentials) {
      if (timingSafeEqual(credential.tokenDigest, suppliedDigest)) {
        identity = credential.identity;
      }
    }
    return identity ? { ...identity } : null;
  }

  function matchesAuthorizationHeader(value) {
    return Boolean(authenticateAuthorizationHeader(value));
  }

  async function fetch(request) {
    const identity = authenticateAuthorizationHeader(
      request.headers.get('authorization'),
    );
    if (!identity) {
      return jsonResponse(
        401,
        { error: 'unauthorized' },
        { 'www-authenticate': 'Bearer realm="kugou-device"' },
      );
    }

    try {
      const { pathname } = new URL(request.url);
      if (pathname === '/agent/v1/status') {
        if (request.method !== 'PUT') {
          return emptyResponse(405, { allow: 'PUT' });
        }
        const report = validateStatus(await readJson(request, maxBodyBytes));
        const result = bridge.recordStatus(identity.deviceId, report);
        return jsonResponse(200, {
          ok: true,
          accepted: result.accepted,
          ...(result.reason ? { reason: result.reason } : {}),
          server_time: bridge.serverTime(),
          offline_after_ms: bridge.offlineAfterMs,
        });
      }

      if (pathname === '/agent/v1/commands/claim') {
        if (request.method !== 'POST') {
          return emptyResponse(405, { allow: 'POST' });
        }
        validateClaim(await readJson(request, maxBodyBytes, { allowEmpty: true }));
        const command = bridge.claimCommand(identity.deviceId);
        return command
          ? jsonResponse(200, { command })
          : emptyResponse(204);
      }

      const ackMatch = pathname.match(
        /^\/agent\/v1\/commands\/([0-9a-f-]{36})\/ack$/i,
      );
      if (ackMatch) {
        if (request.method !== 'POST') {
          return emptyResponse(405, { allow: 'POST' });
        }
        if (!UUID_PATTERN.test(ackMatch[1])) {
          throw new AgentApiError(400, 'invalid_request', 'command id 无效。');
        }
        const acknowledgement = validateAck(await readJson(request, maxBodyBytes));
        const command = bridge.acknowledgeCommand(
          identity.deviceId,
          ackMatch[1],
          acknowledgement.result,
        );
        return jsonResponse(200, { ok: true, command });
      }

      return jsonResponse(404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof AgentApiError || error instanceof KugouBridgeError) {
        return jsonResponse(error.statusCode, {
          error: error.code,
          message: error.message,
        });
      }
      onError(new Error('Kugou Agent API request failed unexpectedly.'));
      return jsonResponse(500, { error: 'internal_error' });
    }
  }

  return {
    fetch,
    authenticateAuthorizationHeader,
    matchesAuthorizationHeader,
    maxBodyBytes,
  };
}
