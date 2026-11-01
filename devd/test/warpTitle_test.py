"""Conversation title hook regressions using local state and a recording tmux fake."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest import mock


HELPER = Path(__file__).resolve().parents[2] / "image/vendor/warp-hooks/warp-title.py"
LOADER = importlib.machinery.SourceFileLoader("warp_title_test_target", str(HELPER))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
title_module = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(title_module)


class RecordingTmux:
    def __init__(self):
        self.pane = "%17"
        self.session = "$3"
        self.pane_options = {}
        self.session_options = {}
        self.messages = []
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        command, *options = args
        target = options[options.index("-t") + 1]
        if command == "show-options":
            assert target == self.pane
            if "-pqv" not in options and options[-1] in self.session_options:
                return self.session_options[options[-1]]
            return self.pane_options.get(options[-1], "")
        if command == "display-message":
            assert target == self.pane
            if "-d" in options:
                self.messages.append(options[-1])
                return ""
            if options[-1] == title_module.TITLE_FORMAT:
                return self.rendered_title(title_format=options[-1])
            assert options[-1] == "#{session_id}"
            return self.session
        if command == "set-option":
            values = self.pane_options if "-p" in options else self.session_options
            # A pane target selects its session for session-scope options (real tmux).
            assert target == self.pane or ("-p" not in options and target == self.session)
            values[options[-2]] = options[-1]
            return ""
        raise AssertionError(f"Unexpected tmux command: {args}")

    def rendered_title(self, pane_title="shell", title_format=None):
        # Interpret nested tmux conditionals so precedence is tested against state.
        # The parent integration test exercises the same format in real tmux.
        values = {**self.session_options, **self.pane_options, "pane_title": pane_title}

        def evaluate(expression):
            if not expression.startswith("#{"):
                return expression
            assert expression.endswith("}")
            body = expression[2:-1]
            if not body.startswith("?"):
                return values.get(body, "")
            pieces, start, depth = [], 1, 0
            for index in range(1, len(body)):
                if body[index:index + 2] == "#{":
                    depth += 1
                elif body[index] == "}":
                    depth -= 1
                elif body[index] == "," and depth == 0:
                    pieces.append(body[start:index])
                    start = index + 1
            pieces.append(body[start:])
            assert len(pieces) == 3
            condition, yes, no = pieces
            return evaluate(yes if values.get(condition) else no)

        return evaluate(title_format or self.session_options["set-titles-string"])


class WarpTitleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.codex_home = self.directory / "codex"
        self.grok_home = self.directory / "grok"
        self.codex_home.mkdir()
        self.grok_home.mkdir()
        self.tmux = RecordingTmux()
        patcher = mock.patch.object(title_module, "tmux", side_effect=self.tmux)
        self.tmux_mock = patcher.start()
        self.addCleanup(patcher.stop)

    def database(self, sid="thread-1", name="", title="", schema=5, name_column=True, metadata=None):
        path = self.codex_home / f"state_{schema}.sqlite"
        with contextlib.closing(sqlite3.connect(path)) as db, db:
            columns = "id TEXT PRIMARY KEY, title TEXT" + (", name TEXT" if name_column else "")
            db.execute(f"CREATE TABLE IF NOT EXISTS threads ({columns})")
            if name_column:
                db.execute("INSERT OR REPLACE INTO threads (id, name, title) VALUES (?, ?, ?)",
                           (sid, name, title))
            else:
                db.execute("INSERT OR REPLACE INTO threads (id, title) VALUES (?, ?)", (sid, title))
            existing_columns = {column[1] for column in db.execute("PRAGMA table_info(threads)")}
            for column, value in (metadata or {}).items():
                self.assertIn(column, ("thread_source", "source", "agent_path"))
                if column not in existing_columns:
                    db.execute(f"ALTER TABLE threads ADD COLUMN {column} TEXT")
                db.execute(f"UPDATE threads SET {column}=? WHERE id=?", (value, sid))
        return path

    def summary(self, sid="grok-1", **values):
        session = self.grok_home / "sessions" / "workspace-a" / sid
        session.mkdir(parents=True, exist_ok=True)
        (session / "summary.json").write_text(json.dumps(values))
        return session / "transcript.jsonl"

    def sync(self, data, event="prompt_submit"):
        title_module.sync(data, event, self.tmux.pane, self.codex_home, self.grok_home)

    def main(self, payload, event="prompt_submit", pane="%17"):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(title_module.sys, "argv", [str(HELPER), event]), \
             mock.patch.object(title_module.sys, "stdin", io.StringIO(payload)), \
             mock.patch.dict(title_module.os.environ, {
                 "TMUX_PANE": pane, "CODEX_HOME": str(self.codex_home),
                 "GROK_HOME": str(self.grok_home),
             }), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            title_module.main()
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")

    def test_codex_generated_name_precedes_title_and_prompt(self):
        self.database(name="Repair updater", title="Initial database title")
        self.sync({"session_id": "thread-1", "prompt": "Investigate automatic updates"})
        self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "Repair updater")
        self.assertEqual(self.tmux.pane_options["@devd_title_session"], "thread-1")
        self.assertEqual(self.tmux.session_options["set-titles"], "on")

    def test_codex_title_fallback_supports_empty_name_and_old_schema(self):
        for schema, has_name in ((5, True), (6, False)):
            with self.subTest(name_column=has_name):
                self.database(title=f"Saved title {schema}", schema=schema, name_column=has_name)
                self.sync({"session_id": "thread-1", "prompt": "Prompt fallback"})
                self.assertEqual(self.tmux.pane_options["@devd_auto_title"], f"Saved title {schema}")

    def test_codex_uses_newest_numeric_database_version(self):
        self.database(name="Old name", schema=9)
        self.database(name="Current name", schema=10)
        self.sync({"session_id": "thread-1"})
        self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "Current name")

    def test_first_prompt_fallback_survives_tiny_followups(self):
        self.sync({"session_id": "thread-1", "prompt": "Fix automatic Codex upgrades"})
        original_options = self.tmux.pane_options.copy()
        for prompt in ("ok", "go", "x", ""):
            with self.subTest(prompt=prompt):
                self.sync({"session_id": "thread-1", "prompt": prompt})
                self.assertEqual(self.tmux.pane_options, original_options)

    def test_stop_refreshes_fallback_from_new_generated_name(self):
        self.sync({"session_id": "thread-1", "user_prompt": "Investigate the update popup"})
        self.database(name="Automatic agent updates")
        self.sync({"session_id": "thread-1"}, event="stop")
        self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "Automatic agent updates")

    def test_stale_stop_cannot_replace_foreground_conversation(self):
        self.sync({"session_id": "foreground", "prompt": "Current task"})
        self.database(sid="previous", name="Stale result")
        previous_pane = self.tmux.pane_options.copy()
        previous_session = self.tmux.session_options.copy()
        self.sync({"session_id": "previous"}, event="stop")
        self.assertEqual(self.tmux.pane_options, previous_pane)
        self.assertEqual(self.tmux.session_options, previous_session)

    def test_new_prompt_switches_session_and_replaces_old_fallback(self):
        self.sync({"session_id": "previous", "prompt": "Old task"})
        self.database(sid="current", metadata={
            "thread_source": "cli", "source": json.dumps("cli"), "agent_path": "/root",
        })
        self.sync({"session_id": "current", "input": "New task"})
        self.assertEqual(self.tmux.pane_options["@devd_title_session"], "current")
        self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "New task")

    def test_codex_hook_child_identity_is_ignored_before_metadata_exists(self):
        for bound in (False, True):
            with self.subTest(bound=bound):
                if bound:
                    self.sync({"session_id": "parent", "prompt": "Main task"})
                before = self.tmux.pane_options.copy()
                self.sync({"session_id": "child", "agent_id": "child", "prompt": "Child task"})
                self.assertEqual(self.tmux.pane_options, before)

    def test_subagent_prompt_cannot_take_over_parent_or_bind_empty_pane(self):
        markers = (
            {"thread_source": "subagent"},
            {"source": json.dumps({"subagent": {"parent_thread_id": "parent"}})},
            {"agent_path": "/root/reviewer"},
        )
        for metadata in markers:
            for bound_pane in (False, True):
                for generated_name in ("", "Child generated title"):
                    with self.subTest(metadata=metadata, bound=bound_pane, name=generated_name):
                        self.tmux.pane_options.clear()
                        self.tmux.session_options.clear()
                        if bound_pane:
                            self.sync({"session_id": "parent", "prompt": "Parent conversation"})
                        previous_pane = self.tmux.pane_options.copy()
                        previous_session = self.tmux.session_options.copy()
                        self.database(sid="child", name=generated_name, metadata=metadata)
                        self.sync({"session_id": "child", "prompt": "Review one delegated module"})
                        self.assertEqual(self.tmux.pane_options, previous_pane)
                        self.assertEqual(self.tmux.session_options, previous_session)

    def test_grok_camelcase_transcript_metadata_uses_generated_title(self):
        transcript = self.summary(generated_title="Grok generated name", session_summary="Longer summary")
        self.sync({"sessionId": "grok-1", "transcriptPath": str(transcript), "prompt": "Initial prompt"})
        self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "Grok generated name")
        self.assertEqual(self.tmux.pane_options["@devd_title_session"], "grok-1")

    def test_grok_missing_transcript_path_uses_session_summary_fallback(self):
        self.summary(generated_title="", session_summary="Persisted conversation summary")
        self.sync({"sessionId": "grok-1"}, event="stop")
        self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "Persisted conversation summary")

    def test_grok_subagent_kinds_cannot_take_over_parent_or_bind_empty_pane(self):
        for kind in ("subagent", "subagent_fork", "subagent_resume"):
            for bound_pane in (False, True):
                for generated_name in ("", "Child generated title"):
                    with self.subTest(kind=kind, bound=bound_pane, name=generated_name):
                        self.tmux.pane_options.clear()
                        self.tmux.session_options.clear()
                        if bound_pane:
                            self.sync({"sessionId": "parent", "prompt": "Parent conversation"})
                        previous_pane = self.tmux.pane_options.copy()
                        previous_session = self.tmux.session_options.copy()
                        transcript = self.summary(
                            session_kind=kind, generated_title=generated_name,
                            info={"id": "grok-1"}, parent_session_id="parent",
                        )
                        self.sync({"sessionId": "grok-1", "transcriptPath": str(transcript),
                                   "prompt": "Run delegated analysis"})
                        self.assertEqual(self.tmux.pane_options, previous_pane)
                        self.assertEqual(self.tmux.session_options, previous_session)

    def test_grok_hook_subagent_type_prevents_child_prompt_without_summary(self):
        self.sync({"sessionId": "parent", "prompt": "Parent conversation"})
        previous_pane = self.tmux.pane_options.copy()
        previous_session = self.tmux.session_options.copy()
        self.tmux_mock.reset_mock()
        self.sync({"sessionId": "child", "subagentType": "explore", "prompt": "Child request"})
        self.tmux_mock.assert_not_called()
        self.assertEqual(self.tmux.pane_options, previous_pane)
        self.assertEqual(self.tmux.session_options, previous_session)

    def test_grok_user_fork_and_worktree_can_replace_parent_title(self):
        for kind in ("fork", "worktree", None):
            with self.subTest(kind=kind):
                self.sync({"sessionId": "parent", "prompt": "Parent conversation"})
                values = {"generated_title": "User's next conversation", "parent_session_id": "parent",
                          "info": {"id": "grok-1"}}
                if kind is not None:
                    values["session_kind"] = kind
                transcript = self.summary(**values)
                self.sync({"sessionId": "grok-1", "transcriptPath": str(transcript),
                           "subagentType": "", "prompt": "Continue in this session"})
                self.assertEqual(self.tmux.pane_options["@devd_title_session"], "grok-1")
                self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "User's next conversation")

    def test_grok_mismatched_summary_identity_allows_prompt_fallback(self):
        for kind in ("fork", "subagent"):
            with self.subTest(kind=kind):
                self.tmux.pane_options.clear()
                self.tmux.session_options.clear()
                transcript = self.summary(session_kind=kind, info={"id": "different-session"},
                                          generated_title="Other session's title")
                self.sync({"sessionId": "grok-1", "transcriptPath": str(transcript),
                           "prompt": "This session's initial request"})
                self.assertEqual(self.tmux.pane_options.get("@devd_title_session"), "grok-1")
                self.assertEqual(self.tmux.pane_options.get("@devd_auto_title"),
                                 "This session's initial request")

    def test_grok_external_transcript_cannot_supply_title(self):
        external = self.directory / "outside" / "grok-1"
        external.mkdir(parents=True)
        (external / "summary.json").write_text(json.dumps({"generated_title": "External title"}))
        self.sync({"sessionId": "grok-1", "transcriptPath": str(external / "transcript.jsonl"),
                   "prompt": "Allowed prompt"})
        self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "Allowed prompt")

    def test_titles_remove_terminal_escapes_controls_and_bidi_overrides(self):
        dangerous = "\x1b]2;injected title\x07 Find\n  bug \x1b[31mnow\x1b[0m\u202e\x00"
        self.database(name=dangerous)
        self.sync({"session_id": "thread-1"})
        self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "Find bug now")
        self.sync({"session_id": "thread-2", "prompt": "x" * 200})
        self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "x" * 80)

    def test_manual_label_is_preserved_and_format_obeys_label_auto_pane_priority(self):
        self.tmux.pane_options["@devd_label"] = "My manually named task"
        self.sync({"session_id": "thread-1", "prompt": "Automatic title"})
        self.assertEqual(self.tmux.pane_options["@devd_label"], "My manually named task")
        writes = [args for args in self.tmux.calls if args[0] == "set-option"]
        self.assertFalse(any(args[-2] == "@devd_label" for args in writes))
        self.assertEqual(self.tmux.rendered_title(), "My manually named task")
        del self.tmux.pane_options["@devd_label"]
        self.assertEqual(self.tmux.rendered_title(), "Automatic title")
        del self.tmux.pane_options["@devd_auto_title"]
        self.assertEqual(self.tmux.rendered_title(pane_title="Existing pane title"), "Existing pane title")

    def test_devbox_name_survives_hook_updates(self):
        self.tmux.session_options["@devd_session_name"] = "PHD Banka"
        self.sync({"session_id": "thread-1", "prompt": "Research"})
        self.assertEqual(self.tmux.rendered_title(), "PHD Banka")
        self.tmux.pane_options["@devd_label"] = "Explicit label"
        self.sync({"session_id": "thread-1", "prompt": "Next turn"})
        self.assertEqual(self.tmux.rendered_title(), "Explicit label")
        del self.tmux.pane_options["@devd_label"]
        self.tmux.session_options["@devd_session_name"] = ""
        self.assertEqual(self.tmux.rendered_title(), "Research")

    def test_invalid_inputs_are_silent_and_do_not_touch_tmux(self):
        for payload, event, pane in (
            ("not JSON", "prompt_submit", "%17"),
            ("[]", "prompt_submit", "%17"),
            ("null", "prompt_submit", "%17"),
            ('{"session_id":"../escape","prompt":"Title"}', "prompt_submit", "%17"),
            ('{"session_id":42,"prompt":"Title"}', "prompt_submit", "%17"),
            ('{"prompt":"Missing session"}', "prompt_submit", "%17"),
            ('{"session_id":"valid","prompt":"Title"}', "unsupported", "%17"),
            ('{"session_id":"valid","prompt":"Title"}', "prompt_submit", "$(unsafe)"),
        ):
            with self.subTest(payload=payload, event=event, pane=pane):
                self.main(payload, event=event, pane=pane)
                self.tmux_mock.assert_not_called()

    def test_tmux_failures_and_malformed_saved_metadata_are_silent(self):
        payload = json.dumps({"session_id": "thread-1", "prompt": "Fallback title"})
        for error in (subprocess.TimeoutExpired("tmux", 0.5),
                      subprocess.CalledProcessError(1, "tmux"), OSError("pane closed")):
            with self.subTest(error=error):
                self.tmux_mock.side_effect = error
                self.main(payload)
                self.assertEqual(self.tmux.pane_options, {})
        self.tmux_mock.side_effect = self.tmux
        (self.codex_home / "state_5.sqlite").write_bytes(b"not a sqlite database")
        self.main(payload)
        self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "Fallback title")
        transcript = self.summary()
        (transcript.parent / "summary.json").write_text("not JSON")
        self.main(json.dumps({"sessionId": "grok-1", "prompt": "Grok fallback"}))
        self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "Grok fallback")

    def test_codex_status_lifecycle_and_late_tool_completion(self):
        payloads = []
        with mock.patch.object(title_module, "write_status", side_effect=lambda pane, payload: payloads.append(payload), create=True):
            for event, extra in (
                ("session_start", {}), ("prompt_submit", {}),
                ("pre_tool_use", {"tool_name": "functions.request_user_input"}),
                ("tool_complete", {"tool_name": "exec_command"}),
                ("tool_complete", {"tool_name": "functions.request_user_input"}),
                ("stop", {}), ("tool_complete", {"tool_name": "exec_command"}), ("stop", {}),
            ):
                title_module.status({"session_id": "root", **extra}, event, self.tmux.pane, self.codex_home, self.grok_home, "codex")
        self.assertEqual([p["event"] for p in payloads], ["session_start", "prompt_submit", "permission_request", "tool_complete", "stop"])
        self.assertTrue(all(p["agent"] == "codex" for p in payloads))

    def test_child_and_stale_status_cannot_overwrite_foreground(self):
        with mock.patch.object(title_module, "write_status", create=True) as emit:
            title_module.status({"session_id": "root"}, "prompt_submit", self.tmux.pane, self.codex_home, self.grok_home, "codex")
            emit.reset_mock()
            self.database(sid="db-child", metadata={"source": json.dumps({"subagent": {"parent_thread_id": "root"}})})
            for data, event in (
                ({"session_id": "child", "agent_id": "child"}, "prompt_submit"),
                ({"session_id": "db-child"}, "session_start"),
                ({"session_id": "previous"}, "stop"),
                ({"sessionId": "grok-child", "subagentType": "explore"}, "prompt_submit"),
            ):
                title_module.status(data, event, self.tmux.pane, self.codex_home, self.grok_home, "codex")
            emit.assert_not_called()

    def test_status_without_title_still_tracks_owner_and_new_turn(self):
        with mock.patch.object(title_module, "write_status", create=True) as emit:
            title_module.status({"session_id": "a"}, "prompt_submit", self.tmux.pane, self.codex_home, self.grok_home, "codex")
            title_module.status({"session_id": "a"}, "stop", self.tmux.pane, self.codex_home, self.grok_home, "codex")
            title_module.status({"session_id": "b"}, "prompt_submit", self.tmux.pane, self.codex_home, self.grok_home, "codex")
            title_module.status({"session_id": "b", "tool_name": "exec_command"}, "tool_complete", self.tmux.pane, self.codex_home, self.grok_home, "codex")
            self.assertEqual([call.args[1]["session_id"] for call in emit.call_args_list], ["a", "a", "b", "b"])

    def test_new_tool_after_stop_marks_resumed_work_and_async_questions_wait(self):
        with mock.patch.object(title_module, "write_status", create=True) as emit:
            for event, tool in [("prompt_submit", ""), ("stop", ""), ("pre_tool_use", "exec_command"), ("pre_tool_use", "request_user_input_async")]:
                title_module.status({"session_id": "root", "tool_name": tool}, event, self.tmux.pane, self.codex_home, self.grok_home, "codex")
            self.assertEqual([call.args[1]["event"] for call in emit.call_args_list], ["prompt_submit", "stop", "tool_complete", "permission_request"])

    def test_async_question_stays_orange_until_user_prompt(self):
        with mock.patch.object(title_module, "write_status", create=True) as emit:
            for event, tool in [("prompt_submit", ""),
                                ("pre_tool_use", "functions.request_user_input_async"),
                                ("tool_complete", "functions.request_user_input_async"),
                                ("pre_tool_use", "exec_command"),
                                ("tool_complete", "exec_command"),
                                ("stop", ""), ("prompt_submit", ""),
                                ("tool_complete", "exec_command"), ("stop", "")]:
                title_module.status({"session_id": "root", "tool_name": tool}, event, self.tmux.pane, self.codex_home, self.grok_home, "codex")
            self.assertEqual([c.args[1]["event"] for c in emit.call_args_list],
                             ["prompt_submit", "permission_request", "prompt_submit", "tool_complete", "stop"])
            # The question's summary is the unchanged session title, never question text.
            self.assertEqual(emit.call_args_list[1].args[1]["summary"], "shell")

    def test_status_summary_carries_devbox_title_so_warp_tab_keeps_session_name(self):
        # Warp's vertical tabs prefer a plugin agent's `summary` over the terminal
        # title (OSC 0). Without it the devbox name set via tmux never shows.
        self.tmux.session_options["@devd_session_name"] = "PHD Banka"
        with mock.patch.object(title_module, "write_status", create=True) as emit:
            for agent, data in (("codex", {"session_id": "root"}), ("claude", {"session_id": "c1"}),
                                ("grok", {"sessionId": "g1", "prompt": "Fix website"})):
                title_module.status(data, "prompt_submit", self.tmux.pane, self.codex_home, self.grok_home, agent)
                self.assertEqual(emit.call_args.args[1]["summary"], "PHD Banka")
            self.tmux.session_options["@devd_session_name"] = ""
            title_module.status({"sessionId": "g2", "prompt": "Next"}, "prompt_submit", self.tmux.pane, self.codex_home, self.grok_home, "grok")
            # Grok's fresh auto title is already in this event's summary, not the next one's.
            self.assertEqual(emit.call_args.args[1]["summary"], "Grok · Next")

    def test_status_summary_failure_never_suppresses_event(self):
        def broken(*args):
            if args[0] == "display-message" and args[-1] == title_module.TITLE_FORMAT:
                raise subprocess.TimeoutExpired("tmux", 0.5)
            return self.tmux(*args)
        self.tmux_mock.side_effect = broken
        with mock.patch.object(title_module, "write_status", create=True) as emit:
            title_module.status({"session_id": "root"}, "stop", self.tmux.pane, self.codex_home, self.grok_home, "codex")
            emit.assert_called_once()
            self.assertNotIn("summary", emit.call_args.args[1])

    def test_codex_status_changes_only_badge_not_session_title(self):
        self.tmux.pane_options["@devd_auto_title"] = "My session"
        with mock.patch.object(title_module, "write_status") as emit, mock.patch.object(title_module, "sync") as sync:
            for event, extra in [("prompt_submit", {"prompt": "Different title"}),
                                 ("pre_tool_use", {"tool_name": "request_user_input_async"}),
                                 ("prompt_submit", {"prompt": "Answer"}), ("stop", {})]:
                title_module.status({"session_id": "root", **extra}, event, self.tmux.pane, self.codex_home, self.grok_home, "codex")
            sync.assert_not_called()
            self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "My session")
            # Summary mirrors the session title; a prompt never becomes it.
            self.assertTrue(all(call.args[1]["summary"] == "My session" for call in emit.call_args_list))
            self.assertEqual([call.args[1]["event"] for call in emit.call_args_list],
                             ["prompt_submit", "permission_request", "prompt_submit", "stop"])

    def test_grok_status_keeps_logical_identity_and_title(self):
        with mock.patch.object(title_module, "write_status", create=True) as emit:
            title_module.status({"sessionId": "grok", "prompt": "Fix website"}, "prompt_submit", self.tmux.pane, self.codex_home, self.grok_home, "grok")
            self.assertEqual(emit.call_args.args[1]["agent"], "grok")
            self.assertEqual(json.loads(self.tmux.pane_options["@devd_warp_state"])["agent"], "grok")
            self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "Grok · Fix website")
            title_module.status({"sessionId": "next-grok", "prompt": "x" * 200}, "prompt_submit", self.tmux.pane, self.codex_home, self.grok_home, "grok")
            self.assertEqual(len(self.tmux.pane_options["@devd_auto_title"]), 80)

    def test_grok_question_and_cancelled_previous_prompt_do_not_corrupt_work(self):
        with mock.patch.object(title_module, "write_status") as emit:
            for event, extra in (
                ("prompt_submit", {"promptId": "turn-1"}),
                ("pre_tool_use", {"toolName": "GrokBuild:ask_user_question", "toolUseId": "question"}),
                ("tool_complete", {"toolName": "Bash", "toolUseId": "background"}),
                ("tool_complete", {"toolName": "ask_user_question", "toolUseId": "question"}),
                ("prompt_submit", {"promptId": "turn-2"}),
                ("stop", {"promptId": "turn-1"}),
                ("stop_failure", {"promptId": "turn-2", "error": "rate_limit"}),
            ):
                title_module.status({"sessionId": "grok", **extra}, event, self.tmux.pane,
                                    self.codex_home, self.grok_home, "grok")
            self.assertEqual([c.args[1]["event"] for c in emit.call_args_list],
                             ["prompt_submit", "permission_request", "tool_complete", "prompt_submit", "stop_failure"])
            self.assertEqual(emit.call_args.args[1]["error_type"], "rate_limit")

    def test_antigravity_shows_claude_badge_but_recovery_keeps_agy_owner(self):
        # Antigravity (agy) has no Warp plugin: Warp sees the Claude badge, while the
        # recovery checkpoint keeps the logical owner so resume uses `--conversation`.
        sid = "agy-conv-1"
        # A same-id Codex child row proves agy never consults Codex metadata.
        self.database(sid=sid, name="Codex child", metadata={"thread_source": "subagent"})
        tty = self.directory / "pane-tty"
        tty.write_text("")

        def tmux(*args):
            if args[0] == "display-message" and args[-1] == "#{socket_path}:#{pid}":
                return "/tmp/tmux-sock:1"
            if args[0] == "display-message" and args[-1] == "#{pane_tty}":
                return str(tty)
            return self.tmux(*args)
        self.tmux_mock.side_effect = tmux
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(title_module, "recovery_checkpoint") as checkpoint, \
             mock.patch.object(title_module.sys, "argv", [str(HELPER), "--status", "prompt_submit"]), \
             mock.patch.object(title_module.sys, "stdin", io.StringIO(json.dumps(
                 {"session_id": sid, "conversationId": sid, "cwd": "/workspace/app"}))), \
             mock.patch.dict(title_module.os.environ, {
                 "TMUX_PANE": self.tmux.pane, "CODEX_HOME": str(self.codex_home),
                 "GROK_HOME": str(self.grok_home), "DEVD_WARP_AGENT": "agy",
                 "DEVD_WARP_GROK_NATIVE": "1",
             }), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            title_module.main()
        self.assertEqual((stdout.getvalue(), stderr.getvalue()), ("", ""))
        wire = tty.read_text()
        self.assertTrue(wire.startswith("\x1bPtmux;"))
        payload = json.loads(wire.split("warp://cli-agent;", 1)[1].split("\x07", 1)[0])
        self.assertEqual((payload["agent"], payload["event"], payload["session_id"]),
                         ("claude", "prompt_submit", sid))
        self.assertNotIn("plugin_version", payload)
        self.assertEqual(json.loads(self.tmux.pane_options["@devd_warp_state"])["agent"], "agy")
        checkpoint.assert_called_once()
        pane, state, cwd = checkpoint.call_args.args
        self.assertEqual((pane, state["agent"], state["session_id"], state["event"], cwd),
                         ("%17", "agy", sid, "prompt_submit", "/workspace/app"))
        # agy owns no title store; the pane title stays untouched.
        self.assertNotIn("@devd_auto_title", self.tmux.pane_options)

    def test_antigravity_title_lookup_never_reads_codex_or_grok_stores(self):
        self.database(sid="agy-2", name="Codex name")
        self.summary(sid="agy-2", generated_title="Grok name")
        with mock.patch.dict(title_module.os.environ, {"DEVD_WARP_AGENT": "agy"}):
            for data in ({"session_id": "agy-2"}, {"session_id": "agy-2", "sessionId": "agy-2"}):
                self.assertEqual(title_module.saved_title(data, "agy-2", self.codex_home, self.grok_home), "")
            self.sync({"session_id": "agy-2", "prompt": "Opravit web"})
        self.assertEqual(self.tmux.pane_options["@devd_auto_title"], "Opravit web")

    def test_claude_claims_pane_and_recovers_after_critic_blocks_stop(self):
        with mock.patch.object(title_module, "write_status") as emit:
            title_module.status({"session_id": "old-codex"}, "prompt_submit", self.tmux.pane,
                                self.codex_home, self.grok_home, "codex")
            for event in ("session_start", "prompt_submit", "stop", "pre_tool_use", "tool_complete"):
                title_module.status({"session_id": "claude", "tool_name": "Bash"}, event, self.tmux.pane,
                                    self.codex_home, self.grok_home, "claude", terminal_sequence=True)
            before = emit.call_count
            title_module.status({"session_id": "old-codex"}, "stop", self.tmux.pane,
                                self.codex_home, self.grok_home, "codex")
            self.assertEqual(emit.call_count, before)
            self.assertEqual([c.args[1]["event"] for c in emit.call_args_list],
                             ["prompt_submit", "session_start", "prompt_submit", "stop", "tool_complete", "tool_complete"])
            self.assertTrue(all(c.kwargs.get("terminal_sequence") for c in emit.call_args_list[1:]))

    def emitted_agents(self, events):
        with mock.patch("builtins.open", mock.mock_open()):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                for agent, sid, event in events:
                    title_module.status({"session_id": sid}, event, self.tmux.pane, self.codex_home,
                                        self.grok_home, agent, terminal_sequence=True)
        return [json.loads(json.loads(line)["terminalSequence"].split(";", 3)[3].rstrip("\x07"))["agent"]
                for line in out.getvalue().splitlines()]

    def test_warp_locked_tab_keeps_first_agent_until_a_new_dev_block(self):
        # Measured live: Codex, then `cc` in the same pane during one `dev` kept the
        # Codex icon and Warp dropped every Claude toast. Only a fresh `dev` switched it.
        self.tmux.session_options["@devd_warp_block"] = "100-a"
        agents = self.emitted_agents([("codex", "old-codex", "prompt_submit"),
                                      ("claude", "claude", "session_start"),
                                      ("claude", "claude", "stop")])
        self.assertEqual(agents, ["codex", "codex", "codex"])
        self.assertEqual(len(self.tmux.messages), 1)  # One hint per block and agent, not per event.
        self.assertIn("Warp keeps this tab as Codex", self.tmux.messages[0])
        self.assertIn("For the Claude Code icon", self.tmux.messages[0])
        self.tmux.session_options["@devd_warp_block"] = "200-b"  # New `dev` = new Warp block.
        self.assertEqual(self.emitted_agents([("claude", "claude", "prompt_submit")]), ["claude"])
        self.assertEqual(len(self.tmux.messages), 1)

    def test_without_block_id_agents_are_never_relabelled(self):
        # Older Mac CLI (or not Warp): the lock is unknown, keep today's behaviour.
        agents = self.emitted_agents([("codex", "old-codex", "prompt_submit"), ("claude", "claude", "prompt_submit")])
        self.assertEqual(agents, ["codex", "claude"])
        self.assertEqual(self.tmux.messages, [])

    def test_same_name_background_tool_cannot_clear_pending_permission(self):
        for id_key in ("tool_use_id", "tool_call_id"):
            with self.subTest(id_key=id_key), mock.patch.object(title_module, "write_status") as emit:
                for event, call_id in (("prompt_submit", ""), ("permission_request", "waiting-B"),
                                       ("tool_complete", "older-A"), ("tool_complete", "waiting-B")):
                    title_module.status({"session_id": "root", "tool_name": "exec_command", id_key: call_id},
                                        event, self.tmux.pane, self.codex_home, self.grok_home, "codex")
                self.assertEqual([call.args[1]["event"] for call in emit.call_args_list],
                                 ["prompt_submit", "permission_request", "tool_complete"])

    def test_recovery_records_only_accepted_foreground_state(self):
        with mock.patch.object(title_module, "write_status"), \
             mock.patch.object(title_module, "recovery_checkpoint") as checkpoint:
            title_module.status({"session_id": "root", "cwd": "/workspace"}, "prompt_submit",
                                self.tmux.pane, self.codex_home, self.grok_home, "codex")
            self.assertEqual(checkpoint.call_count, 1)
            pane, state, cwd = checkpoint.call_args.args
            self.assertEqual((pane, state["session_id"], state["event"], cwd),
                             ("%17", "root", "prompt_submit", "/workspace"))
            for data in ({"session_id": "old"}, {"session_id": "child", "agent_id": "child"}):
                title_module.status(data, "stop", self.tmux.pane,
                                    self.codex_home, self.grok_home, "codex")
            self.assertEqual(checkpoint.call_count, 1)

    def test_checkpoint_timeout_cannot_change_hook_verdict(self):
        with mock.patch.object(title_module.os, "access", return_value=True), \
             mock.patch.object(title_module.subprocess, "run", side_effect=subprocess.TimeoutExpired("recovery", .75)), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            title_module.recovery_checkpoint("%17", {"session_id": "root"}, "/workspace")
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
