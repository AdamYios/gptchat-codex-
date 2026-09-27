#!/usr/bin/env python3
"""Local relay between one existing ChatGPT tab and one Codex thread."""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from contextlib import closing
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


LOG_FIELDS = {"phase", "round", "reportId", "assistantMessages", "userMessages",
              "conversationTurns", "articles", "copyButtons", "stopButtons", "mainFound",
              "composerFound", "composerTag", "composerLength", "sendButtonFound",
              "sendButtonDisabled", "cardChoices", "instructionLength", "reportLength",
              "filledLength", "latestCardLength", "confirmed", "reason", "method", "baselineAvailable",
              "visibleDelta", "domDelta", "mode", "errorType", "status"}


def safe_log_data(data):
    result = {}
    if not isinstance(data, dict):
        return result
    for key, value in data.items():
        if key not in LOG_FIELDS:
            continue
        if isinstance(value, bool) or (isinstance(value, (int, float)) and not isinstance(value, bool)
                                       and abs(value) < 1_000_000_000):
            result[key] = value
        elif isinstance(value, str) and key in {"phase", "composerTag", "reason", "method",
                                                       "mode", "errorType", "status"}:
            result[key] = "".join(c for c in value if c.isascii() and (c.isalnum() or c in "_-"))[:50]
    return result


def error_code(exc):
    if isinstance(exc, sqlite3.Error):
        return "sqlite_error"
    if isinstance(exc, subprocess.TimeoutExpired):
        return "command_timeout"
    if isinstance(exc, OSError):
        return "os_error"
    message = str(exc)
    for pattern, code in (("拒绝把报告", "report_rejected"), ("仍在运行", "task_busy"),
                          ("待处理消息", "queue_pending"),
                          ("投递指令失败", "queue_failed"), ("另一条用户消息", "turn_mismatch"),
                          ("超过", "wait_timeout"), ("最终报告", "final_missing"),
                          ("未完成", "turn_failed")):
        if pattern in message:
            return code
    return "other"


class EventLog:
    def __init__(self, path: Path, max_bytes: int = 5_000_000):
        self.path = path
        self.max_bytes = max_bytes
        self.lock = threading.Lock()
        self.session_id = secrets.token_hex(6)

    def write(self, source: str, event: str, data=None, occurred_at: str | None = None):
        entry = {"time": datetime.now(timezone.utc).isoformat(),
                 "session": self.session_id,
                 "source": source if source in {"bridge", "content", "popup"} else "unknown",
                 "event": "".join(c for c in event if c.isascii() and (c.isalnum() or c in "_-"))[:50],
                 "data": safe_log_data(data)}
        if isinstance(occurred_at, str):
            try:
                parsed = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
                if parsed.tzinfo is not None:
                    entry["occurredAt"] = parsed.astimezone(timezone.utc).isoformat()
            except (TypeError, ValueError):
                pass
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.exists() and self.path.stat().st_size + len(line.encode("utf-8")) > self.max_bytes:
                self.path.replace(self.path.with_suffix(".jsonl.1"))
            with self.path.open("a", encoding="utf-8") as output:
                output.write(line)

    def tail(self, count: int = 100):
        with self.lock:
            lines = deque(maxlen=count)
            for path in (self.path.with_suffix(".jsonl.1"), self.path):
                if path.exists():
                    with path.open("r", encoding="utf-8") as source:
                        lines.extend(source)
        records = []
        for line in lines:
            if line.strip():
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return records


def read_clipboard_text():
    """Read Windows Unicode clipboard text once, without changing the clipboard."""
    if os.name != "nt":
        raise RuntimeError("--initial-report-clipboard 仅支持 Windows")
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    user32.OpenClipboard.argtypes = [ctypes.c_void_p]
    user32.OpenClipboard.restype = ctypes.c_int
    user32.GetClipboardData.argtypes = [ctypes.c_uint]
    user32.GetClipboardData.restype = ctypes.c_void_p
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = ctypes.c_int
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.restype = ctypes.c_int
    if not user32.OpenClipboard(None):
        raise RuntimeError("无法打开剪贴板；请稍后重试")
    try:
        handle = user32.GetClipboardData(13)  # CF_UNICODETEXT
        if not handle:
            raise RuntimeError("剪贴板里没有可读取的文字；请先复制 Codex 最终报告")
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            raise RuntimeError("无法读取剪贴板文字")
        try:
            return ctypes.wstring_at(pointer).strip()
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def read_latest_codex_final(thread_id: str):
    """Read the selected thread's latest completed final answer from local history."""
    codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    databases = sorted(codex_home.glob("thread_history_*.sqlite"), reverse=True)
    if not databases:
        raise RuntimeError("找不到本机 Codex 对话历史索引")
    for database in databases:
        try:
            with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)) as conn:
                turn = conn.execute(
                    "SELECT turn_id, status, final_agent_item_id FROM thread_turns "
                    "WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1", (thread_id,)
                ).fetchone()
                if not turn:
                    continue
                turn_id, status, item_id = turn
                if status != "completed":
                    raise RuntimeError(f"所选任务最新一轮状态为 {status}，尚无可转发的最终报告")
                if not item_id:
                    raise RuntimeError("所选任务最新一轮没有最终报告标记")
                item = conn.execute(
                    "SELECT item_json FROM thread_items "
                    "WHERE thread_id = ? AND turn_id = ? AND item_id = ?",
                    (thread_id, turn_id, item_id),
                ).fetchone()
                if not item:
                    raise RuntimeError("最终报告尚未写入本机历史索引，请稍后重试")
                payload = json.loads(item[0])
                report = payload.get("text", "").strip()
                if payload.get("type") != "agentMessage" or payload.get("phase") != "final_answer" or not report:
                    raise RuntimeError("历史记录中的最终消息格式不符合预期，已停止自动转发")
                return report
        except sqlite3.Error:
            continue
        except json.JSONDecodeError as exc:
            raise RuntimeError("最终报告历史记录不是有效 JSON") from exc
    raise RuntimeError("所选任务在本机历史索引中没有已完成轮次")


def history_database():
    codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    databases = sorted(codex_home.glob("thread_history_*.sqlite"), reverse=True)
    if not databases:
        raise RuntimeError("找不到本机 Codex 对话历史索引")
    return databases[0]


def latest_turn(thread_id: str):
    """Return the newest turn and its persisted input/final items, if present."""
    database = history_database()
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)) as conn:
        row = conn.execute(
            "SELECT turn_id, rollout_ordinal, status, first_user_item_id, final_agent_item_id, error_json "
            "FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1",
            (thread_id,),
        ).fetchone()
        if row is None:
            return None
        turn_id, ordinal, status, user_id, final_id, error = row
        def item(item_id):
            if not item_id:
                return None
            result = conn.execute(
                "SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ?",
                (thread_id, turn_id, item_id),
            ).fetchone()
            return json.loads(result[0]) if result else None
        return {"turn_id": turn_id, "ordinal": ordinal, "status": status,
                "user": item(user_id), "final": item(final_id), "error": error}


def queued_count(thread_id: str):
    codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    databases = sorted(codex_home.glob("queue_*.sqlite"), reverse=True)
    if not databases:
        raise RuntimeError("找不到本机 Codex 消息队列索引")
    with closing(sqlite3.connect(databases[0].as_uri() + "?mode=ro", uri=True, timeout=2)) as conn:
        return conn.execute("SELECT COUNT(*) FROM queued_items WHERE thread_id = ?", (thread_id,)).fetchone()[0]


def user_item_text(item):
    if not item or item.get("type") != "userMessage":
        return None
    return "\n".join(part.get("text", "") for part in item.get("content", [])
                     if part.get("type") == "text").strip()


def local_sessions(thread_id: str | None = None):
    """Read the local Codex session index without changing it."""
    codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    databases = sorted(codex_home.glob("state_*.sqlite"), reverse=True)
    for database in databases:
        try:
            with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)) as conn:
                if thread_id:
                    rows = conn.execute(
                        "SELECT id, name, cwd, title FROM threads "
                        "WHERE id = ? AND (thread_source = 'user' OR thread_source IS NULL)",
                        (thread_id,)
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT id, name, cwd, title FROM threads "
                        "WHERE archived = 0 AND thread_source = 'user' "
                        "ORDER BY updated_at DESC LIMIT 30"
                    ).fetchall()
                if rows:
                    return rows
        except (sqlite3.Error, OSError):
            continue
    raise RuntimeError("无法读取本机 Codex 任务索引；可用 --thread-id 和 --cwd 明确指定")


def print_session_list(sessions):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    print("本机 Codex 普通任务列表（最近 30 条）：")
    for number, (sid, name, cwd, first_message) in enumerate(sessions, 1):
        if name and name.strip():
            label = " ".join(name.split())[:100]
        else:
            excerpt = " ".join((first_message or "").split())[:60]
            label = f"(未命名；首句摘要：{excerpt or '无'})"
        path = str(cwd)
        if path.startswith("\\\\?\\UNC\\"):
            path = "\\\\" + path[8:]
        elif path.startswith("\\\\?\\"):
            path = path[4:]
        print(f"{number:2}. {label} [{sid}]\n    {path}")


def select_session(thread_id: str | None, cwd_override: Path | None):
    sessions = []
    try:
        sessions = local_sessions(thread_id)
    except RuntimeError:
        if not thread_id or not cwd_override:
            raise
    if not thread_id:
        print_session_list(sessions)
        choice = input("输入序号：").strip()
        if not choice.isdecimal() or not 1 <= int(choice) <= len(sessions):
            raise ValueError("无效的任务序号")
        thread_id = sessions[int(choice) - 1][0]
    try:
        uuid.UUID(thread_id)
    except (ValueError, TypeError) as exc:
        raise ValueError("任务 ID 必须是 UUID") from exc
    matched = next((row for row in sessions if row[0] == thread_id), None)
    if not matched and not cwd_override:
        raise ValueError("本机索引中找不到该任务；请确认 UUID 或从列表选择")
    cwd = cwd_override or Path(matched[2])
    return thread_id, Path(os.path.abspath(cwd))


def resolve_codex_executable(command: str):
    found = shutil.which(command)
    if found:
        return str(Path(found).absolute())
    candidate = Path(command)
    if candidate.is_file():
        return str(candidate.absolute())
    if command.lower() in {"codex", "codex.exe"}:
        root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        binaries = list((root / "OpenAI" / "Codex" / "bin").glob("*/codex.exe"))
        if binaries:
            return str(max(binaries, key=lambda path: path.stat().st_mtime))
    raise RuntimeError(f"找不到 Codex CLI 可执行文件：{command}；请检查 codex --version 或使用 --codex 指定完整路径")


def probe_codex_executable(executable: str, cwd: Path):
    try:
        result = subprocess.run([executable, "--version"], cwd=cwd, capture_output=True,
                                text=True, timeout=10, encoding="utf-8", errors="replace")
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"无法从任务目录启动 Codex CLI：程序={executable}；目录={cwd}；原因={exc}") from exc
    if result.returncode != 0:
        raise RuntimeError(f"Codex CLI 启动检查失败：程序={executable}；目录={cwd}；"
                           f"退出码={result.returncode}；{result.stderr.strip()[-500:]}")
    queue_help = subprocess.run([executable, "queue", "--help"], cwd=cwd, capture_output=True,
                                text=True, timeout=10, encoding="utf-8", errors="replace")
    if queue_help.returncode != 0 or "--thread" not in queue_help.stdout or "--message" not in queue_help.stdout:
        raise RuntimeError("当前 Codex CLI 不支持 queue --thread --message；请更新 Codex 桌面应用/CLI")
    return result.stdout.strip()


class Bridge:
    def __init__(self, thread_id: str, cwd: Path, codex: str, max_rounds: int, timeout: int,
                 event_log: EventLog | None = None):
        self.thread_id = thread_id
        self.cwd = cwd
        self.codex = codex
        self.max_rounds = max_rounds
        self.timeout = timeout
        self.run_id = secrets.token_hex(8)
        self.lock = threading.Lock()
        self.phase = "setup"
        self.round = 0
        self.report = ""
        self.report_id = 0
        self.detail = ""
        self.last_instruction = ""
        self.event_log = event_log

    def log(self, event: str, data=None):
        if self.event_log:
            try:
                self.event_log.write("bridge", event, data)
            except OSError as exc:
                print(f"操作记录写入失败：{exc}", file=sys.stderr, flush=True)

    def start(self, mode: str):
        if mode not in ("A", "B"):
            raise ValueError("起点只能选择 A 或 B")
        with self.lock:
            if self.phase == "codex_running":
                raise ValueError("Codex 本轮正在执行；请等它结束后再切换起点")
        # Read before changing state so a missing/incomplete final cannot discard a run.
        if mode == "B" and queued_count(self.thread_id):
            raise ValueError("目标 Codex 任务已有待处理消息；不能把上一轮报告作为当前报告发送")
        initial = read_latest_codex_final(self.thread_id) if mode == "B" else ""
        with self.lock:
            if self.phase == "codex_running":
                raise ValueError("Codex 本轮正在执行；请等它结束后再切换起点")
            self.run_id = secrets.token_hex(8)
            self.round = 0
            self.report = initial
            self.report_id = 1 if initial else 0
            self.detail = ""
            self.last_instruction = ""
            self.phase = "report_ready" if mode == "B" else "await_instruction"
        self.log("start", {"mode": mode, "phase": self.phase})
        print(f"已从扩展选择方式 {mode}；{'等待报告发往 ChatGPT' if mode == 'B' else '等待 ChatGPT 指令卡片'}", flush=True)

    def snapshot(self):
        with self.lock:
            return {"runId": self.run_id, "phase": self.phase, "round": self.round, "maxRounds": self.max_rounds,
                    "report": self.report if self.phase == "report_ready" else "",
                    "reportId": self.report_id, "detail": self.detail}

    def submit(self, instruction: str, run_id: str):
        instruction = instruction.strip()
        if not instruction or len(instruction) > 20_000:
            raise ValueError("指令长度必须为 1–20000 字符（Windows 命令行长度限制）")
        if ("以下是 Codex 上一轮的最终报告" in instruction and
                "Codex 最终报告：" in instruction):
            raise ValueError("检测到发往 ChatGPT 的 Codex 报告格式；已拒绝把报告投递给 Codex")
        with self.lock:
            if run_id != self.run_id:
                raise ValueError("桥接运行编号已变化；请等待页面同步后重试")
            if self.phase != "await_instruction":
                raise ValueError(f"not accepting instructions in phase {self.phase}")
            if self.round >= self.max_rounds:
                self.phase = "stopped"
                self.detail = "已达到最大轮数"
                raise ValueError(self.detail)
            self.phase = "codex_running"
            self.round += 1
            self.last_instruction = instruction
            number = self.round
        threading.Thread(target=self.run_codex, args=(instruction, number), daemon=True).start()
        self.log("instruction_accepted", {"round": number, "instructionLength": len(instruction)})

    def run_codex(self, instruction: str, number: int):
        try:
            before = latest_turn(self.thread_id)
            if before and before["status"] != "completed":
                raise RuntimeError(f"目标 Codex 任务仍在运行（状态 {before['status']}）；请等它完成后重新启动桥接")
            if queued_count(self.thread_id):
                raise RuntimeError("目标 Codex 任务已有待处理消息；为避免把别人的回复当作本轮报告，已停止")
            start_ordinal = before["ordinal"] if before else -1
            command = [self.codex, "queue", "--thread", self.thread_id, "--message", instruction]
            proc = subprocess.run(command, capture_output=True, text=True, cwd=Path.cwd(),
                                  timeout=30, encoding="utf-8", errors="replace")
            if proc.returncode != 0:
                raise RuntimeError(f"向原 Codex 任务投递指令失败（退出码 {proc.returncode}）："
                                   f"{(proc.stderr or proc.stdout).strip()[-1500:]}")
            print(f"第 {number} 轮：指令已投递到原 Codex 任务，等待最终回复", flush=True)
            self.log("instruction_queued", {"round": number})
            deadline = time.monotonic() + self.timeout
            while time.monotonic() < deadline:
                turn = latest_turn(self.thread_id)
                if not turn or turn["ordinal"] <= start_ordinal:
                    time.sleep(2)
                    continue
                submitted = user_item_text(turn["user"])
                if submitted is None:
                    time.sleep(2)
                    continue
                if submitted != instruction:
                    raise RuntimeError("目标任务收到另一条用户消息，无法确认本轮归属；已停止自动转发")
                if turn["status"] == "completed":
                    final = turn["final"]
                    report = (final or {}).get("text", "").strip()
                    if (final or {}).get("type") != "agentMessage" or (final or {}).get("phase") != "final_answer" or not report:
                        raise RuntimeError("本轮已结束，但没有可转发的最终报告")
                    with self.lock:
                        if self.phase == "codex_running" and self.round == number:
                            self.report = report
                            self.report_id += 1
                            self.phase = "report_ready"
                            self.detail = ""
                    print(f"第 {number} 轮：Codex 最终报告已就绪", flush=True)
                    self.log("report_ready", {"round": number, "reportLength": len(report),
                                              "reportId": self.report_id})
                    return
                if turn["status"] not in ("inProgress", "pending"):
                    raise RuntimeError(f"Codex 本轮未完成（状态 {turn['status']}）：{turn['error'] or ''}")
                time.sleep(2)
            raise RuntimeError(f"等待 Codex 最终报告超过 {self.timeout} 秒；指令可能仍在原任务中执行，请勿重复投递")
        except (OSError, sqlite3.Error, json.JSONDecodeError, subprocess.TimeoutExpired, RuntimeError) as exc:
            with self.lock:
                self.phase = "stopped"
                self.detail = f"{exc}（Codex 程序：{self.codex}；任务 ID：{self.thread_id}）"
            print(f"第 {number} 轮停止：{exc}", flush=True)
            self.log("codex_error", {"round": number, "errorType": type(exc).__name__,
                                     "reason": error_code(exc)})

    def acknowledge(self, report_id: int, run_id: str):
        with self.lock:
            if run_id != self.run_id:
                raise ValueError("桥接运行编号已变化；旧报告确认已忽略")
            if self.phase == "await_instruction" and report_id == self.report_id:
                return
            if self.phase != "report_ready" or report_id != self.report_id:
                raise ValueError("report acknowledgement does not match current report")
            self.report = ""
            self.phase = "await_instruction" if self.round < self.max_rounds else "stopped"
            if self.phase == "stopped":
                self.detail = "已达到最大轮数"
        self.log("report_acknowledged", {"reportId": report_id, "phase": self.phase})

    def stop(self, reason: str, run_id: str):
        with self.lock:
            if run_id != self.run_id:
                raise ValueError("桥接运行编号已变化；旧停止请求已忽略")
            if self.phase == "codex_running":
                raise ValueError("Codex 正在运行；请等待本轮结束")
            self.phase = "stopped"
            self.detail = reason[:500]
        self.log("stopped", {"reason": "assistant_stop"})


def make_handler(bridge: Bridge, token: str, event_log: EventLog | None = None):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send_json(self, status: int, value: dict):
            data = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            if not secrets.compare_digest(self.headers.get("X-Bridge-Token", ""), token):
                self.send_json(403, {"error": "invalid token"})
                return False
            return True

        def body(self):
            size = int(self.headers.get("Content-Length", "0"))
            if size > 200_000:
                raise ValueError("request too large")
            return json.loads(self.rfile.read(size))

        def do_GET(self):
            if not self.authorized():
                return
            if self.path == "/log" and event_log:
                self.send_json(200, {"path": str(event_log.path), "records": event_log.tail()})
            elif self.path != "/state":
                self.send_json(404, {"error": "not found"})
            else:
                self.send_json(200, bridge.snapshot())

        def do_POST(self):
            if not self.authorized():
                return
            try:
                data = self.body()
                if self.path == "/events" and event_log:
                    events = data.get("events")
                    if not isinstance(events, list) or not 1 <= len(events) <= 100:
                        raise ValueError("events must contain 1–100 records")
                    if any(not isinstance(entry, dict) for entry in events):
                        raise ValueError("invalid event record")
                    for entry in events:
                        event_log.write(entry.get("source", "unknown"),
                                        str(entry.get("event", "unknown")), entry.get("data"),
                                        entry.get("time"))
                    self.send_json(200, {"accepted": len(events)})
                    return
                if self.path == "/instruction":
                    bridge.submit(data["instruction"], str(data["runId"]))
                elif self.path == "/start":
                    bridge.start(str(data["mode"]))
                elif self.path == "/ack":
                    bridge.acknowledge(int(data["reportId"]), str(data["runId"]))
                elif self.path == "/stop":
                    bridge.stop(str(data.get("reason", "已停止")), str(data["runId"]))
                else:
                    self.send_json(404, {"error": "not found"})
                    return
                self.send_json(200, bridge.snapshot())
            except (ValueError, RuntimeError, KeyError, TypeError, json.JSONDecodeError, OSError) as exc:
                if event_log:
                    try:
                        event_log.write("bridge", "request_error", {"method": self.path.strip("/"),
                            "errorType": type(exc).__name__, "reason": error_code(exc)})
                    except OSError:
                        pass
                self.send_json(409, {"error": str(exc)})

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--thread-id", help="可选：直接指定现有 Codex 桌面任务 UUID；省略则显示任务列表")
    parser.add_argument("--cwd", type=Path, help="兼容旧命令；新版本仅用任务 UUID 定位，不需要工作目录")
    parser.add_argument("--codex", default="codex", help="Codex CLI 可执行文件")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--max-rounds", type=int, default=20)
    parser.add_argument("--timeout", type=int, default=3600, help="每轮 Codex 超时秒数")
    parser.add_argument("--list-tasks", action="store_true", help="仅列出本机任务，不启动桥接或发送消息")
    start = parser.add_mutually_exclusive_group()
    start.add_argument("--initial-report-file", type=Path, help="首次启动时要发给 ChatGPT 的既有 Codex 最终报告")
    start.add_argument("--initial-report-clipboard", action="store_true", help="从 Windows 剪贴板读取一次 Codex 最终报告")
    start.add_argument("--start-from-codex-final", action="store_true", help="自动读取所选 Codex 任务上一轮最终报告")
    start.add_argument("--start-from-existing-card", action="store_true", help="从 ChatGPT 当前最后一条指令卡片开始")
    args = parser.parse_args()
    if args.list_tasks:
        try:
            print_session_list(local_sessions())
        except RuntimeError as exc:
            parser.error(str(exc))
        return
    if args.max_rounds < 1 or args.timeout < 1:
        parser.error("max-rounds/timeout must be positive")
    try:
        thread_id, cwd = select_session(args.thread_id, args.cwd)
        codex_executable = resolve_codex_executable(args.codex)
        codex_version = probe_codex_executable(codex_executable, Path.cwd())
    except (ValueError, RuntimeError) as exc:
        parser.error(str(exc))
    token = secrets.token_urlsafe(24)
    event_log = EventLog(Path(__file__).resolve().parent / "logs" / "bridge.jsonl")
    bridge = Bridge(thread_id, cwd, codex_executable, args.max_rounds, args.timeout, event_log)
    if args.start_from_codex_final:
        try:
            if queued_count(thread_id):
                raise RuntimeError("目标 Codex 任务已有待处理消息；不能把上一轮报告作为当前报告发送")
            initial = read_latest_codex_final(thread_id)
        except RuntimeError as exc:
            parser.error(str(exc))
        bridge.report = initial
        bridge.report_id = 1
        bridge.phase = "report_ready"
        print(f"已从所选 Codex 任务读取上一轮最终报告（{len(initial)} 字）", flush=True)
    elif args.initial_report_clipboard:
        try:
            initial = read_clipboard_text()
        except RuntimeError as exc:
            parser.error(str(exc))
        if not initial:
            parser.error("剪贴板里的最终报告为空")
        bridge.report = initial
        bridge.report_id = 1
        bridge.phase = "report_ready"
        print(f"已从剪贴板读取 Codex 最终报告（{len(initial)} 字）；内容不会写入文件", flush=True)
    elif args.initial_report_file:
        try:
            initial = args.initial_report_file.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError) as exc:
            parser.error(f"无法读取 UTF-8 最终报告文件：{exc}")
        if not initial:
            parser.error("initial-report-file is empty")
        bridge.report = initial
        bridge.report_id = 1
        bridge.phase = "report_ready"
    elif args.start_from_existing_card:
        bridge.phase = "await_instruction"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(bridge, token, event_log))
    except OSError as exc:
        parser.error(f"无法监听本机端口 {args.port}；可能已有桥接器在运行：{exc}")
    print(f"已选任务 {thread_id}；任务记录中的工作目录 {cwd}（仅供核对，无需填写）", flush=True)
    print(f"Codex CLI 检查通过：{codex_executable}（{codex_version}）", flush=True)
    print(f"监听 http://127.0.0.1:{args.port}；把以下令牌填入 Edge 扩展：\n{token}", flush=True)
    event_log.write("bridge", "server_started", {"phase": bridge.phase})
    print(f"操作记录：{event_log.path}", flush=True)
    print("按 Ctrl+C 停止。绑定 Edge 标签页后，在扩展里点 A 或 B 选择起点。", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
