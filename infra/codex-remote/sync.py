#!/usr/bin/env python3
"""Maintain permanent devbox routes and native Codex project metadata.

Docker inspection and the root-owned registry establish workspace authority.
The shared public copy is output-only and is never trusted as input. Removed
containers and recorded thread ownership remain in the catalog. No containers
are started, model turns requested, or rollout files changed by this service.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import uuid

from rpc import Rpc


DEFAULT_EXCLUDE_PREFIXES = ("dev-codex-unified-", "dev-codex-test-", "dev-codex-proof-", "dev-codex-smoke-")
CONTAINER_NAME = re.compile(r"dev-[A-Za-z0-9_.-]+\Z")
PATH_COMPONENT = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*\Z")


class SyncError(Exception):
    pass


def normalized_directory(value):
    return isinstance(value, str) and value.startswith("/") and value != "/" and "\0" not in value and os.path.normpath(value) == value


def thread_id(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise SyncError("Invalid thread UUID in the trusted catalog or native state") from exc


def validate_registry(data):
    if not isinstance(data, dict) or not isinstance(data.get("routes"), list):
        raise SyncError("Registry must contain a routes array")
    result = copy.deepcopy(data)
    result.setdefault("version", 1)
    identities, containers, cwds, owners = set(), set(), set(), {}
    for route in result["routes"]:
        if not isinstance(route, dict):
            raise SyncError("Invalid route object")
        container, identity, cwd = (route.get(key) for key in ("container", "environment_id", "cwd"))
        if (not isinstance(container, str) or not CONTAINER_NAME.fullmatch(container)
                or not isinstance(identity, str) or not identity or "\0" in identity or not normalized_directory(cwd)):
            raise SyncError("Route requires a safe Docker name, environment identity and canonical host cwd")
        if container in containers or identity in identities or cwd in cwds:
            raise SyncError("Registry has duplicate container, environment identity or host cwd")
        containers.add(container)
        identities.add(identity)
        cwds.add(cwd)
        recorded = route.get("thread_ids", [])
        if not isinstance(recorded, list):
            raise SyncError("Route thread_ids must be an array")
        route["thread_ids"] = sorted({thread_id(value) for value in recorded})
        for identifier in route["thread_ids"]:
            if identifier in owners and owners[identifier] != identity:
                raise SyncError("A recorded thread belongs to multiple trusted routes")
            owners[identifier] = identity
    result["routes"].sort(key=lambda route: route["container"])
    return result


def load_registry(path, *, required_uid=0):
    path = Path(path)
    if not path.is_absolute():
        raise SyncError("Registry path must be absolute")
    if not path.exists() and not path.is_symlink():
        return {"version": 1, "routes": []}
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != required_uid or info.st_mode & 0o022:
        raise SyncError("Trusted registry must be an owned regular file, not writable by group or others")
    try:
        return validate_registry(json.loads(path.read_text()))
    except (OSError, ValueError) as exc:
        raise SyncError("Cannot parse the trusted registry") from exc


def container_label(info):
    environment = {}
    for entry in info.get("Config", {}).get("Env", []) or []:
        if isinstance(entry, str) and "=" in entry:
            key, value = entry.split("=", 1)
            if key in {"DEVD_PROJECT", "DEVD_REPO"}:
                environment[key] = " ".join(value.split())[:100]
    if environment.get("DEVD_PROJECT") and environment.get("DEVD_REPO"):
        return environment["DEVD_PROJECT"] + "/" + environment["DEVD_REPO"]
    return info["Name"].lstrip("/")


def eligible_containers(inspected, *, exclude_prefixes=DEFAULT_EXCLUDE_PREFIXES, exclude_regexes=(), only_containers=None):
    patterns = [re.compile(pattern) for pattern in exclude_regexes]
    result = []
    for info in inspected:
        name = info.get("Name", "").lstrip("/")
        if (not CONTAINER_NAME.fullmatch(name) or name.endswith("-dind")
                or any(name.startswith(prefix) and not (only_containers is not None and prefix in DEFAULT_EXCLUDE_PREFIXES)
                       for prefix in exclude_prefixes)
                or any(pattern.search(name) for pattern in patterns)
                or (only_containers is not None and name not in only_containers)):
            continue
        workspace = [mount for mount in info.get("Mounts", []) if mount.get("Destination") == "/workspace"]
        if len(workspace) != 1 or workspace[0].get("Type") != "bind" or not normalized_directory(workspace[0].get("Source")):
            continue
        result.append(info)
    return result


def discover_routes(registry, inspected):
    result = validate_registry(registry)
    routes = {route["container"]: route for route in result["routes"]}
    for route in routes.values():
        route["state"] = "removed"
    for info in inspected:
        name = info["Name"].lstrip("/")
        source = next(mount["Source"] for mount in info["Mounts"] if mount.get("Destination") == "/workspace")
        existing = routes.get(name)
        if existing and existing["cwd"] != source:
            raise SyncError(f"Docker workspace changed for {name}; refusing to rebind recorded history automatically")
        if not existing:
            existing = {"container": name, "environment_id": "devbox_" + name, "cwd": source, "thread_ids": []}
            routes[name] = existing
        existing.setdefault("name", container_label(info))
        state = info.get("State", {})
        existing["state"] = "paused" if state.get("Paused") else "running" if state.get("Running") else "stopped"
    result["routes"] = list(routes.values())
    return validate_registry(result)


def inspect_docker():
    try:
        listed = subprocess.run(["docker", "ps", "--all", "--quiet"], check=True, capture_output=True, text=True, timeout=15)
        identifiers = listed.stdout.split()
        if not identifiers:
            return []
        output = subprocess.run(["docker", "inspect", *identifiers], check=True, capture_output=True, text=True, timeout=20)
        inspected = json.loads(output.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise SyncError("Docker discovery failed; retaining the previous registry") from exc
    if not isinstance(inspected, list) or not all(isinstance(item, dict) for item in inspected):
        raise SyncError("Docker returned invalid inspection data")
    return inspected


def read_sessions(path, *, required_uid=0):
    """Read only routing columns; vault, credentials and prompts never enter the catalog."""
    path = Path(path)
    if not path.is_absolute():
        raise SyncError("Session database path must be absolute")
    if not path.exists():
        return {}
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != required_uid or info.st_mode & 0o022:
        raise SyncError("Session database must be an owned regular file, not writable by group or others")
    with contextlib.closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
        db.row_factory = sqlite3.Row
        columns = {row[1] for row in db.execute("PRAGMA table_info(sessions)")}
        worktree = "worktree" if "worktree" in columns else "NULL AS worktree"
        return {row["id"]: dict(row) for row in db.execute(
            "SELECT id,container,folder,project,repo,solo," + worktree + " FROM sessions")}


def workspace_path(root, folder, project, repo):
    parts = (folder, repo) if folder == project else (folder, project, repo)
    return Path(root).joinpath(*parts)


def git_read(path, *args, bare=False):
    """Bounded, read-only Git plumbing. Never fetch, checkout, prune or repair here."""
    command = ["git", "-c", "safe.directory=*", *( ["--git-dir", str(path)] if bare else ["-C", str(path)] ), *args]
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update({"GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"})
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5, env=env)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 and len(result.stdout) <= 1024 * 1024 else None


def repository_inventory(root):
    """Only the two supported layout depths; never traverse worktrees or symlinks."""
    root = Path(root)
    result = []
    for pattern in ("*/*.git", "*/*/*.git"):
        for bare in sorted(root.glob(pattern)):
            parts = bare.relative_to(root).parts
            if (len(result) >= 10000 or parts[0].startswith("_") or bare.name == ".git"
                    or not bare.is_dir() or bare.is_symlink()
                    or any(not PATH_COMPONENT.fullmatch(part) for part in parts)
                    or bare.resolve() != bare):
                continue
            folder, project, repo = (parts[0], parts[0], parts[1][:-4]) if len(parts) == 2 else (parts[0], parts[1], parts[2][:-4])
            if not repo or project == folder and len(parts) == 3:
                continue
            result.append({"folder": folder, "project": project, "repo": repo, "bare": str(bare)})
    return result


def route_name_matches(route, project, repo):
    base = "dev-" + project + "-" + repo
    return route["container"] == base or re.fullmatch(re.escape(base) + r"-(?:[2-9]|[1-9][0-9]+)", route["container"]) is not None


def restore_shape(route, descriptor, root):
    if not isinstance(descriptor, dict) or set(descriptor) != {"folder", "project", "repo", "solo", "worktree", "bare", "branch"}:
        raise SyncError("Invalid recorded restore descriptor")
    if any(not isinstance(descriptor[key], str) or not PATH_COMPONENT.fullmatch(descriptor[key])
           for key in ("folder", "project", "repo")) or type(descriptor["solo"]) is not int or descriptor["solo"] not in (0, 1):
        raise SyncError("Invalid restore project identity")
    if not route_name_matches(route, descriptor["project"], descriptor["repo"]):
        raise SyncError("Restore project identity does not match the recorded container")
    ws = workspace_path(root, descriptor["folder"], descriptor["project"], descriptor["repo"])
    if descriptor["worktree"] is None:
        if descriptor["bare"] is not None or descriptor["branch"] is not None or route["cwd"] != str(ws):
            raise SyncError("Legacy restore directory does not match the recorded Docker workspace")
    else:
        expected = str(Path(root) / "_sessions" / route["container"])
        if (descriptor["solo"] or descriptor["worktree"] != expected or route["cwd"] != expected
                or descriptor["bare"] != str(ws) + ".git"
                or not isinstance(descriptor["branch"], str) or not descriptor["branch"]
                or "\0" in descriptor["branch"] or "\n" in descriptor["branch"]):
            raise SyncError("Worktree restore paths or branch do not match the recorded Docker workspace")
    return descriptor


def retained_branch(route, descriptor, *, recorded=None):
    bare, cwd = Path(descriptor["bare"]), Path(route["cwd"])
    if not bare.is_dir() or bare.resolve() != bare or git_read(bare, "rev-parse", "--is-bare-repository", bare=True) != "true":
        raise SyncError("Retained bare repository is missing or is not canonical")
    heads = git_read(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads", bare=True)
    if heads is None:
        raise SyncError("Cannot inspect retained local branches")
    heads = heads.splitlines()
    if cwd.exists():
        if not cwd.is_dir() or cwd.resolve() != cwd:
            raise SyncError("Retained worktree is not a canonical directory")
        common = git_read(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
        actual = git_read(cwd, "symbolic-ref", "--quiet", "--short", "HEAD")
        if common is None or Path(common).resolve() != bare or actual not in heads:
            raise SyncError("Retained worktree does not identify a branch in the expected bare repository")
        return actual
    if recorded:
        if recorded not in heads:
            raise SyncError("Recorded worktree branch no longer exists")
        return recorded
    # The catalog may first encounter a session after its DB row was deleted.
    # Exact surviving Git registration takes precedence over the naming fallback.
    listing = git_read(bare, "worktree", "list", "--porcelain", bare=True)
    for entry in (listing or "").split("\n\n"):
        lines = entry.splitlines()
        if "worktree " + str(cwd) in lines:
            matches = [line[len("branch refs/heads/"):] for line in lines if line.startswith("branch refs/heads/")]
            if len(matches) == 1 and matches[0] in heads:
                return matches[0]
            raise SyncError("Retained worktree registration has no unique local branch")
    base = "dev-" + descriptor["project"] + "-" + descriptor["repo"]
    if route["container"] != base:
        candidate = "session/" + descriptor["repo"] + "-" + route["container"][len(base) + 1:]
        if candidate in heads:
            return candidate
    elif len(heads) == 1:
        return heads[0]
    raise SyncError("Removed worktree has no unambiguous retained branch")


def capture_restore_routes(registry, sessions, root, *, inventory=None):
    """Persist exact recreation coordinates before a later end deletes the DB row.

    Docker's already verified bind source remains authoritative. Historical routes
    without a row can be recovered only from an unambiguous host repository layout.
    Unknown routes stay visible but receive no executable restoration descriptor.
    """
    root = Path(root).resolve()
    result, errors = validate_registry(registry), []
    inventory = repository_inventory(root) if inventory is None else inventory
    for route in result["routes"]:
        previous = route.get("restore")
        valid_previous = False
        try:
            if previous is not None:
                restore_shape(route, previous, root)
                valid_previous = True
            row = sessions.get(route["container"])
            if row is not None:
                if row.get("id") != route["container"] or row.get("container") != route["container"]:
                    raise SyncError("Session row identity does not match the recorded container")
                descriptor = {key: row.get(key) for key in ("folder", "project", "repo", "solo", "worktree")}
                if any(not isinstance(descriptor[key], str) or not PATH_COMPONENT.fullmatch(descriptor[key])
                       for key in ("folder", "project", "repo")):
                    raise SyncError("Invalid session project identity")
                descriptor.update({"bare": str(workspace_path(root, descriptor["folder"], descriptor["project"], descriptor["repo"])) + ".git"
                                   if descriptor["worktree"] else None, "branch": "pending" if descriptor["worktree"] else None})
            elif previous is not None:
                descriptor = copy.deepcopy(previous)
            elif route["cwd"] == str(root / "_sessions" / route["container"]):
                matches = [candidate for candidate in inventory if route_name_matches(route, candidate["project"], candidate["repo"])]
                if len(matches) != 1:
                    raise SyncError("Removed session has no unique retained repository")
                descriptor = {**matches[0], "solo": 0, "worktree": route["cwd"], "branch": "pending"}
            else:
                try:
                    parts = Path(route["cwd"]).relative_to(root).parts
                except ValueError:
                    parts = ()
                if len(parts) not in (2, 3) or parts[0].startswith("_"):
                    raise SyncError("Legacy workspace does not match a supported repository layout")
                folder, project, repo = (parts[0], parts[0], parts[1]) if len(parts) == 2 else parts
                descriptor = {"folder": folder, "project": project, "repo": repo,
                              "solo": int(re.fullmatch(r"claudeSolo-[1-9][0-9]*", repo) is not None),
                              "worktree": None, "bare": None, "branch": None}
            restore_shape(route, descriptor, root)
            if previous is not None and any(previous[key] != descriptor[key] for key in descriptor if key != "branch"):
                raise SyncError("Session recreation identity changed; refusing to replace recorded history")
            if descriptor["worktree"]:
                descriptor["branch"] = retained_branch(route, descriptor, recorded=previous.get("branch") if previous else None)
            else:
                cwd = Path(route["cwd"])
                if not cwd.is_dir() or cwd.resolve() != cwd or (not descriptor["solo"] and not (cwd / ".git").exists()):
                    raise SyncError("Retained legacy or solo workspace is missing")
            route["restore"] = restore_shape(route, descriptor, root)
            route.pop("restore_error", None)
        except SyncError as error:
            # A temporarily unavailable Git directory must not erase the only
            # surviving record of a non-default branch. The resume endpoint
            # independently validates these coordinates against live state.
            if not valid_previous:
                route.pop("restore", None)
            route["restore_error"] = str(error)
            errors.append({"container": route["container"], "error": str(error)})
    return result, {"restorable_routes": sum("restore" in route and "restore_error" not in route for route in result["routes"]),
                    "restore_errors": errors}


def read_threads(home):
    path = Path(home) / "state_5.sqlite"
    if not path.is_file():
        return {}, []
    with contextlib.closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")
        rows = {thread_id(row["id"]): dict(row) for row in db.execute("SELECT id,source,cwd,project_id FROM threads")}
        edges = [(thread_id(row[0]), thread_id(row[1])) for row in db.execute("SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges")]
        for identifier, row in rows.items():
            try:
                parent = json.loads(row["source"]).get("subagent", {}).get("thread_spawn", {}).get("parent_thread_id")
            except (ValueError, AttributeError):
                parent = None
            if parent:
                edges.append((thread_id(parent), identifier))
        return rows, sorted(set(edges))


def active_thread_owners(home, inspected, *, proc_root=Path("/proc")):
    """Join real flock inodes to host PIDs and their inspected Docker cgroup.

    Process environment alone cannot nominate a workspace: the owning process
    must belong to the matching full Docker ID in the host's kernel cgroup data.
    """
    containers = {info["Id"]: info["Name"].lstrip("/") for info in inspected if re.fullmatch(r"[0-9a-f]{64}", info.get("Id", ""))}
    locks = {}
    for path in (Path(home) / "thread-writer-locks").glob("*.lock"):
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                continue
            identifier = thread_id(path.stem)
            locks[(os.major(info.st_dev), os.minor(info.st_dev), info.st_ino)] = identifier
        except (OSError, SyncError):
            continue
    try:
        lines = (proc_root / "locks").read_text().splitlines()
    except OSError:
        return {}
    result = {}
    for line in lines:
        fields = line.split()
        if len(fields) < 8 or fields[1:4] != ["FLOCK", "ADVISORY", "WRITE"]:
            continue
        try:
            major, minor, inode = fields[5].split(":")
            identifier = locks.get((int(major, 16), int(minor, 16), int(inode)))
            if not identifier or not fields[4].isdigit():
                continue
            process = proc_root / fields[4]
            cgroup = (process / "cgroup").read_text()
            matches = [name for docker_id, name in containers.items() if re.search(r"docker[-/]" + docker_id + r"(?:\.scope)?(?:/|$)", cgroup, re.MULTILINE)]
            if len(matches) != 1:
                continue
            session = None
            for item in (process / "environ").read_bytes().split(b"\0"):
                if item.startswith(b"DEVD_SESSION_ID="):
                    session = item.split(b"=", 1)[1].decode()
            if session is not None and session != matches[0]:
                continue
            result[identifier] = matches[0]
        except (OSError, ValueError, UnicodeError):
            continue
    return result


def bind_threads(registry, rows, edges, active_owners):
    result = validate_registry(registry)
    routes = {route["container"]: route for route in result["routes"]}
    owners = {identifier: name for name, route in routes.items() for identifier in route["thread_ids"]}
    conflicts = set()

    def assign(identifier, owner):
        if identifier in owners and owners[identifier] != owner:
            conflicts.add(identifier)
            return False
        changed = identifier not in owners
        owners[identifier] = owner
        return changed

    for identifier, row in rows.items():
        cwd = row.get("cwd")
        candidates = [route for route in routes.values() if normalized_directory(cwd) and (cwd == route["cwd"] or cwd.startswith(route["cwd"] + "/"))]
        if candidates:
            candidate = max(candidates, key=lambda route: len(route["cwd"]))
            assign(identifier, candidate["container"])
        elif cwd == "/workspace" or isinstance(cwd, str) and cwd.startswith("/workspace/"):
            container = active_owners.get(identifier)
            if container in routes:
                assign(identifier, container)
    changed = True
    while changed:
        changed = False
        for parent, child in edges:
            if parent in owners and child in rows:
                changed = assign(child, owners[parent]) or changed
    for name, route in routes.items():
        route["thread_ids"] = sorted(identifier for identifier, owner in owners.items() if owner == name)
    result["routes"] = list(routes.values())
    return validate_registry(result), {"unassigned_thread_ids": sorted(rows.keys() - owners.keys()), "conflicting_thread_ids": sorted(conflicts)}


def all_projects(rpc):
    projects, cursor, seen = {}, None, set()
    while True:
        response = rpc.call("project/list", {"limit": 100, "cursor": cursor})
        for project in response["data"]:
            projects[project["id"]] = project
        cursor = response.get("nextCursor")
        if not cursor:
            return projects
        if cursor in seen:
            raise SyncError("Native project pagination repeated its cursor")
        seen.add(cursor)


def ensure_project(rpc, projects, *, remembered_id, key, name, roots, metadata):
    project = projects.get(remembered_id)
    if project is None:
        project = rpc.call("project/create", {"idempotencyKey": key, "name": name, "roots": roots, "metadata": metadata})["project"]
        projects[project["id"]] = project
    if project.get("roots") != roots:
        project = rpc.call("project/update", {"projectId": project["id"], "roots": roots})["project"]
        projects[project["id"]] = project
    return project["id"]


def trust_hooks(rpc, cwds):
    if not cwds:
        return 0
    response = rpc.call("hooks/list", {"cwds": sorted(set(cwds))})
    trust, conflicts = {}, set()
    for entry in response.get("data", []):
        for hook in entry.get("hooks", []):
            key, digest = hook.get("key"), hook.get("currentHash")
            if hook.get("trustStatus") not in {"untrusted", "modified"} or not isinstance(key, str) or not isinstance(digest, str):
                continue
            if key in trust and trust[key] != digest:
                conflicts.add(key)
            trust[key] = digest
    edits = [{"keyPath": "hooks.state." + json.dumps(key) + ".trusted_hash", "value": digest, "mergeStrategy": "upsert"}
             for key, digest in sorted(trust.items()) if key not in conflicts]
    if edits:
        rpc.call("config/batchWrite", {"edits": edits, "reloadUserConfig": True})
    return len(edits)


def sync_projects(rpc, registry, rows, *, existing_directory=lambda path: Path(path).is_dir(), sync_hooks=True):
    result = validate_registry(registry)
    projects = all_projects(rpc)
    desired, assigned, errors = {}, 0, []
    for route in result["routes"]:
        try:
            project_id = ensure_project(rpc, projects, remembered_id=route.get("project_id"),
                                        key="devbox:" + route["environment_id"], name=route.get("name") or route["container"],
                                        roots=[{"path": route["cwd"]}], metadata={"devbox.environment_id": route["environment_id"], "devbox.container": route["container"]})
            route["project_id"] = project_id
            for identifier in route["thread_ids"]:
                if identifier in rows:
                    desired[identifier] = project_id
        except (RuntimeError, KeyError, ValueError, OSError):
            errors.append("project:" + route["container"])
    routed = {identifier for route in result["routes"] for identifier in route["thread_ids"]}
    unassigned = rows.keys() - routed
    if unassigned:
        try:
            project_id = ensure_project(rpc, projects, remembered_id=result.get("unassigned_project_id"),
                                        key="devbox:unassigned-history", name="Unassigned sessions", roots=[], metadata={"devbox.unassigned": "true"})
            result["unassigned_project_id"] = project_id
            desired.update({identifier: project_id for identifier in unassigned})
        except (RuntimeError, KeyError, ValueError, OSError):
            errors.append("project:unassigned")
    for identifier, project_id in sorted(desired.items()):
        if rows[identifier].get("project_id") == project_id:
            continue
        try:
            rpc.call("thread/metadata/update", {"threadId": identifier, "projectId": project_id})
            assigned += 1
        except (RuntimeError, KeyError, ValueError, OSError):
            errors.append("thread:" + identifier)
    trusted = 0
    if sync_hooks:
        try:
            trusted = trust_hooks(rpc, [route["cwd"] for route in result["routes"] if existing_directory(route["cwd"])])
        except (RuntimeError, KeyError, ValueError, OSError):
            errors.append("hooks")
    return result, {"assigned_threads": assigned, "trusted_hooks": trusted, "metadata_errors": errors}


def atomic_json(path, data, *, mode, uid):
    encoded = (json.dumps(data, indent=2, sort_keys=True) + "\n").encode()
    try:
        info = path.lstat()
        if stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_mode & 0o777 == mode and path.read_bytes() == encoded:
            return False
    except FileNotFoundError:
        pass
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        if os.geteuid() == 0:
            os.fchown(descriptor, uid, -1)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        return True
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def publish_registry(registry_path, home, registry, *, uid=0):
    atomic_json(registry_path, registry, mode=0o644, uid=uid)
    atomic_json(home / "devbox-routes.json", registry, mode=0o444, uid=uid)


@contextlib.contextmanager
def registry_lock(path, *, required_uid=0):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    info = path.parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != required_uid or info.st_mode & 0o022:
        raise SyncError("Trusted registry directory must be owned and not writable by group or others")
    descriptor = os.open(path.parent / ("." + path.name + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != required_uid:
            raise SyncError("Invalid registry synchronization lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def sync_once(*, registry_path, home, socket_path, dry_run=False, exclude_prefixes=DEFAULT_EXCLUDE_PREFIXES,
              exclude_regexes=(), only_containers=None, trusted_uid=0, inspect=inspect_docker, rpc_factory=Rpc,
              proc_root=Path("/proc"), devd_db="/var/lib/devd/devd.sqlite", devd_root="/srv/dev"):
    registry_path, home = Path(registry_path).absolute(), Path(home).resolve(strict=True)
    if not home.is_dir():
        raise SyncError("Codex home must already exist")
    with contextlib.nullcontext() if dry_run else registry_lock(registry_path, required_uid=trusted_uid):
        registry = load_registry(registry_path, required_uid=trusted_uid)
        inspected = eligible_containers(inspect(), exclude_prefixes=exclude_prefixes, exclude_regexes=exclude_regexes, only_containers=only_containers)
        registry = discover_routes(registry, inspected)
        registry, restore_report = capture_restore_routes(registry, read_sessions(devd_db, required_uid=trusted_uid), devd_root)
        rows, edges = read_threads(home)
        registry, bindings = bind_threads(registry, rows, edges, active_thread_owners(home, inspected, proc_root=proc_root))
        report = {"status": "dry_run" if dry_run else "synchronized", "routes": len(registry["routes"]),
                  "native_threads": len(rows), **bindings, **restore_report}
        if dry_run:
            return report
        # Publish discovery before connecting: a temporarily unavailable app server
        # must not prevent co from finding its newly opened container's route.
        publish_registry(registry_path, home, registry, uid=trusted_uid)
        rpc = rpc_factory(str(socket_path))
        try:
            registry, metadata = sync_projects(rpc, registry, rows)
        finally:
            rpc.close()
        publish_registry(registry_path, home, registry, uid=trusted_uid)
        return {**report, **metadata}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", default=os.environ.get("DEVD_CODEX_ROUTES_FILE", "/etc/codex-devbox/routes.json"))
    parser.add_argument("--home", default=os.environ.get("CODEX_HOME", "/home/dev/.codex"))
    parser.add_argument("--devd-db", default=os.environ.get("DEVD_DB", "/var/lib/devd/devd.sqlite"))
    parser.add_argument("--devd-root", default=os.environ.get("DEVD_ROOT", "/srv/dev"))
    parser.add_argument("--socket")
    parser.add_argument("--interval", type=float, default=5)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--exclude-prefix", action="append", default=[])
    parser.add_argument("--exclude-container-regex", action="append", default=[])
    parser.add_argument("--container", action="append", help="Restrict to exact Docker names; allows default proof prefixes for isolated verification")
    args = parser.parse_args()
    if args.interval <= 0:
        parser.error("--interval must be positive")
    if not args.dry_run and os.geteuid() != 0:
        parser.error("Catalog sync must run as root to maintain the trusted registry")
    socket_path = args.socket or str(Path(args.home) / "app-server-control/app-server-control.sock")
    while True:
        status = 0
        try:
            result = sync_once(registry_path=args.registry, home=args.home, socket_path=socket_path, dry_run=args.dry_run,
                               exclude_prefixes=(*DEFAULT_EXCLUDE_PREFIXES, *args.exclude_prefix),
                               exclude_regexes=args.exclude_container_regex, only_containers=set(args.container) if args.container else None,
                               devd_db=args.devd_db, devd_root=args.devd_root)
            if result.get("metadata_errors"):
                status = 1
            print(json.dumps(result, sort_keys=True), flush=True)
        except (SyncError, OSError, ValueError, sqlite3.Error, RuntimeError) as error:
            # Never include Docker inspection, RPC payloads, auth, or chat content.
            print(json.dumps({"status": "error", "error": str(error)}), file=sys.stderr, flush=True)
            status = 1
        if args.once or args.dry_run:
            return status
        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
