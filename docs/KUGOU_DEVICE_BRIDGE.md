# Kugou device bridge

This optional bridge connects the personal remote MCP service to trusted Kugou
devices. The server keeps status, agent instance lifecycle and commands in
per-device in-memory state. The legacy deployment mode remains backward
compatible and registers only `pc-mumu` (`Lucy-PC-MuMu`, type
`windows_mumu`). The static multi-device mode can additionally register a
phone while keeping `pc-mumu` active.

## Trust boundaries

There are two independent credential layers:

1. OAuth and Personal Access Tokens authorize owner-facing MCP and `/api/v1`
   calls.
2. A per-device Bearer token authorizes only `/agent/v1` calls from its bound
   agent identity.

Device tokens cannot authorize MCP or user REST operations. OAuth and Personal
Access Tokens cannot authorize agent routes. Tokens are read from secret files;
no plaintext-token environment variable or inline JSON token is supported.

The Windows agent initiates every HTTPS connection. The cloud service never
connects to MuMu, Windows or `127.0.0.1:7555`.

## Ubuntu cloud deployment

The base deployment continues to use `compose.yaml`. It retains the existing
`/data` volume and does not enable the Kugou bridge. On an Ubuntu or Aliyun
cloud server, enable the bridge with the optional `compose.kugou.yaml` overlay:

```bash
docker compose -f compose.yaml -f compose.kugou.yaml up -d --build
```

The host environment contains only non-secret paths and flags:

```dotenv
KUGOU_CONTROL_ENABLED=0
KUGOU_ACTIVE_DEVICE_ID=pc-mumu
KUGOU_DEVICE_TOKEN_FILE_HOST=/opt/music-bridge/secrets/kugou-device.secret
KUGOU_PHONE_DEVICE_TOKEN_FILE_HOST=/opt/music-bridge/secrets/kugou-phone.secret
KUGOU_DEVICES_CONFIG_FILE_HOST=/opt/music-bridge/config/kugou-devices.json
```

The two Token variables are host file paths, not Token values. The files must
already exist and remain outside Git. Compose exposes them read-only inside the
container as `/run/secrets/kugou-pc.secret` and
`/run/secrets/kugou-phone.secret`. The configuration file is mounted read-only
at `/run/config/kugou-devices.json`.

The host configuration file contains identities and container paths only:

```json
{
  "version": 1,
  "devices": [
    {
      "device_id": "pc-mumu",
      "device_name": "Lucy-PC-MuMu",
      "device_type": "windows_mumu",
      "token_file": "/run/secrets/kugou-pc.secret"
    },
    {
      "device_id": "phone",
      "device_name": "Lucy-Phone",
      "device_type": "android",
      "token_file": "/run/secrets/kugou-phone.secret"
    }
  ]
}
```

The JSON file must never contain Token values. `version` must be `1`; only the
four documented device fields are accepted. Device IDs, Token file paths and
actual Token values must each be unique, and `token_file` must be absolute.
The active device must be present in the configured device list. Keep
`KUGOU_ACTIVE_DEVICE_ID=pc-mumu` until the phone agent is ready; registering an
offline phone does not affect PC status or control and never triggers fallback.

The first deployment must keep `KUGOU_CONTROL_ENABLED=0`. Verify authenticated
status reporting, online/offline transitions and `kugou_status` before enabling
control and recreating the container.

The server also retains the legacy startup mode. When
`KUGOU_DEVICES_CONFIG_FILE` is absent and only `KUGOU_DEVICE_TOKEN_FILE` is
present, that token is bound to `pc-mumu` exactly as before. Setting both
variables, or setting neither while the bridge is enabled, is a startup error.

This overlay is only for the Ubuntu cloud server. Do not use it to run or
configure the Windows agent; the agent follows `windows-agent/README.md` and
reads its own local Token file.

Without the overlay, the bridge remains disabled, so the Kugou MCP tools, user
REST paths, OpenAPI operations and agent API are absent. With the overlay and
control disabled, status reporting and reading work, but no command can be
created.

## Agent protocol

Every response uses `Cache-Control: no-store`. Agent routes do not enable
CORS. Bodies are limited to 16 KiB and reject unknown fields.

### `PUT /agent/v1/status`

```json
{
  "protocol_version": 1,
  "agent_instance_id": "10000000-0000-4000-8000-000000000001",
  "sequence": 42,
  "observed_at": "2026-09-27T12:00:00.000Z",
  "health": "ok",
  "capabilities": ["status", "toggle", "next", "previous"],
  "player": {
    "package": "com.kugou.android.lite",
    "playback_state": "playing",
    "state_code": 3,
    "title": "Song title",
    "artist": "Artist",
    "album": "Album",
    "position_ms": 12345
  }
}
```

The agent sends a heartbeat every five seconds. The server marks it offline
after 15 seconds without an accepted status. Server receipt time is the only
clock used for online and expiration decisions. Within one agent instance,
only increasing sequence numbers are accepted. After a new instance is seen,
reports from retired instance IDs are rejected.

A local ADB failure is reported as `health: "degraded"`, `player: null` and a
bounded error code. Raw MediaSession output and local exception details are
never uploaded.

### `POST /agent/v1/commands/claim`

The request body is `{ "protocol_version": 1 }`. A pending command returns:

```json
{
  "command": {
    "id": "00000000-0000-4000-8000-000000000001",
    "action": "next",
    "status": "claimed",
    "created_at": "2026-09-27T12:00:00.000Z",
    "expires_at": "2026-09-27T12:00:30.000Z"
  }
}
```

No command returns HTTP 204. Commands are UUIDs, FIFO, limited to 20 pending
items and expire after 30 seconds. Before ACK, another claim returns the same
oldest command ID rather than advancing the queue.

### `POST /agent/v1/commands/{id}/ack`

Allowed results are `succeeded`, `failed` and `outcome_unknown`. Repeating the
same result is idempotent. A different result for an already acknowledged
command returns HTTP 409.

## Owner-facing interfaces

When enabled:

- MCP `kugou_status` and `GET /api/v1/kugou/status` require `music:read`.
- MCP `kugou_control` and `POST /api/v1/kugou/control` require
  `player:control`.

The control body has exactly one field, `action`, whose value is `toggle`,
`next` or `previous`. REST command creation returns HTTP 202. Commands are
rejected while the device is offline or degraded, when the capability is not
reported, or while control is disabled.

## First-version limits

- State and commands are lost when the Node process restarts.
- Do not run multiple server replicas; each process would have an independent
  queue.
- An ACK confirms that the local ADB operation completed, not that the Kugou UI
  necessarily changed as expected.
- Static registration does not provide an Android agent. Until a phone agent is
  separately implemented and provisioned, the registered phone remains
  `never_seen` and offline.
