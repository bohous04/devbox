#!/usr/bin/env python3
"""Move one exact conversation between account homes without moving credentials.

The caller first exits the TUI and supplies its freshly emitted thread UUID.
Archive is the native flush/unload boundary (unsubscribe leaves a live writer).
Only the selected spawn subtree, its rollouts and its per-thread database rows
are copied. Source history stays archived. No model turn is started here.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import select
import shutil
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid


TABLES = {
    "state_5.sqlite": ("thread_dynamic_tools", "thread_artifacts"),
    "thread_history_1.sqlite": ("thread_turns", "thread_items", "thread_history_projection_state", "thread_realtime_items"),
    "goals_1.sqlite": ("thread_goals", "thread_goal_continuation_deferrals"),
    "queue_1.sqlite": ("queued_items", "queued_thread_revisions"),
    "memories_1.sqlite": ("stage1_outputs",),
}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ROLLOUT_RE = re.compile(r"^rollout-.+-([0-9a-f-]{36})\.jsonl$")
# Long goal-driven conversations spawn hundreds of subagents over days.
MAX_RELATED_THREADS = 2000
RPC_TIMEOUT = 45
# Native archive of a root cascades through its whole subtree in one request.
ARCHIVE_TIMEOUT = 600


class TransferError(Exception):
    """Messages are fixed strings safe for API/UI output."""


def require(value, message):
    if not value:
        raise TransferError(message)


def thread_id(value):
    require(isinstance(value, str) and UUID_RE.fullmatch(value), "Invalid conversation ID.")
    return value


def home_path(value):
    path = Path(value).absolute()
    require(path.is_dir() and not path.is_symlink() and path.resolve() == path,
            "Account home is missing or has an unsafe path.")
    return path


def regular(path):
    require(not path.is_symlink() and path.is_file(), "A conversation file is missing or unsafe.")
    return path


# Threads created while the central server still ran with its own private
# CODEX_HOME keep that server's path. Its history directories are symlinks into
# the shared default home, so they name the same files as the container path.
DEFAULT_HOME = Path("/home/dev/.codex")
LEGACY_REMOTE_HOME = Path("/var/lib/codex-remote-home")


def account_path(home, path):
    path = Path(path)
    if home == DEFAULT_HOME and path.is_relative_to(LEGACY_REMOTE_HOME):
        rest = path.relative_to(LEGACY_REMOTE_HOME)
        if rest.parts[:1] in (("sessions",), ("archived_sessions",)) and ".." not in rest.parts:
            return DEFAULT_HOME / rest
    return path


def safe_path(home, path, *, exists=True):
    path = account_path(home, path)
    require(path.is_absolute() and path.is_relative_to(home), "Conversation history points outside its account home.")
    require(path.resolve() == path and (not exists or path.is_file()), "Conversation history path is missing or unsafe.")
    return path


def q(value):
    return '"' + value.replace('"', '""') + '"'


def connect_db(home, name="state_5.sqlite", writable=False):
    path = regular(home / name)
    db = sqlite3.connect(path.as_uri() + ("?mode=rw" if writable else "?mode=ro"), uri=True, timeout=20)
    db.row_factory = sqlite3.Row
    return db


def safe_socket(path):
    # Native daemons publish the socket as a symlink to a hidden sibling;
    # anything resolving outside this directory is refused.
    return ((not path.is_symlink() or path.resolve().parent == path.parent.resolve())
            and stat.S_ISSOCK(path.stat().st_mode))


class Rpc:
    """Native Unix WebSocket, or a private stdio server for an embedded home.

    Stdio processes are owned by this object; existing daemons are never killed.
    No RPC response/error payload or process stderr is included in exceptions.
    """
    def __init__(self, home, *, allow_stdio=True):
        self.home, self.buffer, self.seq, self.deadline = home, b"", 0, None
        self.sock = self.process = None
        path = home / "app-server-control" / "app-server-control.sock"
        try:
            if path.exists():
                require(safe_socket(path), "Account server socket is unsafe.")
                self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.sock.settimeout(30)
                self.sock.connect(str(path))
                key = base64.b64encode(os.urandom(16)).decode()
                self.sock.sendall(("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                                   "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\n\r\n").encode())
                while b"\r\n\r\n" not in self.buffer:
                    self._receive()
                    require(len(self.buffer) < 16384, "Account server handshake failed.")
                header, self.buffer = self.buffer.split(b"\r\n\r\n", 1)
                expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
                require(b" 101 " in header.split(b"\r\n")[0] and expected in header, "Account server handshake failed.")
            else:
                require(allow_stdio, "No running account server was found.")
                binary = shutil.which("codex")
                require(binary, "Codex is unavailable in this session.")
                env = dict(os.environ)
                env.update(CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home))
                self.process = subprocess.Popen([binary, "-c", "sqlite_home=" + json.dumps(str(home)),
                                                 "app-server", "--stdio"], env=env, cwd=home,
                                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                stderr=subprocess.DEVNULL, start_new_session=True)
            self.call("initialize", {"clientInfo": {"name": "devbox-account-transfer", "version": "1"},
                                     "capabilities": {"experimentalApi": True}})
            self.send({"method": "initialized"})
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.sock:
            self.sock.close()
            self.sock = None
        if self.process:
            if self.process.poll() is None:
                self.process.stdin.close()
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.terminate()
                    try:
                        self.process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.process.kill()
                        self.process.wait(timeout=5)
            self.process.stdout.close()
            if not self.process.stdin.closed:
                self.process.stdin.close()
            self.process = None

    def _receive(self):
        wait = max(1, self.deadline - time.monotonic()) if self.deadline else 30
        if self.sock:
            self.sock.settimeout(wait)
            data = self.sock.recv(65536)
        else:
            require(select.select([self.process.stdout], [], [], wait)[0], "Account server did not respond in time.")
            data = os.read(self.process.stdout.fileno(), 65536)
        require(data, "Account server connection closed.")
        self.buffer += data

    def _read(self, n):
        while len(self.buffer) < n:
            self._receive()
        data, self.buffer = self.buffer[:n], self.buffer[n:]
        return data

    def _frame(self, opcode, payload):
        n = len(payload)
        header = bytes([0x80 | opcode])
        header += bytes([0x80 | n]) if n < 126 else bytes([0xFE]) + struct.pack("!H", n) if n < 65536 else bytes([0xFF]) + struct.pack("!Q", n)
        mask = os.urandom(4)
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def send(self, message):
        data = json.dumps(message).encode()
        if self.sock:
            self._frame(1, data)
        else:
            self.process.stdin.write(data + b"\n")
            self.process.stdin.flush()

    def receive(self):
        if not self.sock:
            while b"\n" not in self.buffer:
                self._receive()
                require(len(self.buffer) <= 32 * 1024 * 1024, "Account server response is too large.")
            line, self.buffer = self.buffer.split(b"\n", 1)
            return json.loads(line)
        parts, total = [], 0
        while True:
            first, second = self._read(2)
            require(not first & 0x70 and not second & 0x80, "Invalid account server response.")
            opcode, length = first & 15, second & 127
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            require(length <= 32 * 1024 * 1024, "Account server response is too large.")
            payload = self._read(length)
            if opcode == 9:
                self._frame(10, payload)
                continue
            if opcode == 10:
                continue
            require(opcode in (0, 1), "Account server connection closed.")
            parts.append(payload)
            total += length
            require(total <= 32 * 1024 * 1024, "Account server response is too large.")
            if first & 0x80:
                return json.loads(b"".join(parts))

    def call(self, method, params, timeout=RPC_TIMEOUT):
        self.seq += 1
        self.send({"id": self.seq, "method": method, "params": params})
        self.deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < self.deadline:
                try:
                    message = self.receive()
                except socket.timeout:
                    break
                if message.get("id") == self.seq and "method" not in message:
                    require("error" not in message, "Codex could not complete the conversation handoff.")
                    return message["result"]
        finally:
            self.deadline = None
        raise TransferError("Account server did not complete the handoff in time.")


def rows_and_edges(home):
    with contextlib.closing(connect_db(home)) as db:
        rows = {r["id"]: dict(r) for r in db.execute("SELECT * FROM threads")}
        for row in rows.values():
            if isinstance(row.get("rollout_path"), str):
                row["rollout_path"] = str(account_path(home, row["rollout_path"]))
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        edges = [dict(r) for r in db.execute("SELECT * FROM thread_spawn_edges")] if "thread_spawn_edges" in tables else []
    return rows, edges


def subtree(rows, edges, root):
    require(root in rows, "The exact conversation is missing from this account.")
    children = {}
    for edge in edges:
        children.setdefault(edge["parent_thread_id"], set()).add(edge["child_thread_id"])
    for ident, row in rows.items():
        try:
            source = json.loads(row.get("source", "null"))
            parent = source.get("subagent", {}).get("thread_spawn", {}).get("parent_thread_id") if isinstance(source, dict) else None
        except (ValueError, AttributeError):
            parent = None
        if parent:
            children.setdefault(parent, set()).add(ident)
    selected, pending = {root}, [root]
    while pending:
        for child in children.get(pending.pop(), set()) - selected:
            thread_id(child)
            require(child in rows, "A related agent conversation is missing; the account was not changed.")
            selected.add(child)
            pending.append(child)
    require(len(selected) <= MAX_RELATED_THREADS, "This conversation has too many related agents for a safe handoff.")
    return selected


def scan_rollouts(home, selected):
    """Owned physical lineages plus their exact history-base dependencies.

    A fork may refer to an ancestor's immutable history prefix. Its referenced
    rollout is necessary context; unrelated sibling threads are not selected.
    Dependency owners are writer-locked by transfer, never recursively archived.
    """
    owned, index = {}, {}
    for directory in (home / "sessions", home / "archived_sessions"):
        if not directory.exists():
            continue
        require(not directory.is_symlink(), "Conversation directory is unsafe.")
        for current, dirs, files in os.walk(directory, followlinks=False):
            dirs[:] = [d for d in dirs if not (Path(current) / d).is_symlink()]
            for name in files:
                match = ROLLOUT_RE.fullmatch(name)
                if not match:
                    continue
                path = Path(current) / name
                if path.is_symlink() or not path.is_file():
                    continue
                with path.open("rb") as stream:
                    first = stream.readline(4 * 1024 * 1024)
                try:
                    item = json.loads(first)
                except ValueError:
                    continue
                if item.get("type") != "session_meta":
                    continue
                meta = item.get("payload", {})
                ident = meta.get("id")
                rid = match.group(1)
                index.setdefault(rid, []).append((path, meta))
                if ident in selected:
                    require(rid not in owned, "Duplicate selected rollout identities prevent a safe handoff.")
                    owned[rid] = (path, meta)
    require(selected <= {meta.get("id") for _, meta in owned.values()},
            "A conversation rollout is missing or uses unsupported compression.")
    pending = list(owned)
    while pending:
        _, meta = owned[pending.pop()]
        base = meta.get("history_base")
        if base:
            require(isinstance(base, dict), "A required conversation history reference is invalid.")
            rid = thread_id(base.get("thread_id"))
            if rid not in owned:
                candidates = index.get(rid, [])
                require(len(candidates) == 1, "A required ancestor conversation rollout is missing or ambiguous.")
                dependency = candidates[0]
                thread_id(dependency[1].get("id"))
                owned[rid] = dependency
                pending.append(rid)
    return owned


@contextlib.contextmanager
def writer_locks(homes, selected):
    """Coordinate with native cleanup, which can otherwise unlink idle locks."""
    # One descriptor per held lock; the default soft limit (1024) is too low
    # for a few hundred subagents locked in both accounts.
    needed = len(homes) * (len(selected) + 1) + 256
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft != resource.RLIM_INFINITY and soft < needed:
        require(hard == resource.RLIM_INFINITY or hard >= needed, "This conversation has too many related agents for a safe handoff.")
        resource.setrlimit(resource.RLIMIT_NOFILE, (needed, hard))
    with contextlib.ExitStack() as stack:
        for home in sorted(homes):
            directory = home / "thread-writer-locks"
            require(not directory.is_symlink(), "Conversation writer lock directory is unsafe.")
            directory.mkdir(mode=0o700, exist_ok=True)
            for name in [".coordination.lock", *[ident + ".lock" for ident in sorted(selected)]]:
                fd = os.open(directory / name, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
                stack.callback(os.close, fd)
                require(stat.S_ISREG(os.fstat(fd).st_mode), "Conversation writer lock is unsafe.")
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as exc:
                    raise TransferError("The conversation still has an active writer; please try again after it finishes.") from exc
        yield


def archived_state(home, ident):
    """None when the thread is absent; one indexed lookup instead of a full table read."""
    with contextlib.closing(connect_db(home)) as db:
        row = db.execute("SELECT archived FROM threads WHERE id = ?", (ident,)).fetchone()
    return None if row is None else bool(row["archived"])


def archive_tree(rpc, home, selected, root):
    # Native root archive cascades. Retry descendants individually because the
    # native API deliberately tolerates a failed descendant archive.
    for ident in [root, *sorted(selected - {root})]:
        if archived_state(home, ident) is False:
            rpc.call("thread/archive", {"threadId": ident}, timeout=ARCHIVE_TIMEOUT)
    loaded = set(rpc.call("thread/loaded/list", {})["data"])
    require(not selected & loaded, "A related conversation is still loaded; the account was not changed.")
    rows, _ = rows_and_edges(home)
    require(all(rows[i].get("archived") for i in selected), "A related conversation could not be archived safely.")


def unarchive_ids(rpc, home, ids):
    for ident in sorted(ids):
        if archived_state(home, ident):
            rpc.call("thread/unarchive", {"threadId": ident}, timeout=ARCHIVE_TIMEOUT)


def is_prefix(older, newer):
    if older.stat().st_size > newer.stat().st_size:
        return False
    with older.open("rb") as left, newer.open("rb") as right:
        while True:
            chunk = left.read(1024 * 1024)
            if not chunk:
                return True
            if right.read(len(chunk)) != chunk:
                return False


def scoped_rows(db, table, ids):
    names = [r[1] for r in db.execute("PRAGMA table_info(" + q(table) + ")")]
    require("thread_id" in names, "Unsupported conversation database schema.")
    placeholders = ",".join("?" for _ in ids)
    return names, [dict(r) for r in db.execute("SELECT * FROM " + q(table) + " WHERE thread_id IN (" + placeholders + ")", tuple(ids))]


def fingerprint(home, ids):
    """Detect independent edits to an inactive copy, including queued input/goals."""
    rows, edges = rows_and_edges(home)
    ignored = {"rollout_path", "archived", "archived_at", "updated_at", "updated_at_ms",
               "recency_at", "recency_at_ms", "created_at_ms", "project_id", "thread_section_id",
               "section_position", "section_entered_at_ms"}
    data = {"threads": [{k: v for k, v in rows[i].items() if k not in ignored} for i in sorted(ids)],
            "edges": sorted([e for e in edges if e["parent_thread_id"] in ids], key=lambda e: e["child_thread_id"]),
            "files": {}, "tables": {}}
    for rid, (path, _) in scan_rollouts(home, ids).items():
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        data["files"][rid] = digest.hexdigest()
    for name, tables in TABLES.items():
        if not (home / name).exists():
            continue
        with contextlib.closing(connect_db(home, name)) as db:
            present = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in tables:
                if table in present:
                    _, table_rows = scoped_rows(db, table, ids)
                    # Projection indexes may be filled lazily by a read. They are
                    # derived from the byte-verified rollout, not authored state.
                    if name == "thread_history_1.sqlite":
                        continue
                    if table_rows:
                        data["tables"][name + ":" + table] = sorted(table_rows, key=lambda r: json.dumps(r, sort_keys=True))
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def receipt_path(home, root):
    directory = home / ".devd-conversation-transfers"
    require(not directory.is_symlink(), "Conversation transfer receipt directory is unsafe.")
    return directory / (root + ".json")


def validate_receipt(home, root, ids):
    path = receipt_path(home, root)
    if not path.exists():
        return False
    try:
        receipt = json.loads(regular(path).read_text())
    except (ValueError, OSError):
        raise TransferError("The previous conversation handoff receipt is invalid.") from None
    require(receipt.get("threadId") == root and receipt.get("ids") == sorted(ids)
            and receipt.get("fingerprint") == fingerprint(home, ids),
            "The inactive conversation changed independently on the other account; history was preserved.")
    return True


def save_receipt(home, root, ids):
    path = receipt_path(home, root)
    path.parent.mkdir(mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".incoming-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump({"threadId": root, "ids": sorted(ids), "fingerprint": fingerprint(home, ids)}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def initialize_aux_schema(source, target, name):
    """Initialize an absent lazy auxiliary DB with schema only, never user rows.

    Native app-server does not create thread_history until its first history read.
    Preserve its migration checksums so that the selected Codex version can apply
    subsequent migrations normally. This is deliberately unavailable for state DB.
    """
    require(name in TABLES and name != "state_5.sqlite", "Unsupported auxiliary database.")
    destination = target / name
    require(not destination.exists() and not destination.is_symlink(), "Auxiliary account database changed during handoff.")
    allowed = set(TABLES[name]) | {"_sqlx_migrations"}
    fd, temporary = tempfile.mkstemp(prefix=".schema-", dir=target)
    os.close(fd)
    try:
        with contextlib.closing(connect_db(source, name)) as incoming, sqlite3.connect(temporary) as outgoing:
            definitions = incoming.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type DESC,name").fetchall()
            for kind in ("table", "index"):
                for row in definitions:
                    if row["type"] == kind and row["tbl_name"] in allowed:
                        outgoing.execute(row["sql"])
            if any(row["name"] == "_sqlx_migrations" for row in definitions):
                columns = [r[1] for r in incoming.execute("PRAGMA table_info(_sqlx_migrations)")]
                migrations = list(incoming.execute("SELECT * FROM _sqlx_migrations"))
                outgoing.executemany("INSERT INTO _sqlx_migrations VALUES (" + ",".join("?" for _ in columns) + ")", [tuple(r) for r in migrations])
        # Linking gives no-overwrite publication even if another native process
        # initialized this DB concurrently. The caller then reopens its real file.
        try:
            os.link(temporary, destination)
        except FileExistsError:
            regular(destination)
    finally:
        os.unlink(temporary)


def copy_selected(source, target, root, ids):
    """Called only with both account trees archived and writer locks held."""
    source_rows, source_edges = rows_and_edges(source)
    target_rows, target_edges = rows_and_edges(target)
    require(subtree(source_rows, source_edges, root) == ids, "The agent tree changed during handoff; please retry.")
    if root in target_rows:
        require(subtree(target_rows, target_edges, root) <= ids, "The other account contains a different conversation branch; history was preserved.")
    incoming = scan_rollouts(source, ids)
    existing_ids = ids & target_rows.keys()
    existing = scan_rollouts(target, existing_ids) if existing_ids else {}
    require(existing.keys() <= incoming.keys(), "The other account contains a different conversation branch; history was preserved.")
    for rid in existing:
        require(is_prefix(existing[rid][0], incoming[rid][0]), "The conversation changed independently on both accounts; history was preserved.")
    if existing_ids:
        known = validate_receipt(target, root, existing_ids)
        require(known or (existing_ids == ids and fingerprint(target, ids) == fingerprint(source, ids)),
                "The other account contains an unverified conversation copy; its history was preserved.")

    copies, path_map = [], {}
    for rid, (path, meta) in incoming.items():
        # An ancestor dependency may already belong to an unrelated, idle parent
        # entry here. Preserve that file's location rather than creating a second
        # physical file with the same immutable rollout ID.
        proposed = existing[rid][0] if rid in existing and meta["id"] not in ids else target / "archived_sessions" / path.name
        destination = safe_path(target, proposed, exists=False)
        require(not destination.exists() or rid in existing,
                "An unregistered destination rollout already exists; its history was preserved.")
        copies.append((path, destination))
        path_map[str(path)] = str(destination)
    for ident in ids:
        require(source_rows[ident].get("rollout_path") in path_map,
                "The conversation's active rollout could not be identified safely.")

    snapshots = {}
    for name, tables in TABLES.items():
        if not (source / name).exists():
            continue
        with contextlib.closing(connect_db(source, name)) as db:
            present = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            snapshots[name] = {table: scoped_rows(db, table, ids) for table in tables if table in present}

    for name in list(snapshots):
        if not (target / name).exists():
            if not any(rows for _, rows in snapshots[name].values()):
                del snapshots[name]
            else:
                initialize_aux_schema(source, target, name)

    # Native startup initializes destination schemas. Never copy schema migrations,
    # authentication, enrollments, or unrelated account-global rows.
    with contextlib.closing(connect_db(target, writable=True)) as out:
        aliases = {"state_5.sqlite": "main"}
        for number, name in enumerate(snapshots):
            if name != "state_5.sqlite":
                alias = "history" + str(number)
                out.execute("ATTACH DATABASE ? AS " + q(alias), (str(regular(target / name)),))
                aliases[name] = alias
        out.execute("PRAGMA foreign_keys=ON")
        for name, tables in snapshots.items():
            for table, (columns, _) in tables.items():
                target_columns = {r[1] for r in out.execute("PRAGMA " + q(aliases[name]) + ".table_info(" + q(table) + ")")}
                if name == "thread_history_1.sqlite" and not set(columns) <= target_columns:
                    # History projections are derived from the byte-copied rollout.
                    # A newer source build may add columns an older destination
                    # Codex cannot read; it rebuilds anything missing on demand.
                    tables[table] = ([c for c in columns if c in target_columns], tables[table][1])
                    continue
                require(set(columns) <= target_columns, "Account database versions are incompatible; update Codex before switching.")
        columns = [r[1] for r in out.execute("PRAGMA table_info(threads)")]
        require(set(source_rows[root]) <= set(columns), "Account database versions are incompatible; update Codex before switching.")
        placeholders = ",".join("?" for _ in ids)
        backup = Path(tempfile.mkdtemp(prefix=".devd-conversation-transfer-", dir=target))
        restored_files, new_files = [], []
        try:
            out.execute("BEGIN IMMEDIATE")
            for number, (path, destination) in enumerate(copies):
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                if destination.exists():
                    saved = backup / str(number)
                    shutil.copyfile(regular(destination), saved)
                    restored_files.append((saved, destination))
                else:
                    new_files.append(destination)
                temporary = backup / (str(number) + ".incoming")
                shutil.copyfile(path, temporary)
                temporary.chmod(0o600)
                os.replace(temporary, destination)
            for ident in sorted(ids):
                row = dict(source_rows[ident])
                row["rollout_path"] = path_map[row["rollout_path"]]
                # Project/sidebar identities belong to the destination account.
                for key in ("project_id", "thread_section_id", "section_position", "section_entered_at_ms"):
                    if key in row:
                        row[key] = None
                keys = list(row)
                update = ",".join(q(k) + "=excluded." + q(k) for k in keys if k != "id")
                out.execute("INSERT INTO threads (" + ",".join(map(q, keys)) + ") VALUES (" + ",".join("?" for _ in keys) + ") ON CONFLICT(id) DO UPDATE SET " + update,
                            tuple(row[k] for k in keys))
            for name, tables in snapshots.items():
                for table, (keys, rows) in tables.items():
                    qualified = q(aliases[name]) + "." + q(table)
                    out.execute("DELETE FROM " + qualified + " WHERE thread_id IN (" + placeholders + ")", tuple(ids))
                    if rows:
                        out.executemany("INSERT INTO " + qualified + " (" + ",".join(map(q, keys)) + ") VALUES (" + ",".join("?" for _ in keys) + ")",
                                        [tuple(row[k] for k in keys) for row in rows])
            edge_columns = [r[1] for r in out.execute("PRAGMA table_info(thread_spawn_edges)")]
            if edge_columns:
                out.execute("DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (" + placeholders + ")", tuple(ids))
                for edge in source_edges:
                    if edge["parent_thread_id"] in ids and edge["child_thread_id"] in ids:
                        require(set(edge) <= set(edge_columns), "Account agent graph schemas are incompatible.")
                        keys = list(edge)
                        out.execute("INSERT INTO thread_spawn_edges (" + ",".join(map(q, keys)) + ") VALUES (" + ",".join("?" for _ in keys) + ") ON CONFLICT(child_thread_id) DO UPDATE SET " + ",".join(q(k) + "=excluded." + q(k) for k in keys if k != "child_thread_id"), tuple(edge[k] for k in keys))
            out.commit()
        except BaseException:
            out.rollback()
            for saved, destination in restored_files:
                os.replace(saved, destination)
            for path in new_files:
                path.unlink(missing_ok=True)
            raise
        finally:
            shutil.rmtree(backup)


def empty_conversation(home, root, rpc_factory=Rpc):
    """Missing DB rows alone are NOT evidence of an empty conversation.

    Require either an idle live server summary plus absent/metadata-only rollout,
    or a closed local writer with exactly one metadata-only rollout. Never delete
    the source, synthesize history, or run a model turn.
    """
    paths = list((home / "sessions").glob("**/*" + root + ".jsonl"))
    paths += list((home / "archived_sessions").glob("**/*" + root + ".jsonl"))
    require(len(paths) <= 1, "The new conversation has ambiguous history; no fresh conversation was started.")
    cwd = None
    if paths:
        path = safe_path(home, paths[0])
        original_text = path.read_text()
        records = [json.loads(line) for line in original_text.splitlines() if line.strip()]
        require(len(records) == 1 and records[0].get("type") == "session_meta",
                "This conversation already has history; no fresh conversation was started.")
        meta = records[0].get("payload", {})
        require(meta.get("id") == root and not meta.get("history_base") and not meta.get("forked_from_id"),
                "The conversation metadata is not a new empty thread.")
        cwd = meta.get("cwd")
    for name, tables in TABLES.items():
        if not (home / name).exists():
            continue
        with contextlib.closing(connect_db(home, name)) as db:
            existing = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in tables:
                if table not in existing:
                    continue
                require(not scoped_rows(db, table, {root})[1], "This conversation has stored context; no fresh conversation was started.")
    rows, edges = rows_and_edges(home)
    require(root not in rows and not any(root in (e.get("parent_thread_id"), e.get("child_thread_id")) for e in edges),
            "The conversation changed during account switching.")
    socket_path = home / "app-server-control" / "app-server-control.sock"
    if socket_path.exists():
        rpc = rpc_factory(home, allow_stdio=False)
        try:
            t = rpc.call("thread/read", {"threadId": root, "includeTurns": False}).get("thread", {})
            require(t.get("id") == root and t.get("preview") == "" and t.get("status", {}).get("type") == "idle"
                    and not t.get("forkedFromId") and not t.get("parentThreadId") and not t.get("turns"),
                    "The account server did not confirm a new empty conversation.")
            remote_path = safe_path(home, t.get("path", ""), exists=False)
            require((not paths and not remote_path.exists()) or (paths and remote_path == paths[0]),
                    "The conversation history changed during account switching.")
            require(cwd is None or cwd == t.get("cwd"), "The conversation directory changed.")
            cwd = t.get("cwd")
        finally:
            rpc.close()
    else:
        require(paths, "The exact conversation is missing from this account; its emptiness cannot be verified.")
        with writer_locks((home,), {root}):
            require(paths[0].read_text() == original_text, "The conversation changed.")
    require(isinstance(cwd, str) and cwd.startswith("/") and cwd != "/" and not any(ord(c) < 32 for c in cwd),
            "The empty conversation directory is unavailable.")
    # Recheck the file after the server response (or local writer lock).
    if paths:
        require(paths[0].read_text() == original_text, "The conversation changed during account switching.")
    return {"ok": True, "threadId": root, "cwd": cwd, "empty": True, "transferredIds": []}


def transfer(source, target, root, rpc_factory=Rpc, protected_thread_ids=()):
    source, target, root = home_path(source), home_path(target), thread_id(root)
    require(source != target, "Source and target accounts must be different.")
    source_rows, source_edges = rows_and_edges(source)
    if root not in source_rows:
        require(root not in protected_thread_ids, "The conversation is already in use on the target account.")
        return empty_conversation(source, root, rpc_factory)
    selected = subtree(source_rows, source_edges, root)
    restore_source = {i for i in selected if not source_rows[i].get("archived")}
    # Detect unsupported or incomplete history before archiving either account.
    for ident in selected:
        safe_path(source, source_rows[ident]["rollout_path"])
    histories = scan_rollouts(source, selected)
    protected = {thread_id(i) for i in protected_thread_ids}
    require(not protected & (selected | {meta["id"] for _, meta in histories.values()}),
            "A conversation already running on the selected account shares this agent tree; it was left unchanged.")
    if root not in restore_source:
        # The helper may have committed just before the caller lost its reply.
        # Recover only a fully matching, verified handoff; never infer success
        # from an archived source or a coincidentally matching UUID alone.
        target_rows, target_edges = rows_and_edges(target)
        require(root in target_rows and not target_rows[root].get("archived")
                and subtree(target_rows, target_edges, root) == selected,
                "The selected source conversation is already archived.")
        with writer_locks((source, target), selected | {meta["id"] for _, meta in histories.values()}):
            require(validate_receipt(source, root, selected) and validate_receipt(target, root, selected)
                    and fingerprint(source, selected) == fingerprint(target, selected),
                    "The previous conversation handoff could not be recovered safely.")
        return {"ok": True, "threadId": root, "transferredIds": sorted(selected), "sourceArchived": True,
                "cwd": source_rows[root].get("cwd"), "recovered": True}
    with contextlib.ExitStack() as stack:
        source_rpc = rpc_factory(source)
        stack.callback(source_rpc.close)
        target_rpc = rpc_factory(target)
        stack.callback(target_rpc.close)
        target_rows, target_edges = rows_and_edges(target)
        target_selected = subtree(target_rows, target_edges, root) if root in target_rows else set()
        require(not protected & target_selected,
                "A conversation already running on the selected account shares this agent tree; it was left unchanged.")
        require(target_selected <= selected, "The other account contains a different conversation branch; history was preserved.")
        restore_target = {i for i in target_selected if not target_rows[i].get("archived")}
        for ident in target_selected:
            view = target_rpc.call("thread/read", {"threadId": ident, "includeTurns": False})
            require(view.get("thread", {}).get("status", {}).get("type") != "active",
                    "This conversation is working on the destination account; finish that turn before switching.")
        committed = False
        try:
            archive_tree(source_rpc, source, selected, root)
            after_rows, after_edges = rows_and_edges(source)
            require(subtree(after_rows, after_edges, root) == selected, "The agent tree changed during handoff; please retry.")
            if target_selected:
                archive_tree(target_rpc, target, target_selected, root)
            # Actual history dependencies may belong to an ancestor outside the
            # spawned subtree. Lock it without archiving its unrelated children.
            lock_ids = selected | {meta["id"] for _, meta in scan_rollouts(source, selected).values()}
            with writer_locks((source, target), lock_ids):
                copy_selected(source, target, root, selected)
                committed = True
                # These describe the inactive source and imported destination,
                # excluding native archive/sidebar bookkeeping.
                save_receipt(source, root, selected)
                save_receipt(target, root, selected)
            unarchive_ids(target_rpc, target, restore_source)
            result = target_rpc.call("thread/read", {"threadId": root, "includeTurns": False})
            require(result.get("thread", {}).get("id") == root, "The destination conversation could not be verified.")
        except BaseException:
            # Before destination commit the original history is still authoritative.
            # After commit leave both complete copies; backend can resume the target.
            if not committed:
                with contextlib.suppress(Exception):
                    unarchive_ids(source_rpc, source, restore_source)
                with contextlib.suppress(Exception):
                    unarchive_ids(target_rpc, target, restore_target)
            else:
                # No model turn is started by this helper. If no external client
                # has taken over the imported tree, restore the source as well.
                # Keep a complete archived destination copy for another attempt.
                try:
                    loaded = set(target_rpc.call("thread/loaded/list", {})["data"])
                    require(not loaded & selected, "Destination conversation was opened during handoff.")
                    archive_tree(target_rpc, target, selected, root)
                    with writer_locks((source, target), selected):
                        save_receipt(source, root, selected)
                        save_receipt(target, root, selected)
                    unarchive_ids(source_rpc, source, restore_source)
                except Exception:
                    raise TransferError("Conversation history was transferred, but automatic recovery could not finish. Resume it on the selected destination account.") from None
            raise
    return {"ok": True, "threadId": root, "transferredIds": sorted(selected), "sourceArchived": True,
            "cwd": source_rows[root].get("cwd")}


def verify(home, root, writer_pid=None, rpc_factory=Rpc, allow_unpersisted=False):
    home, root = home_path(home), thread_id(root)
    rows, _ = rows_and_edges(home)
    if root in rows or not allow_unpersisted:
        require(root in rows and not rows[root].get("archived"), "The selected conversation did not resume on the destination account.")
        safe_path(home, rows[root]["rollout_path"])
    path = home / "app-server-control" / "app-server-control.sock"
    if path.exists():
        rpc = rpc_factory(home, allow_stdio=False)
        try:
            require(root in rpc.call("thread/loaded/list", {})["data"], "The selected conversation is not loaded on the destination account.")
            result = rpc.call("thread/read", {"threadId": root, "includeTurns": False})
            require(result.get("thread", {}).get("id") == root, "The destination conversation could not be verified.")
        finally:
            rpc.close()
    else:
        require(isinstance(writer_pid, int) and writer_pid > 0, "The destination conversation writer could not be verified.")
        expected = home / "thread-writer-locks" / (root + ".lock")
        held = False
        for fd in (Path("/proc") / str(writer_pid) / "fd").iterdir():
            with contextlib.suppress(OSError):
                if Path(os.readlink(fd)) == expected:
                    info = (Path("/proc") / str(writer_pid) / "fdinfo" / fd.name).read_text()
                    held = any("FLOCK" in line and "WRITE" in line for line in info.splitlines())
                    if held:
                        break
        require(held, "The destination conversation writer could not be verified.")
    return {"ok": True, "threadId": root, "loaded": True}


def grant_full_access(home, root, rpc_factory=Rpc):
    """Restore the devbox YOLO permissions of a thread resumed on the central server.

    The remote TUI refuses permission overrides on resume, and the server only
    restores saved permissions for threads it already routes to this devbox.
    """
    home, root = home_path(home), thread_id(root)
    require((home / "app-server-control" / "app-server-control.sock").exists(),
            "The account server is not running; permissions were left unchanged.")
    rpc = rpc_factory(home, allow_stdio=False)
    try:
        require(root in rpc.call("thread/loaded/list", {})["data"], "The selected conversation is not loaded on the destination account.")
        rpc.call("thread/settings/update", {"threadId": root, "approvalPolicy": "never", "sandboxPolicy": {"type": "dangerFullAccess"}})
    finally:
        rpc.close()
    return {"ok": True, "threadId": root}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="operation", required=True)
    move = sub.add_parser("transfer")
    move.add_argument("--source-home", required=True)
    move.add_argument("--target-home", required=True)
    move.add_argument("--thread-id", required=True)
    move.add_argument("--protected-thread-id", action="append", default=[])
    check = sub.add_parser("verify")
    check.add_argument("--home", required=True)
    check.add_argument("--thread-id", required=True)
    check.add_argument("--writer-pid", type=int)
    check.add_argument("--allow-unpersisted", action="store_true")
    grant = sub.add_parser("grant-full-access")
    grant.add_argument("--home", required=True)
    grant.add_argument("--thread-id", required=True)
    args = parser.parse_args()
    try:
        if args.operation == "transfer":
            result = transfer(args.source_home, args.target_home, args.thread_id, protected_thread_ids=args.protected_thread_id)
        elif args.operation == "grant-full-access":
            result = grant_full_access(args.home, args.thread_id)
        else:
            result = verify(args.home, args.thread_id, args.writer_pid, allow_unpersisted=args.allow_unpersisted)
    except Exception as error:
        # SQLite/RPC/subprocess errors may contain chat content or authentication.
        print(json.dumps({"ok": False, "error": str(error) if isinstance(error, TransferError) else "The exact conversation could not be transferred safely. Its history was preserved."}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
