from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock


AGENT_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import mumu_adapter  # noqa: E402


DUMPSYS_SAMPLE = """
Sessions Stack - have 2 sessions:
  package=com.kugou.android.lite
    state=PlaybackState {state=3, position=12000, buffered position=18000, speed=1.0, updated=100000, actions=0}
    metadata: size=8, description=中文歌名, 测试歌手, 测试专辑
  package=com.example.other
    state=PlaybackState {state=2, position=1, buffered position=1, speed=0.0, updated=1}
"""


class MumuAdapterTests(unittest.TestCase):
    def test_parses_chinese_metadata_and_estimates_playing_position(self) -> None:
        with mock.patch.object(
            mumu_adapter, "get_kugou_session", return_value=DUMPSYS_SAMPLE
        ), mock.patch.object(
            mumu_adapter, "get_device_uptime_ms", return_value=103500
        ):
            status = mumu_adapter.get_status()

        self.assertEqual(status["title"], "中文歌名")
        self.assertEqual(status["artist"], "测试歌手")
        self.assertEqual(status["album"], "测试专辑")
        self.assertEqual(status["playback_state"], "playing")
        self.assertEqual(status["position_ms"], 15500)

    def test_does_not_advance_paused_position(self) -> None:
        paused = DUMPSYS_SAMPLE.replace("state=3", "state=2", 1).replace(
            "speed=1.0", "speed=0.0", 1
        )
        with mock.patch.object(
            mumu_adapter, "get_kugou_session", return_value=paused
        ), mock.patch.object(mumu_adapter, "get_device_uptime_ms") as uptime:
            status = mumu_adapter.get_status()
        self.assertEqual(status["position_ms"], 12000)
        self.assertEqual(status["playback_state"], "paused")
        uptime.assert_not_called()

    def test_selects_only_the_kugou_media_session(self) -> None:
        with mock.patch.object(
            mumu_adapter, "run_adb", return_value=DUMPSYS_SAMPLE
        ):
            session = mumu_adapter.get_kugou_session()
        self.assertIn("中文歌名", session)
        self.assertNotIn("com.example.other", session)

    def test_rejects_missing_media_session_and_playback_state(self) -> None:
        with mock.patch.object(
            mumu_adapter, "run_adb", return_value="package=com.example.other"
        ):
            with self.assertRaisesRegex(RuntimeError, "没有找到"):
                mumu_adapter.get_kugou_session()

        with mock.patch.object(
            mumu_adapter,
            "get_kugou_session",
            return_value="package=com.kugou.android.lite",
        ):
            with self.assertRaisesRegex(RuntimeError, "没有读取到"):
                mumu_adapter.get_status()

    def test_applies_an_adb_timeout_and_maps_timeout_to_a_safe_error(self) -> None:
        fake_path = mock.Mock()
        fake_path.is_file.return_value = True
        with mock.patch.object(mumu_adapter, "ADB_PATH", fake_path), mock.patch.object(
            mumu_adapter.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired("adb", 10),
        ) as run:
            with self.assertRaisesRegex(RuntimeError, "执行超时"):
                mumu_adapter.run_adb("shell", "dumpsys", "media_session")
        self.assertEqual(run.call_args.kwargs["timeout"], 10)

    def test_control_uses_only_the_three_allowlisted_keyevents(self) -> None:
        with mock.patch.object(mumu_adapter, "send_keyevent") as send:
            mumu_adapter.control("toggle")
            mumu_adapter.control("next")
            mumu_adapter.control("previous")
            self.assertEqual([call.args[0] for call in send.call_args_list], [85, 87, 88])
            with self.assertRaisesRegex(RuntimeError, "可用命令"):
                mumu_adapter.control("play")


if __name__ == "__main__":
    unittest.main()
