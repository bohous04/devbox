import contextlib
import fcntl
import importlib.util
import json
from pathlib import Path
import os
import resource
import socket
import sqlite3
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("transfer", Path(__file__).parents[1] / "src/codexConversationTransfer.py")
transfer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(transfer)
ROOT = "11111111-1111-4111-8111-111111111111"
CHILD = "22222222-2222-4222-8222-222222222222"
OTHER = "33333333-3333-4333-8333-333333333333"


def initialize(home):
    home.mkdir()
    with contextlib.closing(sqlite3.connect(home / "state_5.sqlite")) as db, db:
        db.executescript("""
          CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, source TEXT, cwd TEXT,
            title TEXT, archived INTEGER, archived_at INTEGER, history_mode TEXT, project_id TEXT);
          CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT);
          CREATE TABLE thread_dynamic_tools (thread_id TEXT, position INTEGER, name TEXT, PRIMARY KEY(thread_id,position));
          CREATE TABLE thread_artifacts (id TEXT PRIMARY KEY, thread_id TEXT, payload TEXT);
          CREATE TABLE remote_control_enrollments (account_id TEXT PRIMARY KEY, secret TEXT);
        """)
        db.execute("INSERT INTO remote_control_enrollments VALUES (?,?)", (home.name, "private-" + home.name))
    with contextlib.closing(sqlite3.connect(home / "goals_1.sqlite")) as db, db:
        db.execute("CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT)")
    with contextlib.closing(sqlite3.connect(home / "queue_1.sqlite")) as db, db:
        db.execute("CREATE TABLE queued_items (id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT)")
    with contextlib.closing(sqlite3.connect(home / "thread_history_1.sqlite")) as db, db:
        db.execute("CREATE TABLE thread_items (thread_id TEXT, item_id TEXT, item_json TEXT, PRIMARY KEY(thread_id,item_id))")
    (home / "auth.json").write_text("credentials-" + home.name)


def add_thread(home, ident, parent=None, archived=False, base=None):
    directory = home / ("archived_sessions" if archived else "sessions/2026/09/11")
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / ("rollout-2026-09-11T00-00-00-" + ident + ".jsonl")
    meta = {"id": ident, "cwd": "/workspace", "history_mode": "paginated"}
    if base:
        meta["history_base"] = {"thread_id": base, "ordinal": 3}
    path.write_text(json.dumps({"type": "session_meta", "payload": meta}) + "\n" +
                    json.dumps({"type": "response_item", "payload": {"role": "user", "content": "kept context"}}) + "\n")
    source = json.dumps({"subagent": {"thread_spawn": {"parent_thread_id": parent}}}) if parent else "cli"
    with contextlib.closing(sqlite3.connect(home / "state_5.sqlite")) as db, db:
        db.execute("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)",
                   (ident, str(path), source, "/workspace", "Private title", int(archived), 123 if archived else None, "paginated", "old-project"))
        if parent:
            db.execute("INSERT INTO thread_spawn_edges VALUES (?,?,?)", (parent, ident, "closed"))
        db.execute("INSERT INTO thread_dynamic_tools VALUES (?,0,'kept_tool')", (ident,))
    return path


class FakeRpc:
    calls = []
    timeouts = []

    def __init__(self, home, **kwargs):
        self.home = home

    def close(self):
        pass

    def call(self, method, params, timeout=None):
        self.calls.append((self.home.name, method, dict(params)))
        self.timeouts.append((method, timeout))
        if method == "thread/loaded/list":
            return {"data": []}
        ident = params["threadId"]
        rows, edges = transfer.rows_and_edges(self.home)
        if method in ("thread/archive", "thread/unarchive"):
            selected = transfer.subtree(rows, edges, ident) if method == "thread/archive" else {ident}
            for value in selected:
                row = rows[value]
                archived = method == "thread/archive"
                if bool(row["archived"]) == archived:
                    continue
                path = Path(row["rollout_path"])
                destination = self.home / ("archived_sessions" if archived else "sessions/2026/09/11") / path.name
                destination.parent.mkdir(parents=True, exist_ok=True)
                path.rename(destination)
                with contextlib.closing(sqlite3.connect(self.home / "state_5.sqlite")) as db, db:
                    db.execute("UPDATE threads SET rollout_path=?,archived=?,archived_at=? WHERE id=?",
                               (str(destination), int(archived), 456 if archived else None, value))
            return {}
        if method == "thread/read":
            return {"thread": {"id": ident, "cwd": rows[ident]["cwd"]}}
        raise AssertionError("Unexpected method")


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name).resolve()
        self.source, self.target = root / "source", root / "target"
        initialize(self.source)
        initialize(self.target)
        FakeRpc.calls = []
        FakeRpc.timeouts = []

    def tearDown(self):
        self.temp.cleanup()

    def run_transfer(self, source=None, target=None):
        return transfer.transfer(source or self.source, target or self.target, ROOT, FakeRpc)

    def test_exact_subtree_context_goals_queue_and_graph_without_account_data(self):
        add_thread(self.source, ROOT)
        add_thread(self.source, CHILD, ROOT, archived=True)
        add_thread(self.target, OTHER)
        with contextlib.closing(sqlite3.connect(self.source / "goals_1.sqlite")) as db, db:
            db.execute("INSERT INTO thread_goals VALUES (?, 'Finish the work', 'active')", (ROOT,))
        with contextlib.closing(sqlite3.connect(self.source / "queue_1.sqlite")) as db, db:
            db.execute("INSERT INTO queued_items VALUES ('queue1', ?, 'pending user message')", (ROOT,))
        with contextlib.closing(sqlite3.connect(self.source / "thread_history_1.sqlite")) as db, db:
            db.execute("INSERT INTO thread_items VALUES (?, 'item1', 'kept paginated content')", (CHILD,))
        result = self.run_transfer()
        self.assertEqual(result["transferredIds"], [ROOT, CHILD])
        self.assertEqual(result["cwd"], "/workspace")
        source_rows, _ = transfer.rows_and_edges(self.source)
        target_rows, target_edges = transfer.rows_and_edges(self.target)
        self.assertTrue(source_rows[ROOT]["archived"])
        self.assertFalse(target_rows[ROOT]["archived"])
        self.assertTrue(target_rows[CHILD]["archived"])
        self.assertFalse(target_rows[OTHER]["archived"])
        self.assertIsNone(target_rows[ROOT]["project_id"])
        self.assertEqual(target_edges, [{"parent_thread_id": ROOT, "child_thread_id": CHILD, "status": "closed"}])
        self.assertEqual(Path(source_rows[ROOT]["rollout_path"]).read_bytes(), Path(target_rows[ROOT]["rollout_path"]).read_bytes())
        self.assertEqual((self.target / "auth.json").read_text(), "credentials-target")
        with contextlib.closing(sqlite3.connect(self.target / "state_5.sqlite")) as db, db:
            self.assertEqual(db.execute("SELECT * FROM remote_control_enrollments").fetchall(), [("target", "private-target")])
        with contextlib.closing(sqlite3.connect(self.target / "goals_1.sqlite")) as db, db:
            self.assertEqual(db.execute("SELECT objective FROM thread_goals").fetchone()[0], "Finish the work")
        with contextlib.closing(sqlite3.connect(self.target / "queue_1.sqlite")) as db, db:
            self.assertEqual(db.execute("SELECT payload_json FROM queued_items").fetchone()[0], "pending user message")
        with contextlib.closing(sqlite3.connect(self.target / "thread_history_1.sqlite")) as db, db:
            self.assertEqual(db.execute("SELECT item_json FROM thread_items").fetchone()[0], "kept paginated content")

    def test_roundtrip_keeps_newer_context_and_same_id(self):
        add_thread(self.source, ROOT)
        self.run_transfer()
        row = transfer.rows_and_edges(self.target)[0][ROOT]
        with Path(row["rollout_path"]).open("a") as stream:
            stream.write(json.dumps({"type": "response_item", "payload": {"role": "assistant", "content": "new account continuation"}}) + "\n")
        result = self.run_transfer(self.target, self.source)
        self.assertEqual(result["threadId"], ROOT)
        row = transfer.rows_and_edges(self.source)[0][ROOT]
        self.assertIn("new account continuation", Path(row["rollout_path"]).read_text())
        self.assertFalse(row["archived"])

    def test_diverged_rollout_refuses_without_overwrite_and_restores_source(self):
        add_thread(self.source, ROOT)
        self.run_transfer()
        original = transfer.rows_and_edges(self.source)[0][ROOT]
        with Path(original["rollout_path"]).open("a") as stream:
            stream.write('{"type":"independent-edit"}\n')
        before = Path(original["rollout_path"]).read_bytes()
        with self.assertRaisesRegex(transfer.TransferError, "independently"):
            self.run_transfer(self.target, self.source)
        self.assertEqual(Path(transfer.rows_and_edges(self.source)[0][ROOT]["rollout_path"]).read_bytes(), before)
        self.assertFalse(transfer.rows_and_edges(self.target)[0][ROOT]["archived"])

    def test_receipt_catches_independent_queued_input_even_with_identical_rollout(self):
        add_thread(self.source, ROOT)
        self.run_transfer()
        with contextlib.closing(sqlite3.connect(self.source / "queue_1.sqlite")) as db, db:
            db.execute("INSERT INTO queued_items VALUES ('new', ?, 'must not disappear')", (ROOT,))
        with self.assertRaisesRegex(transfer.TransferError, "inactive conversation changed"):
            self.run_transfer(self.target, self.source)
        with contextlib.closing(sqlite3.connect(self.source / "queue_1.sqlite")) as db, db:
            self.assertEqual(db.execute("SELECT payload_json FROM queued_items").fetchone()[0], "must not disappear")

    def test_writer_resumed_after_archive_blocks_transfer(self):
        add_thread(self.source, ROOT)
        directory = self.source / "thread-writer-locks"
        directory.mkdir()
        with (directory / (ROOT + ".lock")).open("w") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(transfer.TransferError, "active writer"):
                self.run_transfer()
        self.assertNotIn(ROOT, transfer.rows_and_edges(self.target)[0])
        self.assertFalse(transfer.rows_and_edges(self.source)[0][ROOT]["archived"])

    def test_sql_failure_restores_files_and_unrelated_rows(self):
        add_thread(self.source, ROOT)
        add_thread(self.target, OTHER)
        with contextlib.closing(sqlite3.connect(self.source / "state_5.sqlite")) as db, db:
            db.execute("INSERT INTO thread_artifacts VALUES ('collision', ?, 'source artifact')", (ROOT,))
        with contextlib.closing(sqlite3.connect(self.target / "state_5.sqlite")) as db, db:
            db.execute("INSERT INTO thread_artifacts VALUES ('collision', ?, 'unrelated artifact')", (OTHER,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.run_transfer()
        self.assertNotIn(ROOT, transfer.rows_and_edges(self.target)[0])
        self.assertFalse(transfer.rows_and_edges(self.source)[0][ROOT]["archived"])
        self.assertEqual(list((self.target / "archived_sessions").glob("*.jsonl")), [])
        with contextlib.closing(sqlite3.connect(self.target / "state_5.sqlite")) as db, db:
            self.assertEqual(db.execute("SELECT payload FROM thread_artifacts").fetchone()[0], "unrelated artifact")

    def test_missing_required_history_fails_before_archive_but_provenance_is_allowed(self):
        path = add_thread(self.source, ROOT, base=OTHER)
        with self.assertRaisesRegex(transfer.TransferError, "ancestor conversation rollout is missing"):
            self.run_transfer()
        self.assertEqual(FakeRpc.calls, [])
        items = [json.loads(line) for line in path.read_text().splitlines()]
        del items[0]["payload"]["history_base"]
        items[0]["payload"]["forked_from_id"] = OTHER
        items[0]["payload"]["base_instructions"] = "ordinary embedded context is retained"
        path.write_text("".join(json.dumps(item) + "\n" for item in items))
        self.assertTrue(self.run_transfer()["ok"])

    def test_required_ancestor_rollout_is_copied_without_archiving_its_other_children(self):
        add_thread(self.source, OTHER)
        add_thread(self.source, CHILD, OTHER)
        add_thread(self.source, ROOT, base=OTHER)
        self.assertTrue(self.run_transfer()["ok"])
        source_rows, _ = transfer.rows_and_edges(self.source)
        target_rows, _ = transfer.rows_and_edges(self.target)
        self.assertFalse(source_rows[OTHER]["archived"])
        self.assertFalse(source_rows[CHILD]["archived"])
        self.assertNotIn(CHILD, target_rows)
        histories = transfer.scan_rollouts(self.target, {ROOT})
        self.assertEqual(set(histories), {ROOT, OTHER})
        self.assertTrue(self.run_transfer(self.target, self.source)["ok"])
        self.assertEqual(set(transfer.scan_rollouts(self.source, {ROOT})), {ROOT, OTHER})

    def test_symlink_history_is_rejected_without_archive(self):
        path = add_thread(self.source, ROOT)
        payload = path.read_bytes()
        path.unlink()
        outside = self.source.parent / "outside.jsonl"
        outside.write_bytes(payload)
        path.symlink_to(outside)
        with self.assertRaises(transfer.TransferError):
            self.run_transfer()
        self.assertEqual(FakeRpc.calls, [])

    def test_no_running_server_verify_does_not_start_temporary_server(self):
        add_thread(self.source, ROOT)
        with self.assertRaisesRegex(transfer.TransferError, "writer could not be verified"):
            transfer.verify(self.source, ROOT, rpc_factory=lambda *args, **kwargs: self.fail("must not start a server"))

    def legacy_default_home(self):
        """Point the default-home constants at the test source account."""
        legacy = self.source.parent / "codex-remote-home"
        saved = transfer.DEFAULT_HOME, transfer.LEGACY_REMOTE_HOME
        transfer.DEFAULT_HOME, transfer.LEGACY_REMOTE_HOME = self.source, legacy
        self.addCleanup(lambda: setattr(transfer, "DEFAULT_HOME", saved[0]) or setattr(transfer, "LEGACY_REMOTE_HOME", saved[1]))
        path = add_thread(self.source, ROOT)
        with contextlib.closing(sqlite3.connect(self.source / "state_5.sqlite")) as db, db:
            db.execute("UPDATE threads SET rollout_path=? WHERE id=?", (str(legacy / path.relative_to(self.source)), ROOT))
        return legacy

    def test_default_home_verifies_rows_recorded_with_the_legacy_central_server_home(self):
        self.legacy_default_home()
        (self.source / "app-server-control").mkdir()
        (self.source / "app-server-control" / "app-server-control.sock").touch()

        class Loaded(FakeRpc):
            def call(self, method, params):
                return {"data": [ROOT]} if method == "thread/loaded/list" else super().call(method, params)
        self.assertEqual(transfer.verify(self.source, ROOT, rpc_factory=Loaded)["threadId"], ROOT)

    def test_default_home_transfers_rows_recorded_with_the_legacy_central_server_home(self):
        self.legacy_default_home()
        self.assertEqual(self.run_transfer()["transferredIds"], [ROOT])
        target_rows, _ = transfer.rows_and_edges(self.target)
        self.assertTrue(Path(target_rows[ROOT]["rollout_path"]).is_relative_to(self.target))

    def test_legacy_central_server_paths_are_only_accepted_for_the_default_home(self):
        legacy = self.legacy_default_home()
        transfer.DEFAULT_HOME = self.target
        with self.assertRaisesRegex(transfer.TransferError, "outside its account home"):
            self.run_transfer()
        self.assertEqual(transfer.account_path(self.source, legacy / "auth.json"), legacy / "auth.json")
        self.assertEqual(FakeRpc.calls, [])

    def test_grant_full_access_updates_only_a_loaded_thread_on_the_running_server(self):
        with self.assertRaisesRegex(transfer.TransferError, "server is not running"):
            transfer.grant_full_access(self.source, ROOT, rpc_factory=FakeRpc)
        (self.source / "app-server-control").mkdir()
        (self.source / "app-server-control" / "app-server-control.sock").touch()
        with self.assertRaisesRegex(transfer.TransferError, "not loaded"):
            transfer.grant_full_access(self.source, ROOT, rpc_factory=FakeRpc)

        class Loaded(FakeRpc):
            def call(self, method, params):
                if method == "thread/loaded/list":
                    return {"data": [ROOT]}
                self.calls.append((self.home.name, method, dict(params)))
                return {}
        self.assertEqual(transfer.grant_full_access(self.source, ROOT, rpc_factory=Loaded), {"ok": True, "threadId": ROOT})
        self.assertEqual(FakeRpc.calls[-1], ("source", "thread/settings/update",
                         {"threadId": ROOT, "approvalPolicy": "never", "sandboxPolicy": {"type": "dangerFullAccess"}}))

    def test_lazy_aux_schema_copies_only_selected_rows_and_migration_metadata(self):
        add_thread(self.source, ROOT)
        add_thread(self.source, OTHER)
        with contextlib.closing(sqlite3.connect(self.source / "thread_history_1.sqlite")) as db, db:
            db.execute("CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, checksum BLOB)")
            db.execute("INSERT INTO _sqlx_migrations VALUES (1, ?)", (b"native-checksum",))
            db.execute("INSERT INTO thread_items VALUES (?, 'selected', 'selected history')", (ROOT,))
            db.execute("INSERT INTO thread_items VALUES (?, 'private-other', 'unrelated private history')", (OTHER,))
        (self.target / "thread_history_1.sqlite").unlink()
        (self.target / "goals_1.sqlite").unlink()
        self.assertTrue(self.run_transfer()["ok"])
        self.assertFalse((self.target / "goals_1.sqlite").exists())
        with contextlib.closing(sqlite3.connect(self.target / "thread_history_1.sqlite")) as db, db:
            self.assertEqual(db.execute("SELECT * FROM _sqlx_migrations").fetchall(), [(1, b"native-checksum")])
            self.assertEqual(db.execute("SELECT item_id FROM thread_items").fetchall(), [("selected",)])

    def test_target_extra_descendant_is_not_discarded(self):
        add_thread(self.source, ROOT)
        add_thread(self.target, ROOT)
        add_thread(self.target, CHILD, ROOT)
        with self.assertRaisesRegex(transfer.TransferError, "different conversation branch"):
            self.run_transfer()
        self.assertFalse(transfer.rows_and_edges(self.source)[0][ROOT]["archived"])
        self.assertIn(CHILD, transfer.rows_and_edges(self.target)[0])

    def test_protected_descendant_refuses_before_archiving_either_account(self):
        add_thread(self.source, ROOT)
        add_thread(self.source, CHILD, ROOT)
        with self.assertRaisesRegex(transfer.TransferError, "already running on the selected account"):
            transfer.transfer(self.source, self.target, ROOT, FakeRpc, protected_thread_ids=[CHILD])
        self.assertEqual(FakeRpc.calls, [])
        self.assertFalse(transfer.rows_and_edges(self.source)[0][ROOT]["archived"])

    def test_lost_success_reply_can_be_recovered_idempotently(self):
        add_thread(self.source, ROOT)
        first = self.run_transfer()
        second = self.run_transfer()
        self.assertEqual(first["threadId"], second["threadId"])
        self.assertTrue(second["recovered"])

    def test_hundreds_of_subagents_transfer_under_a_low_descriptor_limit(self):
        add_thread(self.source, ROOT)
        children = ["%08x-0000-4000-8000-%012x" % (n, n) for n in range(1, 601)]
        for child in children:
            add_thread(self.source, child, ROOT)
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        # Low relative to the 601 conversations, but above what this test process already
        # holds open: under unittest discovery earlier tests can leave many descriptors
        # around (CI on Linux), and a fixed 256 then fails before the transfer even starts.
        already_open = len(os.listdir("/dev/fd"))
        resource.setrlimit(resource.RLIMIT_NOFILE, (max(256, already_open + 64), hard))
        try:
            result = self.run_transfer()
        finally:
            resource.setrlimit(resource.RLIMIT_NOFILE, (soft, hard))
        self.assertEqual(len(result["transferredIds"]), 601)
        self.assertTrue(all(transfer.rows_and_edges(self.target)[0][c]["archived"] is not None for c in children))
        self.assertIn(("thread/archive", transfer.ARCHIVE_TIMEOUT), FakeRpc.timeouts)

    def test_newer_source_history_columns_are_dropped_for_an_older_destination(self):
        add_thread(self.source, ROOT)
        with contextlib.closing(sqlite3.connect(self.source / "thread_history_1.sqlite")) as db, db:
            db.execute("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, root_turn_id TEXT, PRIMARY KEY(thread_id,turn_id))")
            db.execute("INSERT INTO thread_turns VALUES (?, 'turn1', 'root1')", (ROOT,))
        with contextlib.closing(sqlite3.connect(self.target / "thread_history_1.sqlite")) as db, db:
            db.execute("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, PRIMARY KEY(thread_id,turn_id))")
        self.assertTrue(self.run_transfer()["ok"])
        with contextlib.closing(sqlite3.connect(self.target / "thread_history_1.sqlite")) as db, db:
            self.assertEqual(db.execute("SELECT * FROM thread_turns").fetchall(), [(ROOT, "turn1")])

    def test_newer_source_columns_outside_history_projections_still_refuse(self):
        add_thread(self.source, ROOT)
        with contextlib.closing(sqlite3.connect(self.source / "goals_1.sqlite")) as db, db:
            db.execute("ALTER TABLE thread_goals ADD COLUMN priority TEXT")
            db.execute("INSERT INTO thread_goals VALUES (?, 'Finish', 'active', 'high')", (ROOT,))
        with self.assertRaisesRegex(transfer.TransferError, "incompatible"):
            self.run_transfer()
        self.assertFalse(transfer.rows_and_edges(self.source)[0][ROOT]["archived"])


class SocketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir="/tmp")
        self.root = Path(self.temp.name).resolve()
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.close()
        self.temp.cleanup()

    def bind(self, path):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(path))
        self.servers.append(server)

    def test_daemon_socket_symlink_to_a_sibling_is_accepted(self):
        directory = self.root / "app-server-control"
        directory.mkdir()
        self.bind(directory / ".app-server-control.sock.daemon")
        (directory / "app-server-control.sock").symlink_to(".app-server-control.sock.daemon")
        self.assertTrue(transfer.safe_socket(directory / "app-server-control.sock"))

    def test_socket_symlink_leaving_the_directory_is_refused(self):
        directory = self.root / "app-server-control"
        directory.mkdir()
        self.bind(self.root / "elsewhere.sock")
        (directory / "app-server-control.sock").symlink_to(self.root / "elsewhere.sock")
        self.assertFalse(transfer.safe_socket(directory / "app-server-control.sock"))


if __name__ == "__main__":
    unittest.main()
