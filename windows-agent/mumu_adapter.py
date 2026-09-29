from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


ADB_PATH = Path(
    os.environ.get(
        "KUGOU_ADB_PATH",
        r"F:\LenovoSoftstore\Install\MuMuPlayer\nx_device\12.0\shell\adb.exe",
    )
)
DEVICE_ID = os.environ.get("KUGOU_ADB_DEVICE", "127.0.0.1:7555")
KUGOU_PACKAGE = "com.kugou.android.lite"
ADB_TIMEOUT_SECONDS = 10

STATE_NAMES = {
    0: "无状态",
    1: "已停止",
    2: "已暂停",
    3: "播放中",
    4: "快进中",
    5: "快退中",
    6: "缓冲中",
    7: "发生错误",
    8: "正在连接",
}

PLAYBACK_STATES = {
    0: "none",
    1: "stopped",
    2: "paused",
    3: "playing",
    4: "fast_forwarding",
    5: "rewinding",
    6: "buffering",
    7: "error",
    8: "connecting",
}


def run_adb(*args: str) -> str:
    if not ADB_PATH.is_file():
        raise RuntimeError(f"找不到 adb.exe：{ADB_PATH}")

    try:
        result = subprocess.run(
            [str(ADB_PATH), "-s", DEVICE_ID, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=ADB_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("ADB 命令执行超时") from error

    stdout = result.stdout.decode("utf-8", errors="replace")
    stderr = result.stderr.decode("utf-8", errors="replace")

    if result.returncode != 0:
        raise RuntimeError(stderr.strip() or "ADB 命令执行失败")

    return stdout.replace("\r\n", "\n")


def get_kugou_session() -> str:
    output = run_adb("shell", "dumpsys", "media_session")
    marker = f"package={KUGOU_PACKAGE}"
    start = output.find(marker)

    if start == -1:
        raise RuntimeError("没有找到酷狗概念版的 MediaSession，请先播放一首歌")

    remaining = output[start + len(marker) :]
    next_package = re.search(r"(?m)^\s*package=", remaining)

    if next_package:
        end = start + len(marker) + next_package.start()
        return output[start:end]

    return output[start:]


def get_device_uptime_ms() -> int:
    output = run_adb("shell", "cat", "/proc/uptime")
    seconds = float(output.split()[0])
    return int(seconds * 1000)


def get_status() -> dict:
    session = get_kugou_session()

    state_match = re.search(
        r"state=PlaybackState \{state=(\d+), "
        r"position=(\d+), buffered position=(\d+), "
        r"speed=([-\d.]+), updated=(\d+)",
        session,
    )

    if not state_match:
        raise RuntimeError("找到了酷狗，但没有读取到播放状态")

    state = int(state_match.group(1))
    position_ms = int(state_match.group(2))
    speed = float(state_match.group(4))
    updated_ms = int(state_match.group(5))

    metadata_match = re.search(
        r"(?m)^\s*metadata: size=\d+, description=(.*)$",
        session,
    )
    description = metadata_match.group(1).strip() if metadata_match else ""
    metadata_parts = [part.strip() for part in description.split(",", 2)]

    title = metadata_parts[0] if len(metadata_parts) >= 1 else ""
    artist = metadata_parts[1] if len(metadata_parts) >= 2 else ""
    album = metadata_parts[2] if len(metadata_parts) >= 3 else ""

    estimated_position_ms = position_ms
    if state == 3 and speed > 0:
        elapsed_ms = max(0, get_device_uptime_ms() - updated_ms)
        estimated_position_ms += int(elapsed_ms * speed)

    return {
        "device": DEVICE_ID,
        "package": KUGOU_PACKAGE,
        "state_code": state,
        "state": STATE_NAMES.get(state, f"未知状态 {state}"),
        "playback_state": PLAYBACK_STATES.get(state, "unknown"),
        "title": title,
        "artist": artist,
        "album": album,
        "position_ms": estimated_position_ms,
        "position_seconds": round(estimated_position_ms / 1000, 1),
        "raw_description": description,
    }


def send_keyevent(keycode: int) -> None:
    run_adb("shell", "input", "keyevent", str(keycode))
    time.sleep(1)


def control(action: str) -> None:
    commands = {
        "toggle": 85,
        "next": 87,
        "previous": 88,
    }
    if action not in commands:
        raise RuntimeError("可用命令：toggle、next、previous")
    send_keyevent(commands[action])


def main() -> None:
    command = sys.argv[1].lower() if len(sys.argv) > 1 else "status"

    if command in {"toggle", "next", "previous"}:
        control(command)
    elif command != "status":
        raise RuntimeError("可用命令：status、toggle、next、previous")

    print(json.dumps(get_status(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        main()
    except Exception as error:
        print(f"运行失败：{error}")
        raise SystemExit(1)
