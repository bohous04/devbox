"""Focused boundary checks for the central Codex devbox dispatcher."""

import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError


SOURCE = Path(__file__).resolve().parents[2] / "infra/codex-remote/dispatch.py"
SPEC = importlib.util.spec_from_file_location("codex_central_dispatch", SOURCE)
dispatch = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = dispatch
SPEC.loader.exec_module(dispatch)
ROUTE = dispatch.Route("/srv/workspaces/a", "environment-a", "dev-fixture-a")


def metadata(running=True, source=ROUTE.cwd, pid=1234):
    return {"State": {"Running": running, "Paused": False, "Pid": pid if running else 0},
            "Mounts": [{"Destination": "/workspace", "Source": source, "Type": "bind"}]}


def alias(exists=True, same=True, mounted=True, empty=False, conflict=None):
    return {"exists": exists, "same_workspace": same, "is_mount": mounted,
            "empty": empty, "conflict": conflict}


class FakeDocker:
    def __init__(self, running=True, sidecar=False, aliases=None):
        self.main = metadata(running)
        self.sidecar = metadata(False) if sidecar else None
        self.aliases = list(aliases or [alias()])
        self.calls = []
        self.inspect_count = 0
        self.restart_on_inspect = None
        self.main_pane = None
        self.sidecar_ready = True

    def inspect(self, name, optional=False):
        self.calls.append(("inspect", name, optional))
        if name.startswith("dind-"):
            return copy.deepcopy(self.sidecar)
        self.inspect_count += 1
        if self.inspect_count == self.restart_on_inspect:
            self.main["State"]["Pid"] += 1
        return copy.deepcopy(self.main)

    def alias(self, route):
        self.calls.append(("alias", route.cwd))
        return self.aliases.pop(0) if len(self.aliases) > 1 else self.aliases[0]

    def run(self, args):
        self.calls.append(("run", args))
        if args[:1] == ["start"]:
            target = self.sidecar if args[1].startswith("dind-") else self.main
            target["State"].update(Running=True, Pid=1234)
        return ""

    def pane(self, route):
        self.calls.append(("pane", route.container))
        return self.main_pane

    def wait_sidecar(self, name):
        self.calls.append(("ready", name))
        if not self.sidecar_ready:
            raise dispatch.DispatchError("Docker daemon was not ready within 20 seconds")

    def mutations(self):
        return [call[1] for call in self.calls if call[0] == "run"]


class RegistryTests(unittest.TestCase):
    def read(self, routes):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "routes.json"
            path.write_text(json.dumps({"routes": routes}))
            return dispatch.read_routes(str(path))

    def test_exact_environment_and_longest_directory_boundary(self):
        nested = dispatch.Route(ROUTE.cwd + "/nested", "nested", "dev-nested")
        routes = [ROUTE, nested]
        self.assertEqual(dispatch.select_route(routes, identity=ROUTE.environment_id), ROUTE)
        self.assertEqual(dispatch.select_route(routes, cwd=nested.cwd + "/child"), nested)
        with self.assertRaisesRegex(dispatch.DispatchError, "refusing host execution"):
            dispatch.select_route(routes, cwd=ROUTE.cwd + "-unrelated")

    def test_registry_rejects_invalid_paths_names_and_duplicates(self):
        valid = dict(cwd=ROUTE.cwd, environment_id=ROUTE.environment_id, container=ROUTE.container)
        for key, value in [("cwd", "/"), ("cwd", "//"), ("cwd", "relative"), ("cwd", "/srv/../etc"),
                           ("cwd", "/srv/x/"), ("container", "production"),
                           ("container", "dev-test;true"), ("environment_id", "")]:
            with self.subTest(key=key, value=value), self.assertRaises(dispatch.DispatchError):
                self.read([{**valid, key: value}])
        with self.assertRaisesRegex(dispatch.DispatchError, "duplicate"):
            self.read([valid, valid])
        self.assertEqual(self.read([{**valid, "thread_ids": ["ignored"]}]), [ROUTE])

    def test_devd_callback_is_opt_in_loopback_only_and_host_env_takes_precedence(self):
        with tempfile.TemporaryDirectory() as temp:
            registry = Path(temp) / "routes.json"
            registry.write_text('{"routes":[]}')
            with patch.dict(os.environ, {}, clear=True):
                self.assertIsNone(dispatch.configured_devd_url(registry))
                registry.write_text('{"routes":[],"devd_url":"http://127.0.0.1:4300"}')
                self.assertEqual(dispatch.configured_devd_url(registry), "http://127.0.0.1:4300")
            with patch.dict(os.environ, {"DEVD_CODEX_DEVD_URL": ""}):
                self.assertIsNone(dispatch.configured_devd_url(registry))
            for invalid in ["http://example.com:4300", "http://127.0.0.1:4300/path", "http://user:password@127.0.0.1:4300"]:
                with self.subTest(invalid=invalid), patch.dict(os.environ, {"DEVD_CODEX_DEVD_URL": invalid}), \
                        self.assertRaisesRegex(dispatch.DispatchError, "lifecycle URL"):
                    dispatch.configured_devd_url(registry)


class LifecycleCallbackTests(unittest.TestCase):
    def test_restore_requests_exact_id_and_requires_expected_canonical_workspace(self):
        body = {"session": {"id": ROUTE.container, "status": "running"}, "cwd": ROUTE.cwd}
        with patch.object(dispatch, "build_opener") as build:
            build.return_value.open.return_value = io.BytesIO(json.dumps(body).encode())
            dispatch.resume_managed_session(ROUTE, "http://127.0.0.1:4300")
        call = build.return_value.open.call_args
        self.assertEqual(call.args[0].full_url,
                         "http://127.0.0.1:4300/api/sessions/" + ROUTE.container + "/resume-remote")
        self.assertEqual(call.args[0].data, b"")
        self.assertEqual(call.kwargs["timeout"], 90)
        for cwd in [None, "/workspace", ROUTE.cwd + "-other"]:
            with self.subTest(cwd=cwd), patch.object(dispatch, "build_opener") as build:
                build.return_value.open.return_value = io.BytesIO(json.dumps({**body, "cwd": cwd}).encode())
                with self.assertRaisesRegex(dispatch.DispatchError, "different workspace"):
                    dispatch.resume_managed_session(ROUTE, "http://127.0.0.1:4300")

    def test_unmanaged_fixture_skips_devd_entirely(self):
        with patch.object(dispatch, "build_opener") as build:
            dispatch.resume_managed_session(ROUTE, None)
        build.assert_not_called()

    def test_callback_confirms_exact_session_and_never_follows_redirects(self):
        response = io.BytesIO(json.dumps({"session": {"id": ROUTE.container, "status": "running"}}).encode())
        with patch.object(dispatch, "build_opener") as build:
            build.return_value.open.return_value = response
            dispatch.mark_externally_started(ROUTE, "http://127.0.0.1:4300")
        request = build.return_value.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:4300/api/sessions/" + ROUTE.container + "/externally-started")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.data, b"")
        self.assertIsNone(dispatch.NoRedirect().redirect_request(None, None, 302, "", {}, "http://example.com"))

    def test_callback_errors_abort_without_logging_response_payload(self):
        with patch.object(dispatch, "build_opener") as build:
            build.return_value.open.side_effect = HTTPError("http://127.0.0.1:4300", 409, "secret fixture body", {}, None)
            with self.assertRaisesRegex(dispatch.DispatchError, "HTTP 409") as error:
                dispatch.mark_externally_started(ROUTE, "http://127.0.0.1:4300")
            self.assertNotIn("secret", str(error.exception))
        for body in [{"session": {"id": "dev-wrong", "status": "running"}},
                     {"session": {"id": ROUTE.container, "status": "stopped"}}]:
            with patch.object(dispatch, "build_opener") as build:
                build.return_value.open.return_value = io.BytesIO(json.dumps(body).encode())
                with self.assertRaisesRegex(dispatch.DispatchError, "did not confirm"):
                    dispatch.mark_externally_started(ROUTE, "http://127.0.0.1:4300")


class DockerBoundaryTests(unittest.TestCase):
    def test_removed_and_inaccessible_containers_are_distinct(self):
        with patch.object(dispatch.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 1, "", "Error: No such object: dev-fixture-a")):
            with self.assertRaisesRegex(dispatch.DispatchError, "removed; reopen"):
                dispatch.Docker().inspect(ROUTE.container)
            self.assertIsNone(dispatch.Docker().inspect("dind-" + ROUTE.container, optional=True))
        with patch.object(dispatch.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 1, "", "permission denied")):
            with self.assertRaisesRegex(dispatch.DispatchError, "Cannot inspect"):
                dispatch.Docker().inspect(ROUTE.container, optional=True)

    def test_preflight_does_not_consume_hook_stdin(self):
        with patch.object(dispatch.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, json.dumps([metadata()]), "")) as run:
            dispatch.Docker().inspect(ROUTE.container)
        self.assertEqual(run.call_args.kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(run.call_args.kwargs["stdout"], subprocess.PIPE)

    def test_exec_preserves_exact_arguments_and_never_starts_stopped_container(self):
        docker = FakeDocker()
        argv = ["/bin/bash", "-lc", "printf '%s' '$HOME `literal`'", "argument with spaces"]
        self.assertEqual(dispatch.execution_args(ROUTE, docker, ROUTE.cwd + "/subdir", argv, 9),
                         ["docker", "exec", "-i", "-u", "1000:1000", "-w", ROUTE.cwd + "/subdir",
                          ROUTE.container, "timeout", "--kill-after=2s", "9s", *argv])
        self.assertEqual(docker.mutations(), [])
        stopped = FakeDocker(running=False)
        with self.assertRaisesRegex(dispatch.DispatchError, "not running"):
            dispatch.execution_args(ROUTE, stopped, ROUTE.cwd, argv, 9)
        self.assertEqual(stopped.mutations(), [])

    def test_zero_timeout_is_not_unlimited_and_missing_alias_fails(self):
        argv = dispatch.execution_args(ROUTE, FakeDocker(), ROUTE.cwd, ["sleep", "99"], 0)
        self.assertIn("0.001s", argv)
        docker = FakeDocker(aliases=[alias(mounted=False)])
        with self.assertRaisesRegex(dispatch.DispatchError, "bind alias"):
            dispatch.execution_args(ROUTE, docker, ROUTE.cwd, ["true"])
        self.assertEqual(docker.mutations(), [])

    def test_only_explicit_hook_overrides_enter_container_and_never_exec_server(self):
        overrides = {"HOOK_VALUE": "literal $HOME `text`", "CUSTOM": "line1\nline2"}
        with patch.dict(os.environ, {"DEVD_CODEX_HOOK_ENV": json.dumps(overrides),
                                     "DO_NOT_FORWARD_HOST_SECRET": "fixture-only"}):
            argv = dispatch.execution_args(ROUTE, FakeDocker(), ROUTE.cwd, ["true"], 9)
            self.assertEqual(argv[7:12], ["-e", "CUSTOM=line1\nline2", "-e",
                                         "HOOK_VALUE=literal $HOME `text`", ROUTE.container])
            self.assertFalse(any("DO_NOT_FORWARD_HOST_SECRET" in value for value in argv))
            server = dispatch.execution_args(ROUTE, FakeDocker(), ROUTE.cwd, ["server"])
            self.assertNotIn("-e", server)
        for envelope in [{"INVALID=KEY": "value"}, {"BAD": 2}, {"BAD": "\0"}, []]:
            with self.subTest(envelope=envelope), \
                    patch.dict(os.environ, {"DEVD_CODEX_HOOK_ENV": json.dumps(envelope)}), \
                    self.assertRaisesRegex(dispatch.DispatchError, "environment envelope"):
                dispatch.execution_args(ROUTE, FakeDocker(), ROUTE.cwd, ["true"], 9)

    def test_hook_uses_container_main_pane_without_replacing_explicit_override(self):
        docker = FakeDocker()
        docker.main_pane = "%12"
        with patch.dict(os.environ, {"DEVD_CODEX_HOOK_ENV": "{}"}):
            argv = dispatch.execution_args(ROUTE, docker, ROUTE.cwd, ["true"], 9)
        self.assertIn("TMUX_PANE=%12", argv)
        with patch.dict(os.environ, {"DEVD_CODEX_HOOK_ENV": '{"TMUX_PANE":"%3"}'}):
            argv = dispatch.execution_args(ROUTE, docker, ROUTE.cwd, ["true"], 9)
        self.assertIn("TMUX_PANE=%3", argv)
        self.assertNotIn("TMUX_PANE=%12", argv)
        docker.main_pane = None
        with patch.dict(os.environ, {"DEVD_CODEX_HOOK_ENV": "{}"}):
            argv = dispatch.execution_args(ROUTE, docker, ROUTE.cwd, ["true"], 9)
        self.assertEqual(argv[-1], "true")
        self.assertFalse(any(value.startswith("TMUX_PANE=") for value in argv))

    def test_pane_lookup_is_optional_and_accepts_only_exact_tmux_ids(self):
        for stdout, expected in [("%12\n", "%12"), ("%1\n%2\n", None), ("main:0", None)]:
            with self.subTest(stdout=stdout), patch.object(dispatch.Docker, "run", return_value=stdout):
                self.assertEqual(dispatch.Docker().pane(ROUTE), expected)
        with patch.object(dispatch.Docker, "run", side_effect=dispatch.DispatchError("no server")):
            self.assertIsNone(dispatch.Docker().pane(ROUTE))

    def test_sidecar_readiness_retries_and_has_a_fixed_deadline(self):
        with patch.object(dispatch.subprocess, "run", side_effect=[
                subprocess.CompletedProcess([], 1, "", "not ready"),
                subprocess.CompletedProcess([], 0, "27.0.0\n", "")]) as run, \
                patch.object(dispatch.time, "sleep"):
            dispatch.Docker().wait_sidecar("dind-" + ROUTE.container)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args.args[0], ["docker", "exec", "dind-" + ROUTE.container,
                                                "docker", "version", "--format", "{{.Server.Version}}"])
        self.assertLessEqual(run.call_args.kwargs["timeout"], 2)
        with patch.object(dispatch.time, "monotonic", side_effect=[0, 20]), \
                self.assertRaisesRegex(dispatch.DispatchError, "not ready within 20 seconds"):
            dispatch.Docker().wait_sidecar("dind-" + ROUTE.container)


class PrepareTests(unittest.TestCase):
    def test_start_sidecar_then_existing_main_and_bind_with_verified_pid(self):
        docker = FakeDocker(running=False, sidecar=True, aliases=[
            alias(exists=False, same=False, mounted=False),
            alias(same=False, mounted=False, empty=True), alias()])
        dispatch.prepare(ROUTE, docker, "devbox:proof")
        self.assertEqual(docker.mutations(), [
            ["start", "dind-" + ROUTE.container], ["start", ROUTE.container],
            ["exec", "-u", "0", ROUTE.container, "mkdir", "-p", "--", ROUTE.cwd],
            ["run", "--rm", "--privileged", "--pid=host", "--user", "0", "--entrypoint",
             "/usr/bin/nsenter", "devbox:proof", "-t", "1234", "-m", "-r", "-w", "--",
             "mount", "--bind", "/workspace", ROUTE.cwd]])

    def test_existing_alias_is_idempotent_and_absent_sidecar_is_allowed(self):
        docker = FakeDocker()
        dispatch.prepare(ROUTE, docker, "devbox:proof")
        self.assertEqual(docker.mutations(), [])

    def test_unready_sidecar_prevents_main_start(self):
        docker = FakeDocker(running=False, sidecar=True)
        docker.sidecar_ready = False
        with self.assertRaisesRegex(dispatch.DispatchError, "not ready"):
            dispatch.prepare(ROUTE, docker, "devbox:proof")
        self.assertEqual(docker.mutations(), [["start", "dind-" + ROUTE.container]])

    def test_wrong_workspace_fails_before_starting_anything(self):
        docker = FakeDocker(running=False, sidecar=True)
        docker.main["Mounts"][0]["Source"] = "/somewhere/else"
        with self.assertRaisesRegex(dispatch.DispatchError, "does not match"):
            dispatch.prepare(ROUTE, docker, "devbox:proof")
        self.assertEqual(docker.mutations(), [])

    def test_conflicting_aliases_are_never_overwritten(self):
        for unsafe in [alias(conflict="symlink in alias path"),
                       alias(same=False, mounted=False, empty=False),
                       alias(same=False, mounted=True, empty=True)]:
            with self.subTest(unsafe=unsafe):
                docker = FakeDocker(aliases=[unsafe])
                with self.assertRaisesRegex(dispatch.DispatchError, "conflicting"):
                    dispatch.prepare(ROUTE, docker, "devbox:proof")
                self.assertEqual(docker.mutations(), [])

    def test_changed_pid_or_alias_aborts_before_privileged_mount(self):
        for changed_alias in [False, True]:
            with self.subTest(changed_alias=changed_alias):
                docker = FakeDocker(aliases=[alias(exists=False, same=False, mounted=False),
                    alias(same=False, mounted=False, empty=True,
                          conflict="symlink in alias path" if changed_alias else None)])
                if not changed_alias:
                    docker.restart_on_inspect = 2
                with self.assertRaisesRegex(dispatch.DispatchError, "changed|restarted"):
                    dispatch.prepare(ROUTE, docker, "devbox:proof")
                self.assertFalse(any(args[0] == "run" for args in docker.mutations()))


class LaunchAndLockTests(unittest.TestCase):
    def test_prepare_recreates_removed_container_before_any_docker_preparation(self):
        with tempfile.TemporaryDirectory() as temp:
            registry = Path(temp) / "routes.json"
            registry.write_text(json.dumps({"routes": [ROUTE.__dict__], "devd_url": "http://127.0.0.1:4300"}))
            env = {"DEVD_CODEX_ROUTES_FILE": str(registry), "DEVD_CODEX_RUNTIME_DIR": temp + "/runtime"}
            docker = FakeDocker()
            docker.main = None
            def restore(route, url):
                self.assertEqual(docker.calls, [])
                self.assertIsNone(docker.main)
                docker.main = metadata()
            with patch.dict(os.environ, env), \
                    patch.object(sys, "argv", [str(SOURCE), "--prepare", "--environment-id", ROUTE.environment_id]), \
                    patch.object(dispatch, "Docker", return_value=docker), \
                    patch.object(dispatch, "resume_managed_session", side_effect=restore) as resume, \
                    patch.object(dispatch, "mark_externally_started") as confirm:
                dispatch.main()
            resume.assert_called_once_with(ROUTE, "http://127.0.0.1:4300")
            confirm.assert_called_once()

    def test_failed_restore_never_runs_docker_or_executes_on_host(self):
        with tempfile.TemporaryDirectory() as temp:
            registry = Path(temp) / "routes.json"
            registry.write_text(json.dumps({"routes": [ROUTE.__dict__], "devd_url": "http://127.0.0.1:4300"}))
            env = {"DEVD_CODEX_ROUTES_FILE": str(registry), "DEVD_CODEX_RUNTIME_DIR": temp + "/runtime"}
            docker = FakeDocker()
            with patch.dict(os.environ, env), \
                    patch.object(sys, "argv", [str(SOURCE), "--prepare", "--environment-id", ROUTE.environment_id]), \
                    patch.object(dispatch, "Docker", return_value=docker), \
                    patch.object(dispatch, "resume_managed_session", side_effect=dispatch.DispatchError("unavailable")), \
                    patch.object(dispatch.os, "execvp") as execute, \
                    self.assertRaisesRegex(dispatch.DispatchError, "unavailable"):
                dispatch.main()
            self.assertEqual(docker.calls, [])
            execute.assert_not_called()

    def test_prepare_aborts_on_callback_failure_or_container_stop_during_confirmation(self):
        with tempfile.TemporaryDirectory() as temp:
            registry = Path(temp) / "routes.json"
            registry.write_text(json.dumps({"routes": [ROUTE.__dict__], "devd_url": "http://127.0.0.1:4300"}))
            env = {"DEVD_CODEX_ROUTES_FILE": str(registry), "DEVD_CODEX_RUNTIME_DIR": temp + "/runtime"}
            for callback_failure in [True, False]:
                docker = FakeDocker()
                def callback(route, url):
                    if callback_failure:
                        raise dispatch.DispatchError("Devd rejected the external start (HTTP 409)")
                    docker.main["State"]["Running"] = False
                with self.subTest(callback_failure=callback_failure), patch.dict(os.environ, env), \
                        patch.object(sys, "argv", [str(SOURCE), "--prepare", "--environment-id", ROUTE.environment_id]), \
                        patch.object(dispatch, "Docker", return_value=docker), \
                        patch.object(dispatch, "resume_managed_session"), \
                        patch.object(dispatch, "mark_externally_started", side_effect=callback) as confirm, \
                        patch.object(dispatch.os, "execvp") as execute, \
                        self.assertRaisesRegex(dispatch.DispatchError, "HTTP 409|not running"):
                    dispatch.main()
                confirm.assert_called_once_with(ROUTE, "http://127.0.0.1:4300")
                execute.assert_not_called()

    def test_main_execs_native_server_with_inherited_stdio_and_prepare_is_quiet(self):
        with tempfile.TemporaryDirectory() as temp:
            registry = Path(temp) / "routes.json"
            registry.write_text(json.dumps({"routes": [ROUTE.__dict__]}))
            env = {"DEVD_CODEX_ROUTES_FILE": str(registry), "DEVD_CODEX_RUNTIME_DIR": temp + "/runtime"}
            for preparing in [False, True]:
                with self.subTest(preparing=preparing), patch.dict(os.environ, env), \
                        patch.object(sys, "argv", [str(SOURCE), "--environment-id", ROUTE.environment_id,
                                                  *(["--prepare"] if preparing else [])]), \
                        patch.object(dispatch, "Docker", return_value=FakeDocker()), \
                        patch.object(dispatch.os, "execvp") as execute, \
                        patch("sys.stdout", new_callable=io.StringIO) as output:
                    dispatch.main()
                    self.assertEqual(output.getvalue(), "")
                    if preparing:
                        execute.assert_not_called()
                    else:
                        execute.assert_called_once_with("docker", ["docker", "exec", "-i", "-u",
                            "1000:1000", "-w", ROUTE.cwd, ROUTE.container, "/usr/bin/env", "codex",
                            "exec-server", "--listen", "stdio"])

    def test_lock_is_exclusive_and_released_after_exception(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, "fixture"):
                with dispatch.route_lock(ROUTE, temp):
                    path = next(Path(temp).glob("*.lock"))
                    probe = subprocess.run([sys.executable, "-c",
                        "import fcntl,sys; f=open(sys.argv[1],'r+'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)",
                        str(path)], capture_output=True)
                    self.assertNotEqual(probe.returncode, 0)
                    raise RuntimeError("fixture")
            with dispatch.route_lock(ROUTE, temp):
                self.assertEqual(Path(temp).stat().st_mode & 0o777, 0o700)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_symlink_runtime_is_rejected_without_changing_target_mode(self):
        with tempfile.TemporaryDirectory() as temp:
            actual = Path(temp) / "actual"
            actual.mkdir(mode=0o755)
            linked = Path(temp) / "linked"
            linked.symlink_to(actual)
            with self.assertRaisesRegex(dispatch.DispatchError, "real directory"):
                with dispatch.route_lock(ROUTE, str(linked)):
                    self.fail("must not enter unsafe lock")
            self.assertEqual(actual.stat().st_mode & 0o777, 0o755)


if __name__ == "__main__":
    unittest.main()
