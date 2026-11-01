"""python3 -m unittest discover -s devd/test -p 'codexRemoteSync_test.py'."""

import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


DIRECTORY = Path(__file__).resolve().parents[2] / "infra/codex-remote"
sys.path.insert(0, str(DIRECTORY))
SPEC = importlib.util.spec_from_file_location("codex_remote_catalog_sync", DIRECTORY / "sync.py")
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)
ROOT = "019a0000-0000-7000-8000-000000000001"
CHILD = "019a0000-0000-7000-8000-000000000002"
GRANDCHILD = "019a0000-0000-7000-8000-000000000003"
OTHER = "019a0000-0000-7000-8000-000000000004"
FORGOTTEN = "019a0000-0000-7000-8000-000000000005"


def container(name="dev-apps-example", cwd="/srv/dev/_sessions/dev-apps-example", running=True, docker_id="a" * 64):
    return {"Name": "/" + name, "Id": docker_id, "State": {"Running": running, "Paused": False},
            "Config": {"Env": ["DEVD_SESSION_ID=dev-apps-forged", "DEVD_PROJECT=apps", "DEVD_REPO=example"]},
            "Mounts": [{"Type": "bind", "Source": cwd, "Destination": "/workspace"}]}


def route(name="dev-apps-example", cwd="/srv/dev/_sessions/dev-apps-example", ids=()):
    return {"container": name, "environment_id": "devbox_" + name, "cwd": cwd, "thread_ids": list(ids)}


class FakeRpc:
    def __init__(self, rows):
        self.rows = rows
        self.projects = {}
        self.keys = {}
        self.calls = []
        self.hooks = []
        self.closed = False

    def close(self):
        self.closed = True

    def call(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        if method == "project/list":
            return {"data": list(self.projects.values()), "nextCursor": None}
        if method == "project/create":
            key = params["idempotencyKey"]
            if key not in self.keys:
                identifier = "project-" + str(len(self.projects) + 1)
                self.keys[key] = identifier
                self.projects[identifier] = {"id": identifier, "name": params["name"], "roots": params["roots"], "metadata": params.get("metadata", {})}
            return {"project": self.projects[self.keys[key]]}
        if method == "project/update":
            project = self.projects[params["projectId"]]
            project["roots"] = params["roots"]
            return {"project": project}
        if method == "thread/metadata/update":
            self.assert_metadata_only(params)
            self.rows[params["threadId"]]["project_id"] = params["projectId"]
            return {"thread": {"id": params["threadId"], "projectId": params["projectId"]}}
        if method == "hooks/list":
            return {"data": [{"hooks": self.hooks}]}
        if method == "config/batchWrite":
            self.hooks = []
            return {}
        raise AssertionError("Forbidden or unexpected RPC: " + method)

    @staticmethod
    def assert_metadata_only(params):
        if set(params) != {"threadId", "projectId"}:
            raise AssertionError("Sync attempted to change non-project thread metadata")


class CodexRemoteSyncTests(unittest.TestCase):
    def bare_repository(self, root, repo="example", folder="apps", project="apps"):
        bare = Path(str(sync.workspace_path(root, folder, project, repo)) + ".git")
        bare.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
        env = {**os.environ, "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
               "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}

        def git(*args, data=None):
            return subprocess.run(["git", "--git-dir", str(bare), *args], input=data, env=env,
                                  check=True, capture_output=True, text=True).stdout.strip()
        tree = git("mktree", data="")
        commit = git("commit-tree", tree, "-m", "fixture")
        git("update-ref", "refs/heads/main", commit)
        git("symbolic-ref", "HEAD", "refs/heads/main")
        return bare, git

    def test_restore_coordinates_survive_deleted_row_and_worktree_on_changed_branch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            bare, git = self.bare_repository(root)
            cwd = root / "_sessions/dev-apps-example"
            cwd.parent.mkdir()
            git("worktree", "add", "-b", "fix/actual-session-branch", str(cwd), "main")
            row = {"id": "dev-apps-example", "container": "dev-apps-example", "folder": "apps", "project": "apps",
                   "repo": "example", "solo": 0, "worktree": str(cwd)}
            registry, report = sync.capture_restore_routes({"routes": [route(cwd=str(cwd), ids=[ROOT])]}, {row["id"]: row}, root)
            self.assertEqual(report["restore_errors"], [])
            expected = {"folder": "apps", "project": "apps", "repo": "example", "solo": 0,
                        "worktree": str(cwd), "bare": str(bare), "branch": "fix/actual-session-branch"}
            self.assertEqual(registry["routes"][0]["restore"], expected)
            git("worktree", "remove", str(cwd))
            restored, report = sync.capture_restore_routes(registry, {}, root)
            self.assertEqual(report["restore_errors"], [])
            self.assertEqual(restored["routes"][0]["restore"], expected)
            self.assertEqual(restored["routes"][0]["thread_ids"], [ROOT])
            # Losing the recorded branch is an actionable error, not permission
            # to forget its identity and later select the remaining default.
            git("branch", "-D", "fix/actual-session-branch")
            unavailable, report = sync.capture_restore_routes(restored, {}, root)
            self.assertEqual(unavailable["routes"][0]["restore"], expected)
            self.assertIn("no longer exists", report["restore_errors"][0]["error"])
            self.assertIn("no longer exists", unavailable["routes"][0]["restore_error"])
            git("branch", "fix/actual-session-branch", "main")
            recovered, report = sync.capture_restore_routes(unavailable, {}, root)
            self.assertEqual(report["restore_errors"], [])
            self.assertNotIn("restore_error", recovered["routes"][0])

    def test_live_branch_switch_updates_recorded_descriptor_before_end(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _, git = self.bare_repository(root)
            cwd = root / "_sessions/dev-apps-example"
            cwd.parent.mkdir()
            git("worktree", "add", str(cwd), "main")
            old = route(cwd=str(cwd))
            registry, _ = sync.capture_restore_routes({"routes": [old]}, {}, root)
            self.assertEqual(registry["routes"][0]["restore"]["branch"], "main")
            subprocess.run(["git", "-C", str(cwd), "switch", "-c", "fix/user-switched"], check=True, capture_output=True)
            registry, report = sync.capture_restore_routes(registry, {}, root)
            self.assertEqual(report["restore_errors"], [])
            self.assertEqual(registry["routes"][0]["restore"]["branch"], "fix/user-switched")

    def test_old_removed_base_and_numbered_sessions_use_retained_local_branches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _, git = self.bare_repository(root)
            base = route(cwd=str(root / "_sessions/dev-apps-example"))
            result, report = sync.capture_restore_routes({"routes": [base]}, {}, root)
            self.assertEqual(report["restore_errors"], [])
            self.assertEqual(result["routes"][0]["restore"]["branch"], "main")
            git("branch", "session/example-12", "main")
            numbered = route("dev-apps-example-12", str(root / "_sessions/dev-apps-example-12"))
            result, report = sync.capture_restore_routes({"routes": [numbered]}, {}, root)
            self.assertEqual(report["restore_errors"], [])
            self.assertEqual(result["routes"][0]["restore"]["branch"], "session/example-12")
            # Once multiple heads exist, the base ID alone no longer proves its branch.
            result, report = sync.capture_restore_routes({"routes": [base]}, {}, root)
            self.assertNotIn("restore", result["routes"][0])
            self.assertIn("unambiguous retained branch", report["restore_errors"][0]["error"])

    def test_repository_number_suffix_is_not_mistaken_for_session_number(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.bare_repository(root, repo="example-2")
            old = route("dev-apps-example-2", str(root / "_sessions/dev-apps-example-2"))
            result, report = sync.capture_restore_routes({"routes": [old]}, {}, root)
            self.assertEqual(report["restore_errors"], [])
            self.assertEqual(result["routes"][0]["restore"]["repo"], "example-2")
            self.assertEqual(result["routes"][0]["restore"]["branch"], "main")
            _, git = self.bare_repository(root)
            git("branch", "session/example-2", "main")
            result, report = sync.capture_restore_routes({"routes": [old]}, {}, root)
            self.assertNotIn("restore", result["routes"][0])
            self.assertIn("unique retained repository", report["restore_errors"][0]["error"])

    def test_duplicate_project_names_in_different_folders_are_ambiguous(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.bare_repository(root, folder="one", project="apps")
            self.bare_repository(root, folder="two", project="apps")
            old = route(cwd=str(root / "_sessions/dev-apps-example"))
            result, report = sync.capture_restore_routes({"routes": [old]}, {}, root)
            self.assertNotIn("restore", result["routes"][0])
            self.assertIn("unique retained repository", report["restore_errors"][0]["error"])

    def test_legacy_solo_directory_without_git_is_retained_without_creating_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            cwd = root / "acme/agent/claudeSolo-7"
            cwd.mkdir(parents=True)
            old = route("dev-agent-claudeSolo-7", str(cwd))
            result, report = sync.capture_restore_routes({"routes": [old]}, {}, root)
            self.assertEqual(report["restore_errors"], [])
            self.assertEqual(result["routes"][0]["restore"], {"folder": "acme", "project": "agent", "repo": "claudeSolo-7",
                             "solo": 1, "worktree": None, "bare": None, "branch": None})
            self.assertFalse((cwd / ".git").exists())
            cwd.rmdir()
            result, report = sync.capture_restore_routes(result, {}, root)
            self.assertIn("missing", report["restore_errors"][0]["error"])
            self.assertEqual(result["routes"][0]["restore"]["repo"], "claudeSolo-7")
            self.assertFalse(cwd.exists())

    def test_restore_rejects_database_row_that_disagrees_with_real_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.bare_repository(root)
            row = {"id": "dev-apps-example", "container": "dev-apps-example", "folder": "apps", "project": "apps",
                   "repo": "example", "solo": 0, "worktree": str(root / "_sessions/dev-apps-other")}
            old = route(cwd=str(root / "_sessions/dev-apps-example"))
            result, report = sync.capture_restore_routes({"routes": [old]}, {row["id"]: row}, root)
            self.assertNotIn("restore", result["routes"][0])
            self.assertIn("recorded Docker workspace", report["restore_errors"][0]["error"])

    def test_database_restore_reader_does_not_copy_credentials_or_prompts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "devd.sqlite"
            with contextlib.closing(sqlite3.connect(path)) as db, db:
                db.execute("CREATE TABLE sessions(id TEXT,container TEXT,folder TEXT,project TEXT,repo TEXT,solo INTEGER,worktree TEXT,prompt TEXT)")
                db.execute("INSERT INTO sessions VALUES ('dev-apps-example','dev-apps-example','apps','apps','example',0,NULL,'private')")
            rows = sync.read_sessions(path, required_uid=os.geteuid())
            self.assertEqual(set(rows["dev-apps-example"]), {"id", "container", "folder", "project", "repo", "solo", "worktree"})

    def test_discovery_uses_docker_mount_and_name_not_environment_authority(self):
        found = sync.discover_routes({"version": 1, "routes": []}, sync.eligible_containers([container()]))
        self.assertEqual(found["routes"][0]["container"], "dev-apps-example")
        self.assertEqual(found["routes"][0]["environment_id"], "devbox_dev-apps-example")
        self.assertEqual(found["routes"][0]["cwd"], "/srv/dev/_sessions/dev-apps-example")
        self.assertEqual(found["routes"][0]["name"], "apps/example")

    def test_dind_and_proof_containers_are_excluded_and_exact_filter_supported(self):
        candidates = [container(), container("dind-dev-apps-example"), container("dev-apps-example-dind"),
                      container("dev-codex-unified-a"), container("dev-codex-proof-smoke"), container("dev-apps-another")]
        accepted = sync.eligible_containers(candidates)
        self.assertEqual({row["Name"] for row in accepted}, {"/dev-apps-example", "/dev-apps-another"})
        accepted = sync.eligible_containers(candidates, only_containers={"dev-apps-example"})
        self.assertEqual([row["Name"] for row in accepted], ["/dev-apps-example"])
        proof = sync.eligible_containers(candidates, only_containers={"dev-codex-unified-a"})
        self.assertEqual([row["Name"] for row in proof], ["/dev-codex-unified-a"])

    def test_nonbind_or_noncanonical_workspace_is_not_a_route(self):
        candidates = []
        for change in ({"Type": "volume"}, {"Source": "/srv/dev/../private"}, {"Source": "/"}):
            item = container()
            item["Mounts"][0].update(change)
            candidates.append(item)
        self.assertEqual(sync.eligible_containers(candidates), [])

    def test_removed_stopped_and_historical_threads_are_retained(self):
        old = route(ids=[ROOT, FORGOTTEN])
        old.update({"project_id": "existing-native-project", "custom_seed_evidence": "retained"})
        registry = {"version": 1, "routes": [old]}
        stopped = sync.discover_routes(registry, [container(running=False)])
        self.assertEqual(stopped["routes"][0]["state"], "stopped")
        removed = sync.discover_routes(stopped, [])
        self.assertEqual(removed["routes"][0]["state"], "removed")
        self.assertEqual(removed["routes"][0]["thread_ids"], [ROOT, FORGOTTEN])
        self.assertEqual(removed["routes"][0]["project_id"], "existing-native-project")
        self.assertEqual(removed["routes"][0]["custom_seed_evidence"], "retained")
        self.assertEqual(sync.discover_routes(removed, []), removed)

    def test_existing_history_cannot_silently_move_to_a_new_mount(self):
        with self.assertRaisesRegex(sync.SyncError, "refusing to rebind"):
            sync.discover_routes({"routes": [route(ids=[ROOT])]}, [container(cwd="/srv/different-project")])

    def test_canonical_active_and_descendant_binding_preserves_old_ids(self):
        registry = {"routes": [route(ids=[FORGOTTEN])]}
        rows = {
            ROOT: {"cwd": "/workspace", "project_id": None},
            CHILD: {"cwd": "/workspace", "project_id": None},
            GRANDCHILD: {"cwd": "/workspace", "project_id": None},
            OTHER: {"cwd": "/srv/dev/_sessions/dev-apps-example/subdir", "project_id": None},
        }
        result, report = sync.bind_threads(registry, rows, [(ROOT, CHILD), (CHILD, GRANDCHILD)], {ROOT: "dev-apps-example"})
        self.assertEqual(result["routes"][0]["thread_ids"], sorted([ROOT, CHILD, GRANDCHILD, OTHER, FORGOTTEN]))
        self.assertEqual(report["unassigned_thread_ids"], [])

    def test_conflicting_discovery_does_not_override_explicit_thread_owner(self):
        registry = {"routes": [route(ids=[ROOT]), route("dev-apps-other", "/srv/other")]}
        result, report = sync.bind_threads(registry, {ROOT: {"cwd": "/srv/other"}}, [], {})
        self.assertEqual(result["routes"][0]["thread_ids"], [ROOT])
        self.assertEqual(report["conflicting_thread_ids"], [ROOT])

    def test_native_state_reader_includes_serialized_subagent_parent_edges(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with contextlib.closing(sqlite3.connect(home / "state_5.sqlite")) as db, db:
                db.execute("CREATE TABLE threads(id TEXT,source TEXT,cwd TEXT,project_id TEXT)")
                db.execute("CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT)")
                db.executemany("INSERT INTO threads VALUES (?,?,?,NULL)", [(ROOT, "cli", "/workspace"),
                    (CHILD, json.dumps({"subagent": {"thread_spawn": {"parent_thread_id": ROOT}}}), "/workspace")])
            rows, edges = sync.read_threads(home)
            self.assertEqual(set(rows), {ROOT, CHILD})
            self.assertEqual(edges, [(ROOT, CHILD)])

    def test_kernel_lock_mapping_requires_actual_docker_cgroup(self):
        with tempfile.TemporaryDirectory() as directory:
            home, proc = Path(directory) / "home", Path(directory) / "proc"
            locks = home / "thread-writer-locks"
            locks.mkdir(parents=True)
            lock = locks / (ROOT + ".lock")
            lock.touch()
            info = lock.stat()
            process = proc / "123"
            process.mkdir(parents=True)
            (proc / "locks").write_text(f"1: FLOCK ADVISORY WRITE 123 {os.major(info.st_dev):x}:{os.minor(info.st_dev):x}:{info.st_ino} 0 EOF\n")
            (process / "environ").write_bytes(b"DEVD_SESSION_ID=dev-apps-example\0SECRET=never-read-or-print\0")
            (process / "cgroup").write_text("0::/system.slice/other-process.scope\n")
            self.assertEqual(sync.active_thread_owners(home, [container()], proc_root=proc), {})
            (process / "cgroup").write_text("0::/system.slice/docker-" + "a" * 64 + ".scope\n")
            self.assertEqual(sync.active_thread_owners(home, [container()], proc_root=proc), {ROOT: "dev-apps-example"})
            (process / "environ").write_bytes(b"DEVD_SESSION_ID=dev-apps-forged\0")
            self.assertEqual(sync.active_thread_owners(home, [container()], proc_root=proc), {})

    def test_native_projects_are_idempotent_and_unassigned_history_stays_visible(self):
        rows = {ROOT: {"project_id": "old-workspace-project"}, CHILD: {"project_id": None}, OTHER: {"project_id": None}}
        rpc = FakeRpc(rows)
        registry = {"routes": [route(ids=[ROOT, CHILD])]}
        result, report = sync.sync_projects(rpc, registry, rows, existing_directory=lambda _: False)
        self.assertEqual(report["assigned_threads"], 3)
        self.assertEqual(report["metadata_errors"], [])
        self.assertEqual(len(rpc.projects), 2)
        self.assertEqual(rpc.projects[result["unassigned_project_id"]]["roots"], [])
        self.assertEqual(len(result["routes"]), 1)  # No executable route invented for unknown history.
        rpc.calls.clear()
        again, report = sync.sync_projects(rpc, result, rows, existing_directory=lambda _: False)
        self.assertEqual(again, result)
        self.assertEqual(report["assigned_threads"], 0)
        self.assertEqual([method for method, _ in rpc.calls], ["project/list"])

    def test_existing_idempotency_key_updates_old_workspace_root_without_duplicate_project(self):
        rows = {ROOT: {"project_id": None}}
        rpc = FakeRpc(rows)
        key = "devbox:devbox_dev-apps-example"
        rpc.call("project/create", {"idempotencyKey": key, "name": "Old label", "roots": [{"path": "/workspace"}]})
        result, _ = sync.sync_projects(rpc, {"routes": [route(ids=[ROOT])]}, rows, existing_directory=lambda _: False)
        self.assertEqual(len(rpc.projects), 1)
        self.assertEqual(rpc.projects[result["routes"][0]["project_id"]]["roots"], [{"path": "/srv/dev/_sessions/dev-apps-example"}])

    def test_hook_trust_only_updates_current_hashes_with_quoted_keys(self):
        rpc = FakeRpc({})
        key = '/srv/dev/example/.claude/hooks.json:hooks["UserPromptSubmit"].0'
        rpc.hooks = [{"key": key, "currentHash": "current-hash", "trustStatus": "modified"},
                     {"key": "already-trusted", "currentHash": "unchanged", "trustStatus": "trusted"}]
        self.assertEqual(sync.trust_hooks(rpc, ["/srv/dev/example"]), 1)
        method, params = rpc.calls[-1]
        self.assertEqual(method, "config/batchWrite")
        self.assertEqual(params, {"edits": [{"keyPath": "hooks.state." + json.dumps(key) + ".trusted_hash",
                                           "value": "current-hash", "mergeStrategy": "upsert"}], "reloadUserConfig": True})
        self.assertEqual(sync.trust_hooks(rpc, ["/srv/dev/example"]), 0)

    def test_public_copy_is_output_only_and_cannot_poison_trusted_routes(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            home = base / "home"
            home.mkdir()
            registry_path = base / "routes.json"
            trusted = {"version": 1, "routes": [route(ids=[ROOT])]}
            sync.publish_registry(registry_path, home, trusted, uid=os.geteuid())
            public = home / "devbox-routes.json"
            inode = registry_path.stat().st_ino
            public.unlink()
            public.symlink_to(registry_path)
            self.assertEqual(sync.load_registry(registry_path, required_uid=os.geteuid()), trusted)
            sync.publish_registry(registry_path, home, trusted, uid=os.geteuid())
            self.assertFalse(public.is_symlink())
            self.assertEqual(registry_path.stat().st_ino, inode)
            self.assertEqual(public.stat().st_mode & 0o777, 0o444)

    def test_untrusted_registry_and_duplicate_thread_ownership_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "routes.json"
            path.write_text('{"routes":[]}')
            path.chmod(0o666)
            with self.assertRaisesRegex(sync.SyncError, "Trusted registry"):
                sync.load_registry(path, required_uid=os.geteuid())
        with self.assertRaisesRegex(sync.SyncError, "multiple trusted routes"):
            sync.validate_registry({"routes": [route(ids=[ROOT]), route("dev-apps-other", "/srv/other", ids=[ROOT])]})

    def test_full_cycle_publishes_routes_before_rpc_and_preserves_discovery_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            home, trusted = base / "home", base / "trusted"
            home.mkdir()
            trusted.mkdir()
            workspace = base / "workspace"
            workspace.mkdir()
            registry_path = trusted / "routes.json"
            with contextlib.closing(sqlite3.connect(home / "state_5.sqlite")) as db, db:
                db.execute("CREATE TABLE threads(id TEXT,source TEXT,cwd TEXT,project_id TEXT)")
                db.execute("CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT)")
                db.execute("INSERT INTO threads VALUES (?,'cli',?,NULL)", (ROOT, str(workspace)))
            raw_history = home / "rollout-probe.jsonl"
            raw_history.write_bytes(b"private bytes must remain untouched\n")
            (home / "devbox-routes.json").write_text(json.dumps({"routes": [route("dev-apps-forged", "/root/private", ids=[ROOT])]}))
            rpc = FakeRpc({ROOT: {"project_id": None}})
            inspected = [container(cwd=str(workspace))]
            report = sync.sync_once(registry_path=registry_path, home=home, socket_path="unused", inspect=lambda: inspected,
                                    rpc_factory=lambda _: rpc, trusted_uid=os.geteuid(), proc_root=base / "missing-proc")
            self.assertEqual(report["routes"], 1)
            self.assertEqual(report["assigned_threads"], 1)
            self.assertTrue(rpc.closed)
            self.assertEqual(raw_history.read_bytes(), b"private bytes must remain untouched\n")
            saved = sync.load_registry(registry_path, required_uid=os.geteuid())
            self.assertEqual(saved["routes"][0]["thread_ids"], [ROOT])
            self.assertEqual(saved["routes"][0]["container"], "dev-apps-example")
            inspected.append(container("dev-apps-new", str(base / "new-workspace")))

            def unavailable(_):
                raise OSError("isolated app server unavailable")

            with self.assertRaisesRegex(OSError, "isolated app server unavailable"):
                sync.sync_once(registry_path=registry_path, home=home, socket_path="unused", inspect=lambda: inspected,
                               rpc_factory=unavailable, trusted_uid=os.geteuid(), proc_root=base / "missing-proc")
            recovered = sync.load_registry(registry_path, required_uid=os.geteuid())
            self.assertEqual({item["container"] for item in recovered["routes"]}, {"dev-apps-example", "dev-apps-new"})
            self.assertEqual(recovered["routes"][0]["thread_ids"], [ROOT])


if __name__ == "__main__":
    unittest.main()
