from __future__ import annotations

import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock


AGENT_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import kugou_agent  # noqa: E402


COMMAND_ID = "00000000-0000-4000-8000-000000000001"
TOKEN = "t" * 64


class FakeClient:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict | None]] = []

    def request(self, method: str, path: str, payload: dict | None = None):
        self.requests.append((method, path, payload))
        return 200, {"ok": True}


class FakeAdapter:
    def __init__(self, *, fail: bool = False) -> None:
        self.actions: list[str] = []
        self.fail = fail

    def control(self, action: str) -> None:
        self.actions.append(action)
        if self.fail:
            raise RuntimeError("local adb detail")

    def get_status(self) -> dict:
        return {
            "package": "com.kugou.android.lite",
            "playback_state": "playing",
            "state_code": 3,
            "title": "歌名",
            "artist": "歌手",
            "album": "专辑",
            "position_ms": 1234,
            "raw_description": "must stay local",
        }


class KugouAgentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.journal_path = Path(self.temporary.name) / "command-journal.json"

    def make_agent(self, adapter=None):
        client = FakeClient()
        journal = kugou_agent.CommandJournal(self.journal_path)
        agent = kugou_agent.KugouAgent(
            client,
            journal,
            adapter=adapter or FakeAdapter(),
            instance_id="10000000-0000-4000-8000-000000000001",
        )
        return agent, client, journal

    def test_requires_https_except_explicit_localhost_test_mode(self) -> None:
        self.assertEqual(
            kugou_agent.validate_cloud_url("https://music.example.test/"),
            "https://music.example.test",
        )
        with self.assertRaisesRegex(kugou_agent.AgentError, "HTTPS"):
            kugou_agent.validate_cloud_url("http://music.example.test")
        with self.assertRaisesRegex(kugou_agent.AgentError, "HTTPS"):
            kugou_agent.validate_cloud_url("http://127.0.0.1:3000")
        self.assertEqual(
            kugou_agent.validate_cloud_url(
                "http://127.0.0.1:3000/", allow_http_localhost=True
            ),
            "http://127.0.0.1:3000",
        )

    def test_reads_token_from_a_file_outside_the_repository(self) -> None:
        token_file = Path(self.temporary.name) / "device.secret"
        token_file.write_text(f"{TOKEN}\n", encoding="utf-8")
        self.assertEqual(kugou_agent.read_device_token(token_file), TOKEN)

        token_file.write_text("w" * 32, encoding="utf-8")
        with self.assertRaisesRegex(kugou_agent.AgentError, "内容无效"):
            kugou_agent.read_device_token(token_file)

        minimum_token = "m" * 43
        token_file.write_text(minimum_token, encoding="utf-8")
        self.assertEqual(
            kugou_agent.read_device_token(token_file), minimum_token
        )

    def test_status_payload_omits_raw_description_and_local_errors(self) -> None:
        agent, _, _ = self.make_agent()
        payload = agent.build_status()
        self.assertEqual(payload["health"], "ok")
        self.assertNotIn("raw_description", json.dumps(payload, ensure_ascii=False))

        broken, _, _ = self.make_agent(adapter=mock.Mock(get_status=mock.Mock(side_effect=RuntimeError("private path"))))
        degraded = broken.build_status()
        self.assertEqual(degraded["health"], "degraded")
        self.assertEqual(degraded["error"], {"code": "status_unavailable"})
        self.assertNotIn("private path", json.dumps(degraded))

    def test_records_started_before_execution_and_never_executes_an_id_twice(self) -> None:
        adapter = FakeAdapter()
        original_control = adapter.control

        def verify_started_before_control(action: str) -> None:
            persisted = json.loads(self.journal_path.read_text(encoding="utf-8"))
            self.assertEqual(
                persisted["commands"][COMMAND_ID]["result"], "started"
            )
            original_control(action)

        adapter.control = verify_started_before_control
        agent, client, journal = self.make_agent(adapter)
        command = {"id": COMMAND_ID, "action": "next"}
        agent.process_command(command)
        agent.process_command(command)

        self.assertEqual(adapter.actions, ["next"])
        self.assertEqual(journal.get(COMMAND_ID)["result"], "succeeded")
        acknowledgements = [request for request in client.requests if request[1].endswith("/ack")]
        self.assertEqual(len(acknowledgements), 2)
        self.assertTrue(self.journal_path.exists())

    def test_started_command_becomes_outcome_unknown_after_restart(self) -> None:
        journal = kugou_agent.CommandJournal(self.journal_path)
        journal.record(COMMAND_ID, "toggle", "started")
        adapter = FakeAdapter()
        client = FakeClient()
        restarted = kugou_agent.KugouAgent(client, journal, adapter=adapter)
        restarted.process_command({"id": COMMAND_ID, "action": "toggle"})

        self.assertEqual(adapter.actions, [])
        self.assertEqual(journal.get(COMMAND_ID)["result"], "outcome_unknown")
        self.assertEqual(client.requests[-1][2]["result"], "outcome_unknown")

    def test_failed_adb_execution_is_persisted_without_local_detail(self) -> None:
        adapter = FakeAdapter(fail=True)
        agent, client, journal = self.make_agent(adapter)
        agent.process_command({"id": COMMAND_ID, "action": "previous"})
        entry = journal.get(COMMAND_ID)
        self.assertEqual(entry["result"], "failed")
        self.assertEqual(entry["error_code"], "adb_command_failed")
        self.assertNotIn("local adb detail", self.journal_path.read_text(encoding="utf-8"))
        self.assertEqual(client.requests[-1][2]["error"], {"code": "adb_command_failed"})

    def test_corrupt_journal_fails_closed(self) -> None:
        self.journal_path.parent.mkdir(parents=True, exist_ok=True)
        self.journal_path.write_text("not json", encoding="utf-8")
        with self.assertRaisesRegex(kugou_agent.AgentError, "避免重复执行"):
            kugou_agent.CommandJournal(self.journal_path)

    def test_network_errors_and_retry_log_never_include_token_or_url(self) -> None:
        def failing_opener(*_args, **_kwargs):
            raise urllib.error.URLError("connection refused")

        client = kugou_agent.AgentHttpClient(
            "https://private.example.test",
            TOKEN,
            opener=failing_opener,
        )
        with self.assertRaises(kugou_agent.NetworkError) as raised:
            client.request("POST", "/agent/v1/commands/claim", {})
        self.assertNotIn(TOKEN, str(raised.exception))
        self.assertNotIn("private.example", str(raised.exception))
        self.assertEqual(kugou_agent.backoff_seconds(1), 1)
        self.assertEqual(kugou_agent.backoff_seconds(10), 30)


if __name__ == "__main__":
    unittest.main()
