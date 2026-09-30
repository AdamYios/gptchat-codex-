import ctypes
import errno
import json
import multiprocessing
import sqlite3
import tempfile
import threading
import unittest
import urllib.request
from contextlib import closing
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from bridge import (Bridge, EventLog, create_bridge_server, latest_turn, local_sessions, make_handler,
                    probe_codex_executable, read_clipboard_text, read_latest_codex_final,
                    resolve_codex_executable, safe_log_title, select_session, task_log_path,
                    task_log_title)


def _write_log_records(path, prefix):
    log = EventLog(Path(path), max_bytes=1_000_000)
    for index in range(40):
        log.write("bridge", "parallel_write", {"status": f"{prefix}_{index}"})


class BridgeTests(unittest.TestCase):
    def test_log_appends_are_safe_across_bridge_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "logs" / "bridge.jsonl")
            writers = [multiprocessing.Process(target=_write_log_records, args=(path, prefix))
                       for prefix in ("first", "second")]
            for writer in writers:
                writer.start()
            for writer in writers:
                writer.join(10)
                self.assertEqual(writer.exitcode, 0)
            records = EventLog(Path(path)).tail(100)
            statuses = {record["data"]["status"] for record in records}
            self.assertEqual(len(records), 80)
            self.assertEqual(len(statuses), 80)
            self.assertEqual(len({record["session"] for record in records}), 2)

    def test_default_port_falls_back_when_occupied(self):
        fallback_server = SimpleNamespace(server_address=("127.0.0.1", 49152))
        with patch("bridge.BridgeHTTPServer", side_effect=[
                OSError(errno.EADDRINUSE, "occupied"), fallback_server]) as server_factory:
            server, auto_selected = create_bridge_server(8765, object(), True)
        self.assertIs(server, fallback_server)
        self.assertTrue(auto_selected)
        self.assertEqual(server_factory.call_args_list[0].args[0], ("127.0.0.1", 8765))
        self.assertEqual(server_factory.call_args_list[1].args[0], ("127.0.0.1", 0))

    def test_explicit_port_does_not_silently_change(self):
        with patch("bridge.BridgeHTTPServer", side_effect=OSError(errno.EADDRINUSE, "occupied")) as factory:
            with self.assertRaises(OSError):
                create_bridge_server(8766, object(), False)
        factory.assert_called_once()

    def test_default_port_falls_back_when_another_local_server_owns_it(self):
        first = create_bridge_server(0, BaseHTTPRequestHandler, False)[0]
        try:
            second, auto_selected = create_bridge_server(first.server_address[1], BaseHTTPRequestHandler, True)
            try:
                self.assertTrue(auto_selected)
                self.assertNotEqual(first.server_address[1], second.server_address[1])
            finally:
                second.server_close()
        finally:
            first.server_close()

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
            log = EventLog(Path(directory) / "logs" / "bridge.jsonl", task_id="task")
            bridge = Bridge("task", Path(directory), "codex", 2, 10, log)
            server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(bridge, "test-token", log))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                body = json.dumps({"events": [{"time": "2026-09-26T09:00:00Z",
                    "source": "content", "event": "card_choices_viewed", "taskId": "previous-task",
                    "data": {"cardChoices": 1, "strictChoiceCount": 0, "manualCandidateCount": 2,
                             "relaxedChoiceCount": 1, "latestOnly": True,
                             "method": "main_manual_loose", "token": "secret"}}]}).encode()
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
                self.assertEqual(records[0]["taskId"], "previous-task")
                self.assertEqual(records[0]["data"]["manualCandidateCount"], 2)
                self.assertTrue(records[0]["data"]["latestOnly"])
                self.assertEqual(records[0]["data"]["method"], "main_manual_loose")
                self.assertEqual(records[1]["taskId"], "task")
                self.assertNotIn("secret", log.path.read_text(encoding="utf-8"))
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)

    def test_task_log_paths_use_safe_title_and_unique_start_time(self):
        with tempfile.TemporaryDirectory() as directory:
            first_started = datetime(2026, 9, 27, 1, 2, 3, 123456, tzinfo=timezone.utc)
            second_started = datetime(2026, 9, 27, 1, 2, 3, 654321, tzinfo=timezone.utc)
            first = task_log_path(Path(directory), '研究 / Agent: Bug?', first_started)
            second = task_log_path(Path(directory), '研究 / Agent: Bug?', second_started)
            self.assertNotEqual(first, second)
            self.assertIn("研究_Agent_Bug", first.name)
            self.assertTrue(first.name.endswith(".jsonl"))
            self.assertEqual(safe_log_title("CON"), "_CON")
            self.assertEqual(task_log_title("  Task  title ", "ignored", "thread"), "Task title")
            self.assertEqual(task_log_title(None, "first\nmessage", "thread"), "未命名任务_first message")

    def test_two_bridge_servers_keep_task_logs_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            log_directory = Path(directory) / "logs"
            start = datetime.now(timezone.utc)
            log_paths = [task_log_path(log_directory, "task-one", start),
                         task_log_path(log_directory, "task-two", start)]
            servers = []
            workers = []
            tokens = ["token-one", "token-two"]
            for index, (thread_id, token) in enumerate((("task-one", tokens[0]), ("task-two", tokens[1]))):
                log = EventLog(log_paths[index], task_id=thread_id)
                bridge = Bridge(thread_id, Path(directory), "codex", 2, 10, log)
                log.write("bridge", "server_started", {})
                server, _ = create_bridge_server(0, make_handler(bridge, token, log), False)
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                servers.append(server)
                workers.append(worker)
            try:
                states = []
                for server, token in zip(servers, tokens):
                    base = f"http://127.0.0.1:{server.server_port}"
                    request = urllib.request.Request(base + "/state", headers={"X-Bridge-Token": token})
                    with urllib.request.urlopen(request) as response:
                        states.append(json.load(response))
                self.assertEqual([state["threadId"] for state in states], ["task-one", "task-two"])
                self.assertNotEqual(states[0]["runId"], states[1]["runId"])
                records = [EventLog(path).tail(10) for path in log_paths]
                self.assertEqual([[record["taskId"] for record in rows] for rows in records],
                                 [["task-one"], ["task-two"]])
                self.assertNotEqual(log_paths[0], log_paths[1])
            finally:
                for server in servers:
                    server.shutdown()
                    server.server_close()
                for worker in workers:
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
                selected, cwd, title = select_session(None, None)
            self.assertEqual(selected, task_id)
            self.assertEqual(cwd, Path(directory))
            self.assertEqual(title, "Example")

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
            with self.assertRaisesRegex(ValueError, "仍在执行"):
                bridge.start("A")

    def test_end_flow_during_codex_run_keeps_codex_and_suppresses_its_report(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge("task", Path(directory), "codex", 2, 10)
            bridge.start("A")
            bridge.phase = "codex_running"
            bridge.round = 1
            run_id = bridge.run_id
            bridge.active_codex_run_id = run_id
            bridge.stop("用户结束当前流程", run_id)
            stopped = bridge.snapshot()
            self.assertEqual(stopped["phase"], "stopped")
            self.assertTrue(stopped["codexInProgress"])
            self.assertNotIn("autoPaused", stopped)
            self.assertEqual(stopped["report"], "")
            self.assertIn("Codex 仍会继续运行", stopped["detail"])
            with self.assertRaisesRegex(ValueError, "仍在执行"):
                bridge.start("A")

            before = {"ordinal": 1, "status": "completed"}
            completed = {"ordinal": 2, "status": "completed",
                "user": {"type": "userMessage", "content": [{"type": "text", "text": "指令"}]},
                "final": {"type": "agentMessage", "phase": "final_answer", "text": "结束后生成的报告"}}
            with patch("bridge.latest_turn", side_effect=[before, completed]), \
                 patch("bridge.queued_count", return_value=0), \
                 patch("bridge.subprocess.run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="")) as run:
                bridge.run_codex("指令", 1, run_id)
            self.assertTrue(run.called, "ending the flow does not cancel the Codex task")
            after = bridge.snapshot()
            self.assertEqual(after["phase"], "stopped")
            self.assertFalse(after["codexInProgress"])
            self.assertEqual(after["report"], "", "the completed report is not made available for automatic delivery")
            bridge.start("A")
            self.assertNotEqual(bridge.run_id, run_id)

    def test_stop_http_endpoint_ends_flow_without_closing_bridge(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge("task", Path(directory), "codex", 2, 10)
            bridge.start("A")
            bridge.phase = "codex_running"
            bridge.round = 1
            bridge.active_codex_run_id = bridge.run_id
            server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(bridge, "test-token"))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f"http://127.0.0.1:{server.server_port}"

            def request(path, body=None):
                data = None if body is None else json.dumps(body).encode()
                req = urllib.request.Request(base + path, data, method="GET" if body is None else "POST",
                    headers={"X-Bridge-Token": "test-token", "Content-Type": "application/json"})
                with urllib.request.urlopen(req) as response:
                    return json.load(response)

            try:
                before = request("/state")
                self.assertTrue(before["codexInProgress"])
                stopped = request("/stop", {"reason": "用户结束当前流程", "runId": before["runId"]})
                self.assertEqual(stopped["phase"], "stopped")
                self.assertEqual(stopped["runId"], before["runId"])
                self.assertTrue(stopped["codexInProgress"])
                self.assertEqual(request("/state")["threadId"], "task", "the bridge stays connected")
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)

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

    def test_instruction_id_is_idempotent_across_retry_and_new_run(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge("task", Path(directory), "codex", 3, 10)
            bridge.start("A")
            instruction_id = "v1:/c/test:thread:turn-1:assistant:11:abc"
            with patch("bridge.threading.Thread") as thread_factory:
                self.assertTrue(bridge.submit("执行一次", bridge.run_id, instruction_id))
                self.assertFalse(bridge.submit(" 执行一次\n", bridge.run_id, instruction_id))
                thread_factory.assert_called_once()
                self.assertEqual(bridge.snapshot()["round"], 1)

                bridge.active_codex_run_id = None  # The mocked worker did not run.
                bridge.phase = "await_instruction"
                bridge.start("A")
                self.assertFalse(bridge.submit("执行一次", bridge.run_id, instruction_id))
                thread_factory.assert_called_once()
                self.assertEqual(bridge.snapshot()["round"], 0)

                new_turn_id = "v1:/c/test:thread:turn-2:assistant:11:abc"
                self.assertTrue(bridge.submit("执行一次", bridge.run_id, new_turn_id))
                self.assertEqual(thread_factory.call_count, 2)
                self.assertEqual(bridge.snapshot()["round"], 1)
                self.assertFalse(bridge.submit("执行一次", bridge.run_id, new_turn_id))
                self.assertEqual(thread_factory.call_count, 2)

                with self.assertRaisesRegex(ValueError, "已用于不同指令"):
                    bridge.submit("不同正文", bridge.run_id, instruction_id)

    def test_instruction_endpoint_returns_idempotent_duplicate_success(self):
        with tempfile.TemporaryDirectory() as directory:
            event_log = EventLog(Path(directory) / "logs" / "bridge.jsonl", task_id="task")
            bridge = Bridge("task", Path(directory), "codex", 3, 10, event_log)
            bridge.start("A")
            bridge.run_codex = lambda *_args: None
            server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(bridge, "test-token"))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f"http://127.0.0.1:{server.server_port}"
            request_body = json.dumps({
                "instruction": "执行一次",
                "instructionId": "v1:/c/test:thread:turn-1:assistant:11:abc",
                "runId": bridge.run_id
            }).encode()
            try:
                replies = []
                for _ in range(2):
                    request = urllib.request.Request(base + "/instruction", request_body, method="POST",
                        headers={"X-Bridge-Token": "test-token", "Content-Type": "application/json"})
                    with urllib.request.urlopen(request) as response:
                        self.assertEqual(response.status, 200)
                        replies.append(json.load(response))
                self.assertFalse(replies[0]["duplicate"])
                self.assertTrue(replies[1]["duplicate"])
                self.assertEqual(bridge.snapshot()["round"], 1)
                records = [record for record in event_log.tail()
                    if record["event"] in {"instruction_accepted", "instruction_duplicate"}]
                self.assertEqual([record["data"]["instructionId"] for record in records], [
                    "v1:/c/test:thread:turn-1:assistant:11:abc",
                    "v1:/c/test:thread:turn-1:assistant:11:abc"
                ])
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
