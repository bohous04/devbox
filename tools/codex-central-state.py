#!/usr/bin/env python3
"""Prepare one host Remote to use the existing shared Codex home.

Stop the old host Remote and the replacement host daemon before applying
install-host-identity. Existing standalone CLI threads may continue running.
Before verify-rejoin, stop the private app server/CLI and keep it stopped until
the central daemon owns those threads. Source homes and histories are retained.

No identity, account, enrollment, or conversation values are printed. Commands
default to dry-run. --apply enables identity installation or, for verify-rejoin,
creation of any missing native writer lockfiles needed for a guarded handoff.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import sqlite3
import stat
import sys
import uuid


ENROLLMENT_COLUMNS = (
    "websocket_url", "account_id", "app_server_client_name", "server_id",
    "environment_id", "server_name", "updated_at", "remote_control_enabled",
)
ENROLLMENT_KEY = ENROLLMENT_COLUMNS[:3]
HISTORY_TABLES = {
    "state_5.sqlite": {"thread_dynamic_tools", "thread_artifacts"},
    "thread_history_1.sqlite": {
        "thread_turns", "thread_items", "thread_history_projection_state", "thread_realtime_items",
    },
    "goals_1.sqlite": {"thread_goals", "thread_goal_continuation_deferrals"},
    "queue_1.sqlite": {"queued_items", "queued_thread_revisions"},
    "memories_1.sqlite": {"stage1_outputs"},
}
THREAD_METADATA_EXCEPTIONS = {
    "rollout_path", "created_at_ms", "updated_at", "updated_at_ms", "recency_at", "recency_at_ms",
    "project_id", "thread_section_id", "section_position", "section_entered_at_ms",
}


class StateError(Exception):
    pass


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def home_path(path):
    result = Path(path).expanduser().resolve(strict=True)
    if not result.is_dir():
        raise StateError("Codex home must be an existing directory")
    return result


def database(home, *, writable=False):
    path = home / "state_5.sqlite"
    if path.is_symlink() or not path.is_file():
        raise StateError("Expected a regular state_5.sqlite in the Codex home")
    db = sqlite3.connect(path.as_uri() + ("?mode=rw" if writable else "?mode=ro"), uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    return db


@contextlib.contextmanager
def locked_file(path, *, create=False, writable=False, owner=None):
    flags = (os.O_RDWR if writable else os.O_RDONLY) | getattr(os, "O_NOFOLLOW", 0)
    if create:
        flags |= os.O_CREAT
    fd = os.open(path, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise StateError("Expected a regular lock or installation identity file")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise StateError("A required writer or identity lock is held; stop its owning process before handoff") from exc
        if owner is not None and os.geteuid() == 0:
            os.fchown(fd, *owner)
        yield fd
    finally:
        os.close(fd)


def identity_bytes(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    data = os.read(fd, 4097)
    try:
        if len(data) > 4096:
            raise ValueError()
        canonical = str(uuid.UUID(data.decode().strip()))
    except (ValueError, UnicodeError) as exc:
        raise StateError("Installation identity is not a valid UUID") from exc
    return data, canonical


def write_identity(fd, data):
    os.lseek(fd, 0, os.SEEK_SET)
    pending = memoryview(data)
    while pending:
        written = os.write(fd, pending)
        if written == 0:
            raise OSError("Could not persist installation identity")
        pending = pending[written:]
    os.ftruncate(fd, len(data))
    os.fsync(fd)


def enrollment_rows(db):
    columns = list(db.execute("PRAGMA table_info(remote_control_enrollments)"))
    names = {row[1] for row in columns}
    key = tuple(row[1] for row in sorted(columns, key=lambda row: row[5]) if row[5])
    if names != set(ENROLLMENT_COLUMNS) or key != ENROLLMENT_KEY:
        raise StateError("Unsupported remote enrollment schema or primary key")
    if db.execute("PRAGMA foreign_key_list(remote_control_enrollments)").fetchone() is not None:
        raise StateError("Unexpected enrollment foreign keys")
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name='remote_control_enrollments'").fetchone():
        raise StateError("Unexpected enrollment triggers")
    return [dict(row) for row in db.execute("SELECT * FROM remote_control_enrollments")]


def install_plan(source_row, target_rows, identities_match):
    source_key = tuple(source_row[name] for name in ENROLLMENT_KEY)
    matching = [row for row in target_rows if tuple(row[name] for name in ENROLLMENT_KEY) == source_key]
    if matching and matching[0] != source_row:
        raise StateError("Shared home contains a conflicting enrollment for the original host lookup key")
    if target_rows and not identities_match:
        raise StateError("Cannot change installation identity of an already enrolled shared home")
    return bool(matching), identities_match


def verify_auth_account(home, account_id):
    try:
        contents = json.loads((home / "auth.json").read_text())
        matches = bool(account_id) and contents.get("auth_mode") == "chatgpt" and contents.get("tokens", {}).get("account_id") == account_id
    except (OSError, ValueError, AttributeError):
        matches = False
    if not matches:
        raise StateError("Both homes must already authenticate the original enrollment's ChatGPT account")


def backup_identity(home, data, owner):
    directory = home / "central-state-backups"
    if directory.is_symlink():
        raise StateError("Backup directory must not be a symlink")
    directory.mkdir(mode=0o700, exist_ok=True)
    if os.geteuid() == 0:
        os.chown(directory, *owner)
    suffix = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    path = directory / ("installation_id-" + suffix)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        if os.geteuid() == 0:
            os.fchown(fd, *owner)
        write_identity(fd, data)
    finally:
        os.close(fd)
    return path


def install_host_identity(*, host_home, shared_home, apply=False):
    host, shared = home_path(host_home), home_path(shared_home)
    if host == shared:
        raise StateError("Original host and shared home must be different")
    owner_stat = (shared / "installation_id").stat()
    owner = (owner_stat.st_uid, owner_stat.st_gid)
    with contextlib.ExitStack() as stack:
        source_fd = stack.enter_context(locked_file(host / "installation_id"))
        target_fd = stack.enter_context(locked_file(shared / "installation_id", writable=apply))
        source_raw, source_id = identity_bytes(source_fd)
        target_raw, target_id = identity_bytes(target_fd)
        source_db = stack.enter_context(contextlib.closing(database(host)))
        source_rows = enrollment_rows(source_db)
        if len(source_rows) != 1:
            raise StateError("Original host must contain exactly one enrollment; refusing to guess which pairing to preserve")
        for home in (host, shared):
            verify_auth_account(home, source_rows[0]["account_id"])
        target_db = stack.enter_context(contextlib.closing(database(shared, writable=apply)))
        if apply:
            target_db.execute("BEGIN IMMEDIATE")
        original_target_rows = enrollment_rows(target_db)
        installed, identities_match = install_plan(source_rows[0], original_target_rows, source_id == target_id)
        result = {"operation": "install-host-identity", "host_home": str(host), "shared_home": str(shared),
                  "status": "already_installed" if installed and identities_match else "dry_run",
                  "enrollment_rows_to_copy": 0 if installed else 1,
                  "installation_identity_changes": not identities_match}
        if not apply or (installed and identities_match):
            return result
        backup = None
        try:
            if not identities_match:
                backup = backup_identity(shared, target_raw, owner)
            if not installed:
                columns = ",".join(quote(name) for name in ENROLLMENT_COLUMNS)
                target_db.execute(f"INSERT INTO remote_control_enrollments ({columns}) VALUES ({','.join('?' for _ in ENROLLMENT_COLUMNS)})",
                                  tuple(source_rows[0][name] for name in ENROLLMENT_COLUMNS))
            if not identities_match:
                # Preserve inode, ownership and mode: native resolve_installation_id
                # uses flock on this very file, and existing CLI processes share it.
                write_identity(target_fd, source_raw)
            target_db.commit()
        except BaseException:
            target_db.rollback()
            if not identities_match:
                write_identity(target_fd, target_raw)
            raise
        expected_rows = original_target_rows if installed else original_target_rows + source_rows
        actual_rows = enrollment_rows(target_db)
        if sorted(actual_rows, key=repr) != sorted(expected_rows, key=repr):
            raise StateError("Installed enrollment verification failed")
        if identity_bytes(target_fd)[1] != source_id:
            raise StateError("Installed identity verification failed")
        return {**result, "status": "installed", "original_shared_identity_backup": str(backup) if backup else None,
                "host_pairing_preserved": True}


def snapshot(path):
    if path.is_symlink() or not path.is_file():
        raise StateError("A required history database is missing or is a symlink")
    result = sqlite3.connect(":memory:")
    result.row_factory = sqlite3.Row
    try:
        with contextlib.closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)) as source:
            source.backup(result)
        return result
    except BaseException:
        result.close()
        raise


def tree_rows(db, roots):
    rows = {row["id"]: dict(row) for row in db.execute("SELECT * FROM threads")}
    if not roots <= rows.keys():
        raise StateError("A requested rejoin root is absent from one history home")
    children = {}
    for parent, child in db.execute("SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges"):
        children.setdefault(parent, set()).add(child)
    for thread_id, row in rows.items():
        try:
            parent = json.loads(row["source"]).get("subagent", {}).get("thread_spawn", {}).get("parent_thread_id")
        except (ValueError, AttributeError):
            parent = None
        if parent:
            children.setdefault(parent, set()).add(thread_id)
    selected, pending = set(roots), list(roots)
    while pending:
        for child in children.get(pending.pop(), set()) - selected:
            if child not in rows:
                raise StateError("Selected tree references an absent descendant")
            selected.add(child)
            pending.append(child)
    return {thread_id: rows[thread_id] for thread_id in sorted(selected)}


def add_thread_locks(stack, home, selected, *, create):
    directory = home / "thread-writer-locks"
    if directory.is_symlink():
        raise StateError("Thread writer lock directory must not be a symlink")
    owner = (home.stat().st_uid, home.stat().st_gid)
    existed = directory.exists()
    if create:
        directory.mkdir(mode=0o700, exist_ok=True)
        if not existed and os.geteuid() == 0:
            os.chown(directory, *owner)
    for thread_id in sorted(selected):
        try:
            if str(uuid.UUID(thread_id)) != thread_id:
                raise ValueError()
        except ValueError as exc:
            raise StateError("Invalid thread UUID in selected history") from exc
        path = directory / f"{thread_id}.lock"
        if not path.exists() and not create:
            continue
        stack.enter_context(locked_file(path, create=create, writable=create, owner=owner if create else None))


def rollout_path(home, runtime, stored):
    path, prefix = PurePosixPath(stored), PurePosixPath(runtime)
    try:
        relative = path.relative_to(prefix)
    except ValueError as exc:
        raise StateError("Rollout path is outside its declared runtime home") from exc
    if ".." in relative.parts or not relative.parts or relative.parts[0] not in {"sessions", "archived_sessions"}:
        raise StateError("Unsafe rollout path")
    resolved = home.joinpath(*relative.parts).resolve(strict=True)
    if not resolved.is_relative_to(home) or not resolved.is_file():
        raise StateError("Rollout file escapes its home or is missing")
    return resolved


def equal_files(left, right):
    if left.stat().st_size != right.stat().st_size:
        return False
    with left.open("rb") as incoming, right.open("rb") as outgoing:
        while True:
            chunk = incoming.read(1024 * 1024)
            if chunk != outgoing.read(1024 * 1024):
                return False
            if not chunk:
                return True


def selected_table_rows(db, table, selected):
    placeholders = ",".join("?" for _ in selected)
    cursor = db.execute(f"SELECT * FROM {quote(table)} WHERE thread_id IN ({placeholders})", tuple(sorted(selected)))
    # repr provides stable ordering even if nullable fields are mixed with strings.
    return sorted((tuple(row) for row in cursor), key=repr)


def verify_rejoin(*, private_home, shared_home, private_runtime_home, shared_runtime_home, roots, apply=False):
    private, shared = home_path(private_home), home_path(shared_home)
    if private == shared:
        raise StateError("Private and shared homes must be different")
    try:
        selected_roots = {str(uuid.UUID(thread_id)) for thread_id in roots}
    except ValueError as exc:
        raise StateError("Every thread must be a UUID") from exc
    if not selected_roots:
        raise StateError("Select at least one root")
    with contextlib.ExitStack() as stack:
        initial_private = stack.enter_context(contextlib.closing(snapshot(private / "state_5.sqlite")))
        selected = set(tree_rows(initial_private, selected_roots))
        for home in sorted((private, shared)):
            add_thread_locks(stack, home, selected, create=apply)
        homes = {}
        for label, home in (("private", private), ("shared", shared)):
            homes[label] = {name: stack.enter_context(contextlib.closing(snapshot(home / name))) for name in HISTORY_TABLES}
        private_rows = tree_rows(homes["private"]["state_5.sqlite"], selected_roots)
        shared_rows = tree_rows(homes["shared"]["state_5.sqlite"], selected_roots)
        if set(private_rows) != selected or set(shared_rows) != selected:
            raise StateError("Private/shared descendant trees changed or differ; explicit delta migration is required")
        for thread_id in sorted(selected):
            left, right = private_rows[thread_id], shared_rows[thread_id]
            # Native backfill can refine creation milliseconds from the rollout
            # timestamp instead of the UUID timestamp; the creation second must
            # remain identical. This is metadata, not a conversation delta.
            for row in (left, right):
                if row.get("created_at_ms") is not None and row["created_at_ms"] // 1000 != row.get("created_at"):
                    raise StateError("Thread creation timestamps are inconsistent")
            left_fields = {key: value for key, value in left.items() if key not in THREAD_METADATA_EXCEPTIONS}
            right_fields = {key: value for key, value in right.items() if key not in THREAD_METADATA_EXCEPTIONS}
            if left_fields != right_fields:
                raise StateError("Private/shared thread metadata differs; explicit delta migration is required")
            if not equal_files(rollout_path(private, private_runtime_home, left["rollout_path"]),
                               rollout_path(shared, shared_runtime_home, right["rollout_path"])):
                raise StateError("Private/shared rollout bytes differ; explicit delta migration is required")
        edges = []
        for label in ("private", "shared"):
            db = homes[label]["state_5.sqlite"]
            edges.append(sorted(tuple(row) for row in db.execute("SELECT * FROM thread_spawn_edges")
                                if row["parent_thread_id"] in selected and row["child_thread_id"] in selected))
        if edges[0] != edges[1]:
            raise StateError("Private/shared selected spawn edges differ; explicit delta migration is required")
        for name, tables in HISTORY_TABLES.items():
            left, right = homes["private"][name], homes["shared"][name]
            for table in tables:
                left_schema = [tuple(row) for row in left.execute(f"PRAGMA table_info({quote(table)})")]
                right_schema = [tuple(row) for row in right.execute(f"PRAGMA table_info({quote(table)})")]
                if not left_schema or left_schema != right_schema:
                    raise StateError("Private/shared history schemas differ")
                if selected_table_rows(left, table, selected) != selected_table_rows(right, table, selected):
                    raise StateError(f"Private/shared selected history differs in {name}.{table}; explicit delta migration is required")
        return {"operation": "verify-rejoin", "status": "ready_to_rejoin" if apply else "dry_run",
                "private_home": str(private), "shared_home": str(shared), "thread_ids": sorted(selected),
                "thread_count": len(selected), "histories_identical": True, "history_writes": 0,
                "originals_retained": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="operation", required=True)
    install = subcommands.add_parser("install-host-identity")
    install.add_argument("--host-home", required=True)
    install.add_argument("--shared-home", required=True)
    install.add_argument("--apply", action="store_true")
    rejoin = subcommands.add_parser("verify-rejoin")
    rejoin.add_argument("--private-home", required=True)
    rejoin.add_argument("--shared-home", required=True)
    rejoin.add_argument("--private-runtime-home", required=True)
    rejoin.add_argument("--shared-runtime-home", required=True)
    rejoin.add_argument("--thread", action="append", dest="roots", required=True)
    rejoin.add_argument("--apply", action="store_true")
    options = vars(parser.parse_args())
    operation = options.pop("operation")
    try:
        result = install_host_identity(**options) if operation == "install-host-identity" else verify_rejoin(**options)
    except (OSError, sqlite3.Error, StateError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
