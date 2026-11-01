#!/usr/bin/env python3
"""Route native Codex exec-server and hook processes into a verified devbox."""

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class DispatchError(Exception):
    pass


@dataclass(frozen=True)
class Route:
    cwd: str
    environment_id: str
    container: str


def normalized_directory(value):
    return (isinstance(value, str) and value.startswith("/") and not value.startswith("//") and value != "/"
            and "\0" not in value and os.path.normpath(value) == value)


def read_routes(path):
    if not path or not Path(path).is_absolute():
        raise DispatchError("DEVD_CODEX_ROUTES_FILE must identify an absolute registry path")
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        raise DispatchError(f"Cannot read the configured devbox registry: {error}") from None
    if not isinstance(data, dict) or not isinstance(data.get("routes"), list):
        raise DispatchError("Devbox registry must contain a routes array")
    routes, ids, roots = [], set(), set()
    for item in data["routes"]:
        if not isinstance(item, dict):
            raise DispatchError("Invalid devbox route")
        cwd, identity, container = (item.get(key) for key in ("cwd", "environment_id", "container"))
        if (not normalized_directory(cwd) or not isinstance(identity, str) or not identity
                or "\0" in identity or not isinstance(container, str)
                or not re.fullmatch(r"dev-[A-Za-z0-9_.-]+", container)):
            raise DispatchError("Route requires a normalized absolute cwd, environment_id, and safe dev-* container")
        if identity in ids or cwd in roots:
            raise DispatchError("Devbox registry contains duplicate environment IDs or working directories")
        ids.add(identity)
        roots.add(cwd)
        routes.append(Route(cwd, identity, container))
    return routes


def select_route(routes, identity=None, cwd=None):
    if identity is not None:
        matches = [route for route in routes if route.environment_id == identity]
    else:
        if not normalized_directory(cwd):
            raise DispatchError("Hook cwd must be an absolute normalized non-root directory")
        matches = [route for route in routes if cwd == route.cwd or cwd.startswith(route.cwd + "/")]
        matches.sort(key=lambda route: len(route.cwd), reverse=True)
    if not matches:
        raise DispatchError("No registered devbox matches this request; refusing host execution")
    return matches[0]


def configured_devd_url(registry_path):
    configured = os.environ.get("DEVD_CODEX_DEVD_URL")
    if configured is None:
        configured = json.loads(Path(registry_path).read_text()).get("devd_url")
    if configured is None or configured == "":
        return None
    if not isinstance(configured, str) or configured.rstrip("/") != "http://127.0.0.1:4300":
        raise DispatchError("Devd lifecycle URL must be http://127.0.0.1:4300")
    return "http://127.0.0.1:4300"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def devd_lifecycle(route, url, action, *, timeout=15, check_cwd=False):
    if url is None:
        return
    request = Request(url + "/api/sessions/" + quote(route.container, safe="") + "/" + action,
                      data=b"", method="POST")
    try:
        with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=timeout) as response:
            raw = response.read(65537)
            if len(raw) > 65536:
                raise DispatchError("Devd returned an oversized lifecycle response")
            result = json.loads(raw)
    except HTTPError as error:
        raise DispatchError(f"Devd rejected {action} for {route.container} (HTTP {error.code}); inspect the devd service") from None
    except (URLError, OSError, ValueError):
        raise DispatchError("Devd lifecycle confirmation failed; inspect the devd service") from None
    session = result.get("session") if isinstance(result, dict) else None
    if not isinstance(session, dict) or session.get("id") != route.container or session.get("status") != "running":
        raise DispatchError("Devd did not confirm the expected running session")
    if check_cwd and result.get("cwd") != route.cwd:
        raise DispatchError("Devd restored a different workspace; refusing execution")


def resume_managed_session(route, url):
    # Only --prepare calls this. Devd owns exact-ID recreation, repository and
    # lifecycle locks, credentials and sidecars; history listing never gets here.
    devd_lifecycle(route, url, "resume-remote", timeout=90, check_cwd=True)


def mark_externally_started(route, url):
    devd_lifecycle(route, url, "externally-started")


@contextmanager
def route_lock(route, runtime_dir):
    root = Path(runtime_dir)
    if not root.is_absolute():
        raise DispatchError("DEVD_CODEX_RUNTIME_DIR must be absolute")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise DispatchError("Runtime directory must be an owned real directory")
    root.chmod(0o700)
    key = hashlib.sha256(route.container.encode()).hexdigest()[:24]
    descriptor = os.open(root / (key + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
            raise DispatchError("Invalid devbox lifecycle lock")
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


ALIAS_PROBE = r"""
import json, os, re, sys
from pathlib import Path
target=Path(sys.argv[1])
conflict=None
for part in [*reversed(target.parents), target]:
    if part.is_symlink():
        conflict='symlink in alias path'; break
    if part.exists() and not part.is_dir():
        conflict='non-directory in alias path'; break
exists=target.exists()
same=False
mounted=False
empty=False
if exists and not conflict:
    source=os.stat('/workspace'); actual=target.stat()
    same=(source.st_dev,source.st_ino)==(actual.st_dev,actual.st_ino)
    empty=next(target.iterdir(),None) is None
    def unescape(value):
        return re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),value)
    mounted=any(unescape(line.split()[4])==str(target) for line in Path('/proc/self/mountinfo').read_text().splitlines())
print(json.dumps({'exists':exists,'same_workspace':same,'is_mount':mounted,'empty':empty,'conflict':conflict}))
"""


class Docker:
    def run(self, args):
        completed = subprocess.run(["docker", *args], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if completed.returncode:
            raise DispatchError(f"Docker operation failed: {completed.stderr.strip()}")
        return completed.stdout

    def inspect(self, name, optional=False):
        completed = subprocess.run(["docker", "inspect", name], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if completed.returncode:
            detail = completed.stderr.lower()
            if "no such object" in detail or "no such container" in detail:
                if optional:
                    return None
                raise DispatchError(f"Devbox {name} was removed; reopen it in VPSbetter first")
            raise DispatchError(f"Cannot inspect devbox {name}: {completed.stderr.strip()}")
        try:
            data = json.loads(completed.stdout)
            if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
                raise ValueError()
            return data[0]
        except ValueError:
            raise DispatchError("Docker returned invalid container metadata") from None

    def alias(self, route):
        result = json.loads(self.run(["exec", "-u", "0", route.container,
                                      "python3", "-c", ALIAS_PROBE, route.cwd]))
        if not isinstance(result, dict):
            raise DispatchError("Invalid devbox bind-alias probe")
        return result

    def pane(self, route):
        try:
            target = self.run(["exec", "-u", "1000:1000", route.container, "tmux",
                               "display-message", "-p", "-t", "main", "#{pane_id}"]).strip()
        except DispatchError:
            return None
        return target if re.fullmatch(r"%[0-9]+", target) else None

    def wait_sidecar(self, name):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                result = subprocess.run(
                    ["docker", "exec", name, "docker", "version", "--format", "{{.Server.Version}}"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, timeout=max(0.001, min(2, deadline - time.monotonic())))
                if result.returncode == 0 and result.stdout.strip():
                    return
            except subprocess.TimeoutExpired:
                pass
            time.sleep(max(0, min(0.5, deadline - time.monotonic())))
        raise DispatchError(f"Docker daemon in {name} was not ready within 20 seconds; inspect or reopen the devbox")


def validate_workspace(route, info):
    mounts = [mount for mount in info.get("Mounts", []) if mount.get("Destination") == "/workspace"]
    if (len(mounts) != 1 or mounts[0].get("Type") != "bind"
            or not normalized_directory(mounts[0].get("Source"))
            or os.path.realpath(mounts[0]["Source"]) != os.path.realpath(route.cwd)):
        raise DispatchError(f"Devbox {route.container} /workspace does not match its registered host directory")


def require_running(route, info):
    state = info.get("State", {})
    if not state.get("Running") or state.get("Paused") or not isinstance(state.get("Pid"), int) or state["Pid"] <= 0:
        raise DispatchError(f"Devbox {route.container} is not running; prepare or reopen it before continuing")


def require_alias(route, alias):
    if alias.get("conflict") or not alias.get("same_workspace") or not alias.get("is_mount"):
        raise DispatchError(f"Devbox {route.container} has no verified canonical bind alias; prepare it first")


def prepare(route, docker, mount_image):
    info = docker.inspect(route.container)
    validate_workspace(route, info)
    sidecar = "dind-" + route.container
    sidecar_info = docker.inspect(sidecar, optional=True)
    if sidecar_info and not sidecar_info.get("State", {}).get("Running"):
        docker.run(["start", sidecar])
    if sidecar_info:
        docker.wait_sidecar(sidecar)
    if not info.get("State", {}).get("Running"):
        docker.run(["start", route.container])
        info = docker.inspect(route.container)
        validate_workspace(route, info)
    require_running(route, info)
    alias = docker.alias(route)
    if not alias.get("conflict") and alias.get("same_workspace") and alias.get("is_mount"):
        return
    if alias.get("conflict") or alias.get("is_mount") or (alias.get("exists") and not alias.get("empty")):
        raise DispatchError(f"Refusing conflicting canonical alias inside {route.container}")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./:@-]*", mount_image):
        raise DispatchError("Invalid DEVD_CODEX_MOUNT_IMAGE")
    docker.run(["exec", "-u", "0", route.container, "mkdir", "-p", "--", route.cwd])
    alias = docker.alias(route)
    if alias.get("conflict") or alias.get("is_mount") or not alias.get("empty"):
        raise DispatchError("Canonical alias changed before bind mount; refusing to overwrite it")
    latest = docker.inspect(route.container)
    validate_workspace(route, latest)
    require_running(route, latest)
    if latest["State"]["Pid"] != info["State"]["Pid"]:
        raise DispatchError("Devbox restarted while preparing its canonical alias; retry preparation")
    docker.run(["run", "--rm", "--privileged", "--pid=host", "--user", "0",
                "--entrypoint", "/usr/bin/nsenter", mount_image, "-t", str(latest["State"]["Pid"]),
                "-m", "-r", "-w", "--", "mount", "--bind", "/workspace", route.cwd])
    require_alias(route, docker.alias(route))


def execution_args(route, docker, cwd, command, timeout_seconds=None):
    info = docker.inspect(route.container)
    validate_workspace(route, info)
    require_running(route, info)
    require_alias(route, docker.alias(route))
    args = ["docker", "exec", "-i", "-u", "1000:1000", "-w", cwd, route.container]
    if timeout_seconds is not None:
        # Native sets this envelope after taking its host environment snapshot;
        # hook.env never controls the dispatcher process or its registry.
        overrides = json.loads(os.environ.get("DEVD_CODEX_HOOK_ENV", "{}"))
        if not isinstance(overrides, dict) or any(
                not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
                or not isinstance(value, str) or "\0" in value
                for key, value in overrides.items()):
            raise DispatchError("Invalid native hook environment envelope")
        if "TMUX_PANE" not in overrides:
            pane = docker.pane(route)
            if pane:
                overrides["TMUX_PANE"] = pane
        args.pop()  # Docker options precede the container name.
        for key, value in sorted(overrides.items()):
            args.extend(["-e", f"{key}={value}"])
        args.append(route.container)
        # GNU timeout interprets zero as unlimited; native zero means immediate.
        duration = f"{timeout_seconds}s" if timeout_seconds else "0.001s"
        args.extend(["timeout", "--kill-after=2s", duration])
    return [*args, *command]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    select = parser.add_mutually_exclusive_group(required=True)
    select.add_argument("--environment-id")
    select.add_argument("--cwd")
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--timeout-seconds", type=int)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if args.prepare and (not args.environment_id or command or args.timeout_seconds is not None):
        parser.error("--prepare requires only --environment-id")
    if args.environment_id and (command or args.timeout_seconds is not None):
        parser.error("exec-server mode does not accept hook arguments")
    if args.cwd and (not command or args.timeout_seconds is None or args.timeout_seconds < 0):
        parser.error("hook mode requires a nonnegative timeout and original command after --")
    registry_path = os.environ.get("DEVD_CODEX_ROUTES_FILE")
    routes = read_routes(registry_path)
    route = select_route(routes, identity=args.environment_id, cwd=args.cwd)
    devd_url = configured_devd_url(registry_path) if args.prepare else None
    docker = Docker()
    with route_lock(route, os.environ.get("DEVD_CODEX_RUNTIME_DIR", "/home/dev/.codex/devbox-runtime")):
        if args.prepare:
            resume_managed_session(route, devd_url)
            prepare(route, docker, os.environ.get("DEVD_CODEX_MOUNT_IMAGE", "devbox:codex-remote-base"))
            mark_externally_started(route, devd_url)
            latest = docker.inspect(route.container)
            validate_workspace(route, latest)
            require_running(route, latest)
            require_alias(route, docker.alias(route))
            return
        command = command if args.cwd else ["/usr/bin/env", "codex", "exec-server", "--listen", "stdio"]
        launch = execution_args(route, docker, args.cwd or route.cwd, command, args.timeout_seconds)
    # Preserve the native byte streams; never inspect or print hook stdin.
    os.execvp(launch[0], launch)


if __name__ == "__main__":
    try:
        main()
    except (DispatchError, OSError, ValueError) as error:
        print(f"codex-devbox-dispatch: {error}", file=sys.stderr)
        sys.exit(1)
