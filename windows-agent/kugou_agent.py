from __future__ import annotations

import json
import os
import re
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import mumu_adapter


HEARTBEAT_SECONDS = 5.0
POLL_SECONDS = 2.0
HTTP_TIMEOUT_SECONDS = 10.0
MAX_BACKOFF_SECONDS = 30.0
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{43,256}$")
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
ALLOWED_ACTIONS = {"toggle", "next", "previous"}
TERMINAL_RESULTS = {"succeeded", "failed", "outcome_unknown"}


class AgentError(RuntimeError):
    pass


class NetworkError(AgentError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def validate_cloud_url(value: str, *, allow_http_localhost: bool = False) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError as error:
        raise AgentError("云端地址无效") from error
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise AgentError("云端地址无效")
    if parsed.scheme == "https" and parsed.hostname:
        return value.rstrip("/")
    if (
        allow_http_localhost
        and parsed.scheme == "http"
        and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    ):
        return value.rstrip("/")
    raise AgentError("云端地址必须使用 HTTPS")


def read_device_token(file_path: str | os.PathLike[str]) -> str:
    try:
        token = Path(file_path).read_text(encoding="utf-8").strip()
    except OSError as error:
        raise AgentError("无法读取设备 Token 文件") from error
    if not TOKEN_PATTERN.fullmatch(token):
        raise AgentError("设备 Token 文件内容无效")
    return token


def default_journal_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise AgentError("未找到 LOCALAPPDATA")
    return Path(local_app_data) / "music-bridge" / "command-journal.json"


def backoff_seconds(failures: int) -> float:
    return min(MAX_BACKOFF_SECONDS, float(2 ** max(0, failures - 1)))


class CommandJournal:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.entries: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise AgentError("命令日志损坏；为避免重复执行，agent 已停止") from error
        if (
            not isinstance(payload, dict)
            or payload.get("version") != 1
            or not isinstance(payload.get("commands"), dict)
        ):
            raise AgentError("命令日志格式无效；为避免重复执行，agent 已停止")
        for command_id, entry in payload["commands"].items():
            if (
                not isinstance(command_id, str)
                or not UUID_PATTERN.fullmatch(command_id)
                or not isinstance(entry, dict)
                or entry.get("result") not in {"started", *TERMINAL_RESULTS}
            ):
                raise AgentError("命令日志格式无效；为避免重复执行，agent 已停止")
        self.entries = payload["commands"]

    def get(self, command_id: str) -> dict | None:
        entry = self.entries.get(command_id)
        return dict(entry) if entry else None

    def record(self, command_id: str, action: str, result: str, error_code: str | None = None) -> None:
        if result not in {"started", *TERMINAL_RESULTS}:
            raise AgentError("命令日志结果无效")
        entry = {
            "action": action,
            "result": result,
            "updated_at": utc_now(),
        }
        if error_code:
            entry["error_code"] = error_code
        self.entries[command_id] = entry
        self._save()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            {"version": 1, "commands": self.entries},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        temporary_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix="command-journal-",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary.write(payload)
                temporary.flush()
                os.fsync(temporary.fileno())
                temporary_path = temporary.name
            os.replace(temporary_path, self.path)
        except OSError as error:
            if temporary_path:
                try:
                    Path(temporary_path).unlink(missing_ok=True)
                except OSError:
                    pass
            raise AgentError("无法安全写入命令日志；agent 已停止") from error


class AgentHttpClient:
    def __init__(
        self,
        cloud_url: str,
        token: str,
        *,
        allow_http_localhost: bool = False,
        timeout: float = HTTP_TIMEOUT_SECONDS,
        opener: Callable | None = None,
    ) -> None:
        self.cloud_url = validate_cloud_url(
            cloud_url, allow_http_localhost=allow_http_localhost
        )
        self.token = token
        self.timeout = timeout
        self.opener = opener or urllib.request.urlopen
        self.ssl_context = ssl.create_default_context()

    def request(self, method: str, path: str, payload: dict | None = None) -> tuple[int, dict | None]:
        body = None
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.cloud_url}{path}",
            data=body,
            headers=headers,
            method=method,
        )
        try:
            response = self.opener(
                request,
                timeout=self.timeout,
                context=self.ssl_context,
            )
            with response:
                status = response.status
                raw = response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            raw = error.read()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise NetworkError("云端请求失败") from error

        data = None
        if raw:
            try:
                data = json.loads(raw.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError) as error:
                raise NetworkError("云端响应无效") from error
        if status >= 400:
            raise NetworkError(f"云端请求返回 HTTP {status}")
        return status, data


class KugouAgent:
    def __init__(
        self,
        client: AgentHttpClient,
        journal: CommandJournal,
        *,
        adapter=mumu_adapter,
        instance_id: str | None = None,
    ) -> None:
        self.client = client
        self.journal = journal
        self.adapter = adapter
        self.instance_id = instance_id or str(uuid.uuid4())
        self.sequence = 0

    def build_status(self) -> dict:
        self.sequence += 1
        base = {
            "protocol_version": 1,
            "agent_instance_id": self.instance_id,
            "sequence": self.sequence,
            "observed_at": utc_now(),
            "capabilities": ["status", "toggle", "next", "previous"],
        }
        try:
            local = self.adapter.get_status()
            base.update(
                {
                    "health": "ok",
                    "player": {
                        "package": local["package"],
                        "playback_state": local["playback_state"],
                        "state_code": local["state_code"],
                        "title": str(local.get("title", ""))[:512],
                        "artist": str(local.get("artist", ""))[:512],
                        "album": str(local.get("album", ""))[:512],
                        "position_ms": max(0, int(local.get("position_ms", 0))),
                    },
                }
            )
        except Exception:
            base.update(
                {
                    "health": "degraded",
                    "player": None,
                    "error": {"code": "status_unavailable"},
                }
            )
        return base

    def report_status(self) -> None:
        self.client.request("PUT", "/agent/v1/status", self.build_status())

    def claim_command(self) -> dict | None:
        status, payload = self.client.request(
            "POST", "/agent/v1/commands/claim", {"protocol_version": 1}
        )
        if status == 204:
            return None
        if not isinstance(payload, dict) or not isinstance(payload.get("command"), dict):
            raise NetworkError("云端命令响应无效")
        command = payload["command"]
        if (
            not isinstance(command.get("id"), str)
            or not UUID_PATTERN.fullmatch(command["id"])
            or command.get("action") not in ALLOWED_ACTIONS
        ):
            raise NetworkError("云端命令响应无效")
        return command

    def acknowledge(self, command_id: str, result: str, error_code: str | None = None) -> None:
        payload = {
            "protocol_version": 1,
            "result": result,
            "completed_at": utc_now(),
        }
        if result == "failed":
            payload["error"] = {"code": error_code or "adb_command_failed"}
        self.client.request(
            "POST", f"/agent/v1/commands/{command_id}/ack", payload
        )

    def process_command(self, command: dict) -> None:
        command_id = command["id"]
        action = command["action"]
        existing = self.journal.get(command_id)
        if existing:
            if existing.get("action") != action:
                raise AgentError("命令 ID 与本地日志冲突；agent 已停止")
            result = existing["result"]
            if result == "started":
                result = "outcome_unknown"
                self.journal.record(command_id, action, result)
            self.acknowledge(
                command_id,
                result,
                existing.get("error_code") if result == "failed" else None,
            )
            return

        self.journal.record(command_id, action, "started")
        try:
            self.adapter.control(action)
        except Exception:
            self.journal.record(
                command_id, action, "failed", error_code="adb_command_failed"
            )
            self.acknowledge(command_id, "failed", "adb_command_failed")
            return

        self.journal.record(command_id, action, "succeeded")
        self.acknowledge(command_id, "succeeded")

    def run_forever(self) -> None:
        next_heartbeat = 0.0
        failures = 0
        while True:
            try:
                now = time.monotonic()
                if now >= next_heartbeat:
                    self.report_status()
                    next_heartbeat = now + HEARTBEAT_SECONDS
                command = self.claim_command()
                if command:
                    self.process_command(command)
                failures = 0
                time.sleep(POLL_SECONDS)
            except KeyboardInterrupt:
                return
            except NetworkError:
                failures += 1
                delay = backoff_seconds(failures)
                print(f"网络请求失败，将在 {delay:g} 秒后重试。", file=sys.stderr)
                time.sleep(delay)
            except AgentError:
                raise


def main() -> int:
    try:
        cloud_url = os.environ.get("KUGOU_CLOUD_URL", "")
        token_file = os.environ.get("KUGOU_DEVICE_TOKEN_FILE", "")
        if not cloud_url or not token_file:
            raise AgentError(
                "必须配置 KUGOU_CLOUD_URL 和 KUGOU_DEVICE_TOKEN_FILE"
            )
        token = read_device_token(token_file)
        client = AgentHttpClient(cloud_url, token)
        journal = CommandJournal(default_journal_path())
        KugouAgent(client, journal).run_forever()
        return 0
    except AgentError as error:
        print(f"Agent 启动或运行失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
