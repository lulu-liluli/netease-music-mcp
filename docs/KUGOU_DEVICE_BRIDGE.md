# Kugou Windows device bridge

This optional bridge connects the personal remote MCP service to one Windows
MuMu instance running Kugou Concept Edition. It is a single-device,
single-process, in-memory first version.

## Trust boundaries

There are two independent credential layers:

1. OAuth and Personal Access Tokens authorize owner-facing MCP and `/api/v1`
   calls.
2. A device Bearer token authorizes only `/agent/v1` calls from the Windows
   agent.

The device token cannot authorize MCP or user REST operations. OAuth and
Personal Access Tokens cannot authorize agent routes. The token is read from
`KUGOU_DEVICE_TOKEN_FILE`; no plaintext-token environment variable is
supported.

The Windows agent initiates every HTTPS connection. The cloud service never
connects to MuMu, Windows or `127.0.0.1:7555`.

## Ubuntu cloud deployment

The base deployment continues to use `compose.yaml`. It retains the existing
`/data` volume and does not enable the Kugou bridge. On an Ubuntu or Aliyun
cloud server, enable the bridge with the optional `compose.kugou.yaml` overlay:

```bash
docker compose -f compose.yaml -f compose.kugou.yaml up -d --build
```

The host configuration contains only non-secret values:

```dotenv
KUGOU_CONTROL_ENABLED=0
KUGOU_DEVICE_TOKEN_FILE_HOST=/opt/music-bridge/secrets/kugou-device.secret
```

`KUGOU_DEVICE_TOKEN_FILE_HOST` is a host file path, not the Token value. The
file must already exist, remain outside Git, and be readable by the container's
unprivileged `node` user through the read-only bind mount. The overlay fixes
the container path at `/run/secrets/kugou-device.secret`; Token content never
enters Compose environment variables or command-line arguments.

The first deployment must keep `KUGOU_CONTROL_ENABLED=0`. Verify authenticated
status reporting, online/offline transitions and `kugou_status` before enabling
control and recreating the container.

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
- The Windows agent is the only supported companion in this version. There is
  no Android phone companion.
