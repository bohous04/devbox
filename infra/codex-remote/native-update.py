#!/usr/bin/env python3
"""Keeps the central Codex app-server (/opt/codex-devbox) on the current Codex version.

The app-server is a custom build: upstream tag + `native.patch` (devbox routes, hooks,
resume). The server allows models based on the client version — an outdated app-server therefore
rejects new models ("model is not supported when using Codex with a ChatGPT
account"), even though clients in containers already run the new version.

One run (systemd timer, every hour):
  1. latest version from npm > installed?  no → done
  2. prepare runtime-<version>: upstream tag + native.patch (3-way), build in Docker,
     scoped tests, official npm package (helper, rg, bwrap…) + our bin/codex
  3. switch only in the night window and only when no thread in the app-server is working;
     symlink `runtime` → runtime-<version>, service restart, health check, otherwise rollback

A patch conflict or test failure is reported once, and the same version + patch combination is
not built again — the patch gets fixed (see native-build.md) and the next run tries again.
"""

import argparse
import base64
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

REPO = Path(os.environ.get("DEVD_REPO", "/opt/vps-dev-infra"))
PATCH = REPO / "infra/codex-remote/native.patch"
BUILDER_DOCKERFILE = REPO / "infra/codex-remote/builder.Dockerfile"
RUNTIME_ROOT = Path("/opt/codex-devbox")
STATE = Path("/var/lib/codex-native-update")
SERVICE = "codex-remote-control.service"
SOCKET = Path("/var/lib/docker/volumes/codex-home/_data/app-server-control/app-server-control.sock")
BUILDER_IMAGE = "devbox:codex-unified-builder"
TARGET = "x86_64-unknown-linux-musl"
NPM = "https://registry.npmjs.org/@openai/codex"
DEVD_NOTIFY = os.environ.get("DEVD_URL", "http://127.0.0.1:4300") + "/api/notify"
WINDOW = (2, 6)   # local time, upper bound exclusive — switch only at night
BUILD_MEMORY = "20g"   # on 30 Sep 2026 the server went OOM; the build is kept under a cap
BUILD_TIMEOUT = 90 * 60
HEALTH_TIMEOUT = 90

# Tests the patch adds or changes. Upstream tests are not run — they already passed
# in upstream CI and compiling them would needlessly double the build.
SCOPED_TESTS = [
    ["-p", "codex-core", "--lib", "--", "devbox_routes::", "environment_selection::"],
    ["-p", "codex-hooks", "--lib", "--", "command_runner"],
    ["-p", "codex-exec-server", "--test", "devbox_stdio_reconnect"],
    ["-p", "codex-app-server", "--lib", "--", "persisted_resume_settings", "thread_processor"],
    ["-p", "codex-app-server", "--test", "all", "--", "suite::v2::devbox_routes::"],
]


# ── Pure decision logic (no I/O, tested by test_native_update.py) ───────────────

def parse_version(value):
    parts = value.strip().split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise ValueError(f"invalid version: {value!r}")
    return tuple(int(p) for p in parts)


def is_newer(candidate, current):
    return parse_version(candidate) > parse_version(current)


def in_window(hour, window=WINDOW):
    start, end = window
    return start <= hour < end if start <= end else hour >= start or hour < end


def patch_base(patch_text):
    """Tag the patch applies to — from the `# base: rust-vX.Y.Z` header before the first diff."""
    for line in patch_text.splitlines():
        if line.startswith("diff --git"):
            break
        if line.startswith("# base:"):
            return line.split(":", 1)[1].strip()
    raise ValueError("native.patch has no `# base: rust-vX.Y.Z` header")


def busy_threads(statuses):
    """Threads the app-server is currently processing. idle/notLoaded/systemError survive a restart."""
    return [thread_id for thread_id, status in statuses if status == "active"]


def blocked_attempt(status, version, patch_hash):
    """This version with this patch already failed once — do not rebuild it every hour."""
    return (status.get("version") == version and status.get("patch") == patch_hash
            and status.get("state") in ("conflict", "build-failed", "tests-failed"))


# ── I/O ─────────────────────────────────────────────────────────────────────────

def log(message):
    print(f"codex-native-update: {message}", flush=True)


def run(argv, *, timeout=600, cwd=None, log_to=None):
    if log_to is None:
        return subprocess.run(argv, cwd=cwd, timeout=timeout, check=True, capture_output=True, text=True).stdout
    with open(log_to, "w") as out:
        subprocess.run(argv, cwd=cwd, timeout=timeout, check=True, stdout=out, stderr=subprocess.STDOUT)
    return ""


def read_status():
    try:
        return json.loads((STATE / "status.json").read_text())
    except (OSError, ValueError):
        return {}


def write_status(**fields):
    status = {**fields, "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds")}
    tmp = STATE / "status.json.tmp"
    tmp.write_text(json.dumps(status, indent=2) + "\n")
    tmp.replace(STATE / "status.json")
    return status


def notify(title, message):
    body = json.dumps({"title": title, "message": message}).encode()
    request = urllib.request.Request(DEVD_NOTIFY, data=body, headers={"content-type": "application/json"})
    with contextlib.suppress(OSError):
        urllib.request.urlopen(request, timeout=5).read()


def report(state, version, patch_hash, message, *, title=None):
    previous = read_status()
    write_status(state=state, version=version, patch=patch_hash, message=message)
    log(message)
    # One notification per state — the hourly timer must not spam the same error.
    if title and (previous.get("state"), previous.get("version")) != (state, version):
        notify(title, message)


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=20) as response:
        return json.loads(response.read())


def installed_version():
    return json.loads((RUNTIME_ROOT / "runtime/codex-package.json").read_text())["version"]


def thread_statuses():
    sys.path.insert(0, str(RUNTIME_ROOT))
    from rpc import Rpc   # /opt/codex-devbox/rpc.py — same client as sync.py
    rpc = Rpc(str(SOCKET))
    try:
        result, cursor = [], None
        while True:
            page = rpc.call("thread/loaded/list", {"cursor": cursor} if cursor else {})
            for thread_id in page.get("data", []):
                thread = rpc.call("thread/read", {"threadId": thread_id, "includeTurns": False})["thread"]
                result.append((thread_id, thread.get("status", {}).get("type")))
            cursor = page.get("nextCursor")
            if not cursor:
                return result
    finally:
        rpc.close()


def ensure_builder():
    if subprocess.run(["docker", "image", "inspect", BUILDER_IMAGE], capture_output=True).returncode != 0:
        run(["docker", "build", "-t", BUILDER_IMAGE, "-f", str(BUILDER_DOCKERFILE), str(BUILDER_DOCKERFILE.parent)],
            timeout=BUILD_TIMEOUT)


def in_builder(script, work, timeout, log_to):
    """Runs a script in the builder container. The Cargo cache and target dir persist across versions."""
    (STATE / "cargo").mkdir(exist_ok=True)
    (STATE / "target").mkdir(exist_ok=True)
    run(["docker", "run", "--rm", "--memory", BUILD_MEMORY, "--memory-swap", BUILD_MEMORY, "--cpus", "10",
         "-v", f"{work}/src:/build/src", "-v", f"{STATE}/target:/build/target",
         "-v", f"{STATE}/cargo:/usr/local/cargo/registry",
         "-e", "CARGO_TARGET_DIR=/build/target", "-w", "/build/src/codex-rs",
         BUILDER_IMAGE, "bash", "-ec", script], timeout=timeout, log_to=log_to)


def prepare_source(version, patch_text, work):
    src = work / "src"
    shutil.rmtree(src, ignore_errors=True)
    run(["git", "clone", "-q", "--depth", "1", "--branch", f"rust-v{version}",
         "https://github.com/openai/codex.git", str(src)], timeout=900)
    # A 3-way merge needs the blobs of the base version the patch was made against.
    run(["git", "fetch", "-q", "--depth", "1", "origin", "tag", patch_base(patch_text)], cwd=src, timeout=900)
    result = subprocess.run(["git", "apply", "--3way", str(PATCH)], cwd=src, capture_output=True, text=True)
    conflicts = run(["git", "diff", "--name-only", "--diff-filter=U"], cwd=src).split()
    if result.returncode != 0 or conflicts:
        return conflicts or [result.stderr.strip()[-500:]]
    return []


def stage_runtime(version, work):
    """runtime-<version>: official npm package (helper, rg, bwrap…) + our bin/codex."""
    meta = fetch_json(f"{NPM}/{version}-linux-x64")
    tarball = work / "codex-linux-x64.tgz"
    urllib.request.urlretrieve(meta["dist"]["tarball"], tarball)
    algorithm, expected = meta["dist"]["integrity"].split("-", 1)
    digest = base64.b64encode(hashlib.new(algorithm, tarball.read_bytes()).digest()).decode()
    if digest != expected:
        raise RuntimeError("npm package does not match the registry integrity hash")
    staged = RUNTIME_ROOT / f"runtime-{version}.tmp"
    shutil.rmtree(staged, ignore_errors=True)
    prefix = f"package/vendor/{TARGET}/"
    with tarfile.open(tarball) as archive:
        for member in archive.getmembers():
            if member.name.startswith(prefix) and member.name != prefix.rstrip("/"):
                member.name = member.name[len(prefix):]
                archive.extract(member, staged, filter="data")
    package = json.loads((staged / "codex-package.json").read_text())
    if package["version"] != version:
        raise RuntimeError(f"npm package reports version {package['version']}, expected {version}")
    (staged / "bin/codex").rename(staged / "bin/codex.official")
    shutil.copy2(STATE / "target/dev-small/codex", staged / "bin/codex")
    reported = run([str(staged / "bin/codex"), "--version"]).strip()
    if reported != f"codex-cli {version}":
        raise RuntimeError(f"built binary reports {reported!r}")
    final = RUNTIME_ROOT / f"runtime-{version}"
    shutil.rmtree(final, ignore_errors=True)
    staged.rename(final)
    return final


def build(version, patch_hash, patch_text):
    work = STATE / "work"
    work.mkdir(parents=True, exist_ok=True)
    conflicts = prepare_source(version, patch_text, work)
    if conflicts:
        report("conflict", version, patch_hash,
               f"native.patch does not apply cleanly to {version}: {', '.join(conflicts)}. "
               "Resolve the conflicts as described in infra/codex-remote/native-build.md.",
               title="Codex app-server: patch needs manual fixing")
        return None
    ensure_builder()
    try:
        in_builder("cargo build --profile dev-small -p codex-cli --bin codex -j 10",
                   work, BUILD_TIMEOUT, STATE / "build.log")
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        report("build-failed", version, patch_hash,
               f"Building Codex {version} with native.patch failed, log: {STATE}/build.log",
               title="Codex app-server: build failed")
        return None
    script = "\n".join(f"cargo test --profile dev-small -j 10 {' '.join(args)}" for args in SCOPED_TESTS)
    try:
        in_builder(script, work, BUILD_TIMEOUT, STATE / "test.log")
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        report("tests-failed", version, patch_hash,
               f"Devbox patch tests failed on Codex {version}, log: {STATE}/test.log",
               title="Codex app-server: tests failed")
        return None
    return stage_runtime(version, work)


def wait_healthy(version):
    deadline = time.monotonic() + HEALTH_TIMEOUT
    while time.monotonic() < deadline:
        time.sleep(3)
        with contextlib.suppress(Exception):
            if subprocess.run(["systemctl", "is-active", "--quiet", SERVICE]).returncode == 0:
                thread_statuses()   # initialize + reading threads = the app-server really responds
                return run([str(RUNTIME_ROOT / "codex"), "--version"]).strip() == f"codex-cli {version}"
    return False


def point_runtime(target):
    link = RUNTIME_ROOT / "runtime"
    tmp = RUNTIME_ROOT / "runtime.next"
    with contextlib.suppress(FileNotFoundError):
        tmp.unlink()
    tmp.symlink_to(target.name)
    tmp.replace(link)   # rename is atomic — the service never sees a missing runtime


def switch(version, current, patch_hash):
    link = RUNTIME_ROOT / "runtime"
    if not link.is_symlink():
        # First switch: the existing directory is renamed so a rollback can target it.
        link.rename(RUNTIME_ROOT / f"runtime-{current}")
        link.symlink_to(f"runtime-{current}")
    previous = RUNTIME_ROOT / os.readlink(link)
    point_runtime(RUNTIME_ROOT / f"runtime-{version}")
    run(["systemctl", "restart", SERVICE], timeout=120)
    if wait_healthy(version):
        report("updated", version, patch_hash, f"Codex app-server upgraded from {current} to {version}.",
               title="Codex app-server updated")
        prune(keep={f"runtime-{version}", previous.name})
        return True
    point_runtime(previous)
    run(["systemctl", "restart", SERVICE], timeout=120)
    report("rolled-back", version, patch_hash,
           f"Codex app-server {version} did not respond after restart, rolled back to {current}.",
           title="Codex app-server: rollback")
    return False


def prune(keep):
    for path in RUNTIME_ROOT.glob("runtime-*"):
        if path.is_dir() and not path.is_symlink() and path.name not in keep:
            shutil.rmtree(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--now", action="store_true", help="switch now, do not wait for the night window (the idle check still applies)")
    parser.add_argument("--build-only", action="store_true", help="only prepare the runtime, do not switch")
    parser.add_argument("--version", help="target version instead of npm latest")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("must run as root (it restarts a systemd service)")
    STATE.mkdir(parents=True, exist_ok=True)
    with open(STATE / "lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("another instance is already running")
            return 0
        patch_text = PATCH.read_text()
        patch_hash = hashlib.sha256(patch_text.encode()).hexdigest()[:16]
        current = installed_version()
        latest = args.version or fetch_json(f"{NPM}/latest")["version"]
        parse_version(latest)
        if not is_newer(latest, current):
            write_status(state="current", version=current, patch=patch_hash, message=f"Codex app-server {current} is up to date.")
            return 0
        if blocked_attempt(read_status(), latest, patch_hash):
            log(f"{latest} already failed with this patch, waiting for a patch fix")
            return 0
        staged = RUNTIME_ROOT / f"runtime-{latest}"
        if not (staged / "bin/codex").exists():
            write_status(state="building", version=latest, patch=patch_hash, message=f"Building Codex {latest}.")
            try:
                staged_ok = build(latest, patch_hash, patch_text) is not None
            except Exception as error:   # network, npm, git — transient, the next run tries again
                report("error", latest, patch_hash, f"Preparing Codex {latest} failed: {error}",
                       title="Codex app-server: update failed")
                return 1
            if not staged_ok:
                return 1
            write_status(state="staged", version=latest, patch=patch_hash, message=f"Codex {latest} ready, waiting to switch.")
        if args.build_only:
            return 0
        if not args.now and not in_window(datetime.datetime.now().hour):
            log(f"{latest} ready, will switch in the night window {WINDOW[0]}–{WINDOW[1]} h")
            return 0
        busy = busy_threads(thread_statuses())
        if busy:
            write_status(state="staged", version=latest, patch=patch_hash,
                         message=f"Codex {latest} ready, waiting for {len(busy)} in-progress threads to finish.")
            log(f"{len(busy)} threads are working, will switch next time")
            return 0
        return 0 if switch(latest, current, patch_hash) else 1


if __name__ == "__main__":
    sys.exit(main())
