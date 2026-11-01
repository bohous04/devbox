"""python3 -m unittest discover -s devd/test -p 'codexCentralState_test.py'."""

import contextlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[2] / "tools/codex-central-state.py"
SPEC = importlib.util.spec_from_file_location("codex_central_state", SCRIPT)
central = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(central)
ROOT = "019a0000-0000-7000-8000-000000000001"
OTHER = "019a0000-0000-7000-8000-000000000002"
HOST_IDENTITY = b"11111111-1111-4111-8111-111111111111"
SHARED_IDENTITY = b"22222222-2222-4222-8222-222222222222"
ENROLLMENT = ("wss://host.example/control", "test-private-account", "", "test-original-server",
              "test-original-environment", "Original permanent host", 12345, 1)
ENROLLMENT_SCHEMA = """
CREATE TABLE remote_control_enrollments (
 websocket_url TEXT NOT NULL, account_id TEXT NOT NULL, app_server_client_name TEXT NOT NULL,
 server_id TEXT NOT NULL, environment_id TEXT NOT NULL, server_name TEXT NOT NULL,
 updated_at INTEGER NOT NULL, remote_control_enabled INTEGER,
 PRIMARY KEY(websocket_url,account_id,app_server_client_name)
);
"""


def files(home):
    return {str(path.relative_to(home)): path.read_bytes() for path in home.rglob("*") if path.is_file()}


class CodexCentralStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.host, self.shared, self.private = (self.base / name for name in ("host", "shared", "private"))
        self.host.mkdir()
        self.shared.mkdir()
        (self.host / "installation_id").write_bytes(HOST_IDENTITY)
        (self.shared / "installation_id").write_bytes(SHARED_IDENTITY)
        for home in (self.host, self.shared):
            (home / "auth.json").write_text(json.dumps({"auth_mode": "chatgpt", "tokens": {"account_id": ENROLLMENT[1]}}))
        with contextlib.closing(sqlite3.connect(self.host / "state_5.sqlite")) as db, db:
            db.executescript(ENROLLMENT_SCHEMA)
            db.execute("INSERT INTO remote_control_enrollments VALUES (?,?,?,?,?,?,?,?)", ENROLLMENT)
        with contextlib.closing(sqlite3.connect(self.shared / "state_5.sqlite")) as db, db:
            db.executescript(ENROLLMENT_SCHEMA + """
                CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, rollout_path TEXT,
                                      title TEXT, updated_at INTEGER, recency_at INTEGER,
                                      created_at INTEGER DEFAULT 100, created_at_ms INTEGER DEFAULT 100001);
                CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
                CREATE TABLE thread_artifacts (thread_id TEXT, payload TEXT);
                CREATE TABLE thread_dynamic_tools (thread_id TEXT, name TEXT);
            """)
            for thread_id in (ROOT, OTHER):
                relative = f"sessions/2026/09/08/rollout-{thread_id}.jsonl"
                path = self.shared / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((json.dumps({"type": "session_meta", "payload": {"id": thread_id, "cwd": "/workspace"}}) + "\n").encode())
                db.execute("INSERT INTO threads(id,source,cwd,rollout_path,title,updated_at,recency_at) VALUES (?, 'cli', '/workspace', ?, 'Kept conversation', 123, 123)",
                           (thread_id, "/home/dev/.codex/" + relative))
                db.execute("INSERT INTO thread_artifacts VALUES (?, 'kept artifact')", (thread_id,))
                db.execute("INSERT INTO thread_dynamic_tools VALUES (?, 'kept tool')", (thread_id,))
        for name, tables in central.HISTORY_TABLES.items():
            if name == "state_5.sqlite":
                continue
            with contextlib.closing(sqlite3.connect(self.shared / name)) as db, db:
                for table in tables:
                    db.execute(f'CREATE TABLE "{table}" (thread_id TEXT, value TEXT, rollout_byte_offset INTEGER)')
                    db.executemany(f'INSERT INTO "{table}" VALUES (?,?,?)', [(ROOT, "root retained history", 123), (OTHER, "other live history", 456)])
        (self.shared / "thread-writer-locks").mkdir()
        for thread_id in (ROOT, OTHER):
            (self.shared / "thread-writer-locks" / f"{thread_id}.lock").touch()
        shutil.copytree(self.shared, self.private)
        with contextlib.closing(sqlite3.connect(self.private / "state_5.sqlite")) as db, db:
            db.execute("UPDATE threads SET rollout_path=REPLACE(rollout_path,'/home/dev/.codex/','/home/dev/.codex/private/'), updated_at=999,recency_at=999,created_at_ms=100008")

    def install(self, **options):
        return central.install_host_identity(host_home=self.host, shared_home=self.shared, **options)

    def rejoin(self, **options):
        return central.verify_rejoin(private_home=self.private, shared_home=self.shared,
                                     private_runtime_home="/home/dev/.codex/private", shared_runtime_home="/home/dev/.codex",
                                     roots=[ROOT], **options)

    def enrollment(self, home):
        with contextlib.closing(sqlite3.connect(home / "state_5.sqlite")) as db, db:
            return db.execute("SELECT * FROM remote_control_enrollments").fetchall()

    def test_identity_dry_run_is_read_only_and_does_not_print_identity_values(self):
        host_before, shared_before = files(self.host), files(self.shared)
        result = self.install()
        self.assertEqual(result["status"], "dry_run")
        self.assertTrue(result["installation_identity_changes"])
        self.assertEqual(files(self.host), host_before)
        self.assertEqual(files(self.shared), shared_before)
        output = json.dumps(result)
        for value in (HOST_IDENTITY.decode(), SHARED_IDENTITY.decode(), ENROLLMENT[1], ENROLLMENT[3], ENROLLMENT[4]):
            self.assertNotIn(value, output)

    def test_installs_exact_pairing_preserves_live_history_and_identity_inode(self):
        before = files(self.host)
        identity = self.shared / "installation_id"
        stat_before = identity.stat()
        with contextlib.closing(sqlite3.connect(self.shared / "state_5.sqlite")) as live, live:
            live.execute("PRAGMA journal_mode=WAL")
            rows_before = live.execute("SELECT * FROM threads").fetchall()
            result = self.install(apply=True)
            self.assertEqual(live.execute("SELECT * FROM threads").fetchall(), rows_before)
            live.execute("UPDATE threads SET title='continued unrelated thread' WHERE id=?", (OTHER,))
            live.commit()
        self.assertEqual(result["status"], "installed")
        self.assertEqual(identity.read_bytes(), HOST_IDENTITY)
        stat_after = identity.stat()
        self.assertEqual((stat_before.st_ino, stat_before.st_uid, stat_before.st_gid, stat_before.st_mode),
                         (stat_after.st_ino, stat_after.st_uid, stat_after.st_gid, stat_after.st_mode))
        self.assertEqual(Path(result["original_shared_identity_backup"]).read_bytes(), SHARED_IDENTITY)
        self.assertEqual(self.enrollment(self.shared), [ENROLLMENT])
        self.assertEqual(files(self.host), before)

    def test_matching_identity_install_is_idempotent(self):
        self.install(apply=True)
        before = files(self.shared)
        result = self.install(apply=True)
        self.assertEqual(result["status"], "already_installed")
        self.assertEqual(files(self.shared), before)

    def test_conflicting_shared_pairing_is_not_overwritten(self):
        with contextlib.closing(sqlite3.connect(self.shared / "state_5.sqlite")) as db, db:
            other = list(ENROLLMENT)
            other[3] = "different-server"
            db.execute("INSERT INTO remote_control_enrollments VALUES (?,?,?,?,?,?,?,?)", other)
        before = files(self.shared)
        with self.assertRaisesRegex(central.StateError, "conflicting enrollment"):
            self.install(apply=True)
        self.assertEqual(files(self.shared), before)

    def test_already_enrolled_different_installation_is_not_reidentified(self):
        with contextlib.closing(sqlite3.connect(self.shared / "state_5.sqlite")) as db, db:
            other = list(ENROLLMENT)
            other[1] = "another-account"
            db.execute("INSERT INTO remote_control_enrollments VALUES (?,?,?,?,?,?,?,?)", other)
        with self.assertRaisesRegex(central.StateError, "already enrolled"):
            self.install(apply=True)
        self.assertEqual((self.shared / "installation_id").read_bytes(), SHARED_IDENTITY)

    def test_multiple_host_enrollments_are_not_guessed(self):
        with contextlib.closing(sqlite3.connect(self.host / "state_5.sqlite")) as db, db:
            other = list(ENROLLMENT)
            other[1] = "another-account"
            db.execute("INSERT INTO remote_control_enrollments VALUES (?,?,?,?,?,?,?,?)", other)
        with self.assertRaisesRegex(central.StateError, "exactly one enrollment"):
            self.install(apply=True)
        self.assertEqual(self.enrollment(self.shared), [])

    def test_account_mismatch_cannot_silently_create_a_different_pairing(self):
        (self.shared / "auth.json").write_text(json.dumps({"auth_mode": "chatgpt", "tokens": {"account_id": "different-account"}}))
        before = files(self.shared)
        with self.assertRaisesRegex(central.StateError, "original enrollment's ChatGPT account"):
            self.install(apply=True)
        self.assertEqual(files(self.shared), before)

    def test_native_installation_identity_lock_blocks_transfer(self):
        with (self.shared / "installation_id").open("r+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(central.StateError, "lock is held"):
                self.install(apply=True)
        self.assertEqual(self.enrollment(self.shared), [])

    def test_partial_identity_write_rolls_back_identity_and_enrollment(self):
        identity_inode = (self.shared / "installation_id").stat().st_ino
        original_write = central.write_identity
        failed = False

        def fail_once(fd, data):
            nonlocal failed
            if os.fstat(fd).st_ino == identity_inode and not failed:
                failed = True
                os.lseek(fd, 0, os.SEEK_SET)
                os.write(fd, b"partial")
                raise OSError("simulated identity persistence failure")
            return original_write(fd, data)

        with mock.patch.object(central, "write_identity", side_effect=fail_once):
            with self.assertRaisesRegex(OSError, "simulated identity persistence failure"):
                self.install(apply=True)
        self.assertEqual((self.shared / "installation_id").read_bytes(), SHARED_IDENTITY)
        self.assertEqual(self.enrollment(self.shared), [])
        self.assertEqual(self.enrollment(self.host), [ENROLLMENT])

    def test_enrollment_trigger_is_rejected_before_any_change(self):
        with contextlib.closing(sqlite3.connect(self.shared / "state_5.sqlite")) as db, db:
            db.execute("CREATE TRIGGER unexpected AFTER INSERT ON remote_control_enrollments BEGIN DELETE FROM threads; END")
        before = files(self.shared)
        with self.assertRaisesRegex(central.StateError, "Unexpected enrollment triggers"):
            self.install(apply=True)
        self.assertEqual(files(self.shared), before)

    def test_rejoin_identical_history_needs_no_data_writes(self):
        before_private, before_shared = files(self.private), files(self.shared)
        result = self.rejoin(apply=True)
        self.assertEqual(result["status"], "ready_to_rejoin")
        self.assertEqual(result["thread_ids"], [ROOT])
        self.assertEqual(result["history_writes"], 0)
        self.assertEqual(files(self.private), before_private)
        self.assertEqual(files(self.shared), before_shared)

    def test_rejoin_refuses_writer_in_either_home(self):
        for home in (self.private, self.shared):
            with self.subTest(home=home):
                with (home / "thread-writer-locks" / f"{ROOT}.lock").open("r+") as lock:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    with self.assertRaisesRegex(central.StateError, "lock is held"):
                        self.rejoin(apply=True)

    def test_rejoin_ignores_unrelated_live_thread_lock_and_changed_rows(self):
        with contextlib.closing(sqlite3.connect(self.shared / "thread_history_1.sqlite")) as db, db:
            db.execute("UPDATE thread_items SET value='new unrelated turn' WHERE thread_id=?", (OTHER,))
        with (self.shared / "thread-writer-locks" / f"{OTHER}.lock").open("r+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.rejoin(apply=True)["status"], "ready_to_rejoin")

    def test_private_rollout_delta_requires_explicit_migration(self):
        path = self.private / f"sessions/2026/09/08/rollout-{ROOT}.jsonl"
        with path.open("ab") as handle:
            handle.write(b'{"type":"event_msg"}\n')
        before = files(self.shared)
        with self.assertRaisesRegex(central.StateError, "rollout bytes differ"):
            self.rejoin(apply=True)
        self.assertEqual(files(self.shared), before)

    def test_sqlite_history_delta_requires_explicit_migration(self):
        with contextlib.closing(sqlite3.connect(self.private / "thread_history_1.sqlite")) as db, db:
            db.execute("UPDATE thread_turns SET rollout_byte_offset=9876 WHERE thread_id=?", (ROOT,))
        with self.assertRaisesRegex(central.StateError, "selected history differs"):
            self.rejoin(apply=True)

    def test_rejoin_rejects_creation_time_changes_beyond_millisecond_refinement(self):
        with contextlib.closing(sqlite3.connect(self.private / "state_5.sqlite")) as db, db:
            db.execute("UPDATE threads SET created_at_ms=200001 WHERE id=?", (ROOT,))
        with self.assertRaisesRegex(central.StateError, "creation timestamps are inconsistent"):
            self.rejoin(apply=True)


if __name__ == "__main__":
    unittest.main()
