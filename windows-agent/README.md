# Windows MuMu Kugou agent

This agent is the only component that talks to MuMu ADB. It makes outbound
HTTPS requests to the personal cloud service; the server never connects to
`127.0.0.1:7555` and ADB must not be exposed publicly.

## Requirements

- Windows with MuMu Player and Kugou Concept Edition (`com.kugou.android.lite`);
- Python 3.10 or newer; no third-party Python packages are used;
- the repository copy of `mumu_adapter.py` in this directory;
- a device token file stored outside the repository and readable only by the
  Windows account running the agent.

The tested local defaults are:

```text
ADB: F:\LenovoSoftstore\Install\MuMuPlayer\nx_device\12.0\shell\adb.exe
device: 127.0.0.1:7555
```

Override them only when needed:

```powershell
$env:KUGOU_ADB_PATH = 'F:\path\to\adb.exe'
$env:KUGOU_ADB_DEVICE = '127.0.0.1:7555'
```

## Configuration

Configure the same high-entropy token file on the cloud service and Windows.
Do not put the token value in `.env`, a command line, a URL, logs or Git.

```powershell
$env:KUGOU_CLOUD_URL = 'https://music.example.com'
$env:KUGOU_DEVICE_TOKEN_FILE = "$env:LOCALAPPDATA\music-bridge\device.secret"
python .\kugou_agent.py
```

Production cloud URLs must use HTTPS. Plain HTTP is accepted only by the
unit-test API when explicitly enabled for localhost.

The server-side feature flags default to disabled:

```dotenv
KUGOU_BRIDGE_ENABLED=1
KUGOU_CONTROL_ENABLED=0
KUGOU_DEVICE_TOKEN_FILE=/permission-restricted/path/kugou-device.secret
```

Start with status-only mode. After status reporting, offline detection and
token isolation have been verified, set `KUGOU_CONTROL_ENABLED=1` and restart
the cloud process.

## Command safety

The agent stores its journal at:

```text
%LOCALAPPDATA%\music-bridge\command-journal.json
```

It atomically records `started` before sending an ADB keyevent. A repeated
command ID is acknowledged from the journal and is never executed again. If
the process stops after `started` but before recording a result, the next run
acknowledges `outcome_unknown` rather than replaying the keyevent. A corrupt or
unreadable journal stops the agent so that it fails closed.

Only `toggle`, `next` and `previous` are accepted. Detailed ADB errors and raw
MediaSession descriptions remain local and are not uploaded.

## Tests

From the repository root:

```powershell
python -m unittest discover -s windows-agent/tests -v
```

The tests use mocks and sanitized `dumpsys media_session` samples. They do not
connect to MuMu or ADB.
