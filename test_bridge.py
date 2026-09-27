import ctypes
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.request
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from bridge import (Bridge, EventLog, latest_turn, local_sessions, make_handler,
                    probe_codex_executable, read_clipboard_text, read_latest_codex_final,
                    resolve_codex_executable, select_session)


class BridgeTests(unittest.TestCase):
    def test_operation_log_sanitizes_and_rotates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "logs" / "bridge.jsonl"
            log = EventLog(path, max_bytes=300)
            log.write("content", "card_scan", {"cardChoices": 3, "token": "private",
                                                "instruction": "private text", "reason": "not_matched"})
            log.write("bridge", "start", {"mode": "A"})
            log.write("popup", "view_log_ok", {"status": "ready"})
            entries = log.tail()
            self.assertEqual(entries[-1]["event"], "view_log_ok")
            self.assertTrue(path.exists())
            combined = "".join(p.read_text(encoding="utf-8") for p in path.parent.iterdir())
            self.assertNotIn("private", combined)
            self.assertIn("card_scan", combined)

    def test_extension_events_reach_same_local_log(self):
        with tempfile.TemporaryDirectory() as directory:
            log = EventLog(Path(directory) / "logs" / "bridge.jsonl")
            bridge = Bridge("task", Path(directory), "codex", 2, 10, log)
            server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(bridge, "test-token", log))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                body = json.dumps({"events": [{"time": "2026-09-26T09:00:00Z",
                    "source": "content", "event": "card_scan",
                    "data": {"cardChoices": 3, "token": "secret"}}]}).encode()
                request = urllib.request.Request(base + "/events", body, method="POST",
                    headers={"X-Bridge-Token": "test-token", "Content-Type": "application/json"})
                with urllib.request.urlopen(request) as response:
                    self.assertEqual(json.load(response)["accepted"], 1)
                bridge.log("start", {"mode": "A"})
                request = urllib.request.Request(base + "/log", headers={"X-Bridge-Token": "test-token"})
                with urllib.request.urlopen(request) as response:
                    records = json.load(response)["records"]
                self.assertEqual([entry["source"] for entry in records], ["content", "bridge"])
                self.assertEqual(records[0]["occurredAt"], "2026-09-26T09:00:00+00:00")
                self.assertEqual(records[0]["session"], records[1]["session"])
                self.assertNotIn("secret", log.path.read_text(encoding="utf-8"))
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)

    def test_codex_executable_resolution_and_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "OpenAI" / "Codex" / "bin" / "build" / "codex.exe"
            binary.parent.mkdir(parents=True)
            binary.touch()
            with patch("bridge.shutil.which", return_value=None), \
                 patch.dict("bridge.os.environ", {"LOCALAPPDATA": directory}):
                self.assertEqual(resolve_codex_executable("codex"), str(binary))
            with patch("bridge.subprocess.run", side_effect=[
                SimpleNamespace(returncode=0, stdout="codex-cli test", stderr=""),
                SimpleNamespace(returncode=0, stdout="--thread --message", stderr=""),
            ]) as run:
                self.assertEqual(probe_codex_executable(str(binary), Path(directory)), "codex-cli test")
                self.assertEqual(run.call_args_list[0].args[0], [str(binary), "--version"])
                self.assertEqual(run.call_args_list[1].args[0], [str(binary), "queue", "--help"])

    def test_bootstrap_reads_only_latest_completed_final(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "thread_history_1.sqlite"
            with closing(sqlite3.connect(database)) as conn:
                conn.execute("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, "
                             "final_agent_item_id TEXT, rollout_ordinal INTEGER)")
                conn.execute("CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, "
                             "item_id TEXT, item_json TEXT)")
                conn.executemany("INSERT INTO thread_turns VALUES (?,?,?,?,?)", [
                    ("task", "old", "completed", "old-final", 1),
                    ("task", "new", "completed", "new-final", 2),
                ])
                conn.executemany("INSERT INTO thread_items VALUES (?,?,?,?)", [
                    ("task", "old", "old-final", json.dumps({"type": "agentMessage", "phase": "final_answer", "text": "旧报告"})),
                    ("task", "new", "new-final", json.dumps({"type": "agentMessage", "phase": "final_answer", "text": "最新报告"})),
                ])
                conn.commit()
            with patch.dict("bridge.os.environ", {"CODEX_HOME": directory}):
                self.assertEqual(read_latest_codex_final("task"), "最新报告")
                with closing(sqlite3.connect(database)) as conn:
                    conn.execute("INSERT INTO thread_turns VALUES (?,?,?,?,?)",
                                 ("task", "running", "inProgress", None, 3))
                    conn.commit()
                with self.assertRaisesRegex(RuntimeError, "尚无可转发"):
                    read_latest_codex_final("task")

    def test_clipboard_bootstrap_reads_unicode_text_once(self):
        class WinCall:
            def __init__(self, value):
                self.value = value
            def __call__(self, *_args):
                return self.value

        buffer = ctypes.create_unicode_buffer("最终报告")
        fake = SimpleNamespace(
            user32=SimpleNamespace(OpenClipboard=WinCall(1), GetClipboardData=WinCall(123),
                                   CloseClipboard=WinCall(1)),
            kernel32=SimpleNamespace(GlobalLock=WinCall(ctypes.addressof(buffer)),
                                     GlobalUnlock=WinCall(1)),
        )
        with patch("bridge.ctypes.windll", fake, create=True), patch("bridge.os.name", "nt"):
            self.assertEqual(read_clipboard_text(), "最终报告")

    def test_listing_uses_saved_name_and_excludes_internal_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "state_5.sqlite"
            with closing(sqlite3.connect(database)) as conn:
                conn.execute("CREATE TABLE threads (id TEXT, name TEXT, cwd TEXT, title TEXT, "
                             "archived INTEGER, thread_source TEXT, updated_at INTEGER)")
                conn.executemany("INSERT INTO threads VALUES (?,?,?,?,?,?,?)", [
                    ("user-id", "Visible task name", directory, "First message", 0, "user", 3),
                    ("automation-id", "Worker", directory, "Automation prompt", 0, "automation", 2),
                    ("review-id", None, directory, "Approval transcript", 0, "guardian_review", 1),
                ])
                conn.commit()
            with patch.dict("bridge.os.environ", {"CODEX_HOME": directory}):
                self.assertEqual(local_sessions(), [("user-id", "Visible task name", directory, "First message")])

    def test_task_selection_uses_saved_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            task_id = "01a0d19b-00f4-7613-91b0-eb70ca06602d"
            with patch("bridge.local_sessions", return_value=[(task_id, "Example", directory, "First message")]), \
                 patch("builtins.input", return_value="1"):
                selected, cwd = select_session(None, None)
            self.assertEqual(selected, task_id)
            self.assertEqual(cwd, Path(directory))

    def test_only_completed_turn_exposes_final_report(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge("test-thread", Path(directory), "codex", 2, 10)
            bridge.phase = "codex_running"
            bridge.round = 1

            before = {"ordinal": 1, "status": "completed"}
            running = {"ordinal": 2, "status": "inProgress", "user": {"type": "userMessage", "content": [{"type": "text", "text": "指令"}]}}
            completed = {**running, "status": "completed", "final": {"type": "agentMessage", "phase": "final_answer", "text": "最终报告"}}
            with patch("bridge.latest_turn", side_effect=[before, running, completed]), \
                 patch("bridge.queued_count", return_value=0), \
                 patch("bridge.time.sleep"), \
                 patch("bridge.subprocess.run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="")) as run:
                bridge.run_codex("指令", 1)
            self.assertEqual(run.call_args.args[0], ["codex", "queue", "--thread", "test-thread", "--message", "指令"])
            self.assertEqual(bridge.snapshot()["phase"], "report_ready")
            self.assertEqual(bridge.snapshot()["report"], "最终报告")
            bridge.acknowledge(1, bridge.run_id)
            self.assertEqual(bridge.snapshot()["phase"], "await_instruction")

    def test_streamed_text_without_completion_stops(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge("test-thread", Path(directory), "codex", 2, 10)
            bridge.phase = "codex_running"
            bridge.round = 1

            before = {"ordinal": 1, "status": "completed"}
            failed = {"ordinal": 2, "status": "failed", "user": {"type": "userMessage", "content": [{"type": "text", "text": "指令"}]}, "error": "test"}
            with patch("bridge.latest_turn", side_effect=[before, failed]), \
                 patch("bridge.queued_count", return_value=0), \
                 patch("bridge.subprocess.run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="")):
                bridge.run_codex("指令", 1)
            self.assertEqual(bridge.snapshot()["phase"], "stopped")
            self.assertEqual(bridge.snapshot()["report"], "")

    def test_history_reads_only_completed_final_item(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "thread_history_1.sqlite"
            with closing(sqlite3.connect(database)) as conn:
                conn.execute("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, "
                             "status TEXT, first_user_item_id TEXT, final_agent_item_id TEXT, error_json TEXT)")
                conn.execute("CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_json TEXT)")
                conn.execute("INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?)", ("task", "turn", 3, "completed", "user", "final", None))
                conn.execute("INSERT INTO thread_items VALUES (?,?,?,?)", ("task", "turn", "user", json.dumps({"type": "userMessage", "content": [{"type": "text", "text": "指令"}]})))
                conn.execute("INSERT INTO thread_items VALUES (?,?,?,?)", ("task", "turn", "final", json.dumps({"type": "agentMessage", "phase": "final_answer", "text": "报告"})))
                conn.commit()
            with patch.dict("bridge.os.environ", {"CODEX_HOME": directory}):
                turn = latest_turn("task")
            self.assertEqual(turn["status"], "completed")
            self.assertEqual(turn["final"]["text"], "报告")

    def test_popup_can_choose_start_mode_and_restart_after_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge("task", Path(directory), "codex", 2, 10)
            self.assertEqual(bridge.snapshot()["phase"], "setup")
            bridge.start("A")
            self.assertEqual(bridge.snapshot()["phase"], "await_instruction")
            bridge.start("A")
            self.assertEqual(bridge.snapshot()["phase"], "await_instruction")
            bridge.stop("测试停止", bridge.run_id)
            with patch("bridge.queued_count", return_value=0), \
                 patch("bridge.read_latest_codex_final", return_value="最终报告"):
                bridge.start("B")
            self.assertEqual(bridge.snapshot()["phase"], "report_ready")
            self.assertEqual(bridge.snapshot()["report"], "最终报告")
            bridge.start("A")
            self.assertEqual(bridge.snapshot()["phase"], "await_instruction")
            self.assertEqual(bridge.snapshot()["report"], "")
            bridge.phase = "codex_running"
            with self.assertRaisesRegex(ValueError, "正在执行"):
                bridge.start("A")

    def test_old_run_cannot_acknowledge_new_report(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge("task", Path(directory), "codex", 2, 10)
            bridge.start("A")
            old_run = bridge.run_id
            with patch("bridge.queued_count", return_value=0), \
                 patch("bridge.read_latest_codex_final", return_value="新报告"):
                bridge.start("B")
            with self.assertRaisesRegex(ValueError, "旧报告确认已忽略"):
                bridge.acknowledge(1, old_run)
            self.assertEqual(bridge.snapshot()["report"], "新报告")

    def test_start_b_rejects_pending_codex_messages_without_changing_state(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge("task", Path(directory), "codex", 2, 10)
            bridge.start("A")
            original = bridge.snapshot()
            with patch("bridge.queued_count", return_value=1), \
                 patch("bridge.read_latest_codex_final") as read_final:
                with self.assertRaisesRegex(ValueError, "已有待处理消息"):
                    bridge.start("B")
                read_final.assert_not_called()
            self.assertEqual(bridge.snapshot(), original)

    def test_report_wrapper_cannot_be_submitted_as_codex_instruction(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge("task", Path(directory), "codex", 2, 10)
            bridge.start("A")
            original = bridge.snapshot()
            report = ("你说：\n以下是 Codex 上一轮的最终报告。请先分析，再决定下一步。\n\n"
                      "Codex 最终报告：\n这是报告正文")
            with self.assertRaisesRegex(ValueError, "已拒绝把报告投递给 Codex"):
                bridge.submit(report, original["runId"])
            self.assertEqual(bridge.snapshot(), original)


if __name__ == "__main__":
    unittest.main()
