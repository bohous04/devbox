"""Behavioral checks for the container updater; no network or root installs.

Run with: python3 -m unittest discover -s devd/test -p 'agentAutoUpdate_test.py'
"""
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest import mock


HELPER = Path(__file__).resolve().parents[2] / "image" / "agent-auto-update"
LOADER = importlib.machinery.SourceFileLoader("agent_auto_update_test_target", str(HELPER))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
updater_module = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(updater_module)


def write_binary(path, tool, release):
    path.parent.mkdir(parents=True, exist_ok=True)
    label = "codex-cli" if tool == "codex" else "grok"
    path.write_text(f"#!/bin/sh\nprintf '%s\\n' '{label} {release}'\n")
    path.chmod(0o755)
    return path


def launch(binary):
    return subprocess.run(
        [str(binary), "--version"], check=True, capture_output=True, text=True
    ).stdout.strip()


class AgentAutoUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        self.root = self.directory / "container-state"
        self.bin_dir = self.directory / "bin"
        self.bin_dir.mkdir()
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(updater_module, "ROOT", self.root).start()
        mock.patch.object(updater_module, "BIN_DIR", self.bin_dir).start()
        mock.patch.object(updater_module, "print", create=True).start()

    def install_old(self, tool, release="1.0.0"):
        binary = write_binary(self.directory / "original" / tool, tool, release)
        (self.bin_dir / tool).symlink_to(binary)
        return binary

    def make_updater(self, latest="1.1.0"):
        updater = updater_module.Updater()

        def run(argv, limit=updater_module.TIME_BUDGET):
            self.assertEqual(argv[1:], ["--version"])
            self.assertIn(argv[0], ("codex", "grok"))
            return launch(self.bin_dir / argv[0])

        def stage(tool, release, directory):
            relative = Path("bin/codex") if tool == "codex" else Path("grok")
            return write_binary(directory / relative, tool, release)

        def verify(tool, binary, expected):
            actual = updater_module.binary_version(tool, launch(binary))
            if actual != expected:
                raise RuntimeError("candidate version mismatch")

        updater.run = mock.Mock(side_effect=run)
        updater.latest = mock.Mock(return_value=latest)
        updater.stage = mock.Mock(side_effect=stage)
        updater.verify = mock.Mock(side_effect=verify)
        return updater

    def test_success_verifies_then_atomically_switches_the_launched_binary(self):
        for tool in ("codex", "grok"):
            with self.subTest(tool=tool):
                original = self.install_old(tool)
                updater = self.make_updater()
                replace = os.replace
                switches = []

                def atomic_replace(source, destination):
                    self.assertEqual(destination, self.bin_dir / tool)
                    self.assertEqual(destination.resolve(), original)
                    self.assertEqual(launch(destination), launch(original))
                    updater.verify.assert_called_once()
                    self.assertTrue(source.is_symlink())
                    self.assertEqual(source.resolve(), updater.verify.call_args.args[1])
                    switches.append((source, destination))
                    replace(source, destination)

                with mock.patch.object(updater_module.os, "replace", side_effect=atomic_replace):
                    updater.update(tool)

                label = "codex-cli" if tool == "codex" else "grok"
                self.assertEqual(launch(self.bin_dir / tool), f"{label} 1.1.0")
                self.assertEqual(launch(original), f"{label} 1.0.0")
                self.assertTrue((self.root / f"{tool}.checked").exists())
                self.assertEqual(len(switches), 1)
                self.assertFalse(switches[0][0].exists())
                self.assertEqual(updater.stage.call_count, 1)

    def test_equal_or_newer_installed_version_is_never_downgraded(self):
        for tool, current, latest in (
            ("codex", "1.1.0", "1.1.0"),
            ("grok", "1.10.0", "1.9.9"),
        ):
            with self.subTest(tool=tool):
                original = self.install_old(tool, current)
                updater = self.make_updater(latest)
                updater.update(tool)
                self.assertEqual((self.bin_dir / tool).resolve(), original)
                updater.stage.assert_not_called()
                updater.verify.assert_not_called()
                self.assertTrue((self.root / f"{tool}.checked").exists())

    def test_successful_check_is_cached_until_interval_expires(self):
        self.install_old("codex")
        updater = self.make_updater("1.0.0")
        updater.update("codex")
        updater.update("codex")
        updater.run.assert_called_once()
        updater.latest.assert_called_once_with("codex")

        stamp = self.root / "codex.checked"
        expired = time.time() - updater_module.INTERVAL - 1
        os.utime(stamp, (expired, expired))
        updater.update("codex")
        self.assertEqual(updater.latest.call_count, 2)

    def test_failed_download_or_verification_preserves_binary_and_retries(self):
        for tool, failing_method in (("codex", "stage"), ("grok", "verify")):
            with self.subTest(tool=tool, failing_method=failing_method):
                original = self.install_old(tool)
                updater = self.make_updater()
                method = getattr(updater, failing_method)
                successful_operation = method.side_effect
                method.side_effect = RuntimeError("simulated update failure")

                with self.assertRaisesRegex(RuntimeError, "simulated update failure"):
                    updater.update(tool)

                self.assertEqual((self.bin_dir / tool).resolve(), original)
                self.assertEqual(launch(self.bin_dir / tool), launch(original))
                self.assertFalse((self.root / f"{tool}.checked").exists())
                self.assertEqual(list(self.root.glob(f"{tool}-*")), [])
                self.assertEqual(list(self.bin_dir.glob(f".{tool}-update-*")), [])

                method.side_effect = successful_operation
                updater.update(tool)
                self.assertEqual(updater.latest.call_count, 2)
                self.assertTrue((self.root / f"{tool}.checked").exists())
                self.assertNotEqual((self.bin_dir / tool).resolve(), original)

    def test_failed_atomic_publication_keeps_original_and_removes_candidate(self):
        original = self.install_old("codex")
        updater = self.make_updater()
        with mock.patch.object(updater_module.os, "replace", side_effect=OSError("read only")):
            with self.assertRaisesRegex(OSError, "read only"):
                updater.update("codex")
        self.assertEqual((self.bin_dir / "codex").resolve(), original)
        self.assertFalse((self.root / "codex.checked").exists())
        self.assertEqual(list(self.root.glob("codex-*")), [])
        self.assertEqual(list(self.bin_dir.glob(".codex-update-*")), [])

    def test_interrupt_after_atomic_rename_preserves_the_active_candidate(self):
        for tool in ("codex", "grok"):
            with self.subTest(tool=tool):
                original = self.install_old(tool)
                updater = self.make_updater()
                replace = os.replace

                def interrupt_after_replace(source, destination):
                    replace(source, destination)
                    raise TimeoutError("interrupted after successful rename")

                with mock.patch.object(updater_module.os, "replace", side_effect=interrupt_after_replace):
                    with self.assertRaisesRegex(TimeoutError, "after successful rename"):
                        updater.update(tool)

                active_binary = (self.bin_dir / tool).resolve()
                candidate = updater.verify.call_args.args[1]
                self.assertEqual(active_binary, candidate)
                self.assertTrue(active_binary.is_file())
                label = "codex-cli" if tool == "codex" else "grok"
                self.assertEqual(launch(self.bin_dir / tool), f"{label} 1.1.0")
                self.assertEqual(launch(original), f"{label} 1.0.0")
                self.assertFalse((self.root / f"{tool}.checked").exists())
                self.assertEqual(list(self.bin_dir.glob(f".{tool}-update-*")), [])

    def test_sigterm_during_staging_cleans_partial_bundle_and_keeps_original(self):
        original = self.install_old("codex")
        sentinel = self.directory / "staging-started"
        child_program = textwrap.dedent("""\
            import importlib.machinery
            import importlib.util
            from pathlib import Path
            import sys
            import time

            helper, root, bin_dir, sentinel = sys.argv[1:]
            loader = importlib.machinery.SourceFileLoader("interrupted_updater", helper)
            spec = importlib.util.spec_from_loader(loader.name, loader)
            module = importlib.util.module_from_spec(spec)
            loader.exec_module(module)
            module.ROOT = Path(root)
            module.BIN_DIR = Path(bin_dir)
            module.os.geteuid = lambda: 0
            module.Updater.run = lambda self, argv, limit=45: "codex-cli 1.0.0"
            module.Updater.latest = lambda self, tool: "1.1.0"

            def interrupted_stage(self, tool, latest, directory):
                (directory / "partial-download").write_bytes(b"incomplete archive")
                Path(sentinel).touch()
                time.sleep(30)
                raise RuntimeError("test never sent SIGTERM")

            module.Updater.stage = interrupted_stage
            sys.argv = [helper, "codex"]
            sys.exit(module.main())
            """)
        child = subprocess.Popen(
            [sys.executable, "-c", child_program, str(HELPER), str(self.root),
             str(self.bin_dir), str(sentinel)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            deadline = time.monotonic() + 5
            while not sentinel.exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(sentinel.exists(), "child did not enter staging")
            self.assertEqual(len(list(self.root.glob("codex-*/partial-download"))), 1)
            child.terminate()
            stdout, stderr = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 1, (stdout, stderr))
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=5)

        self.assertEqual((self.bin_dir / "codex").resolve(), original)
        self.assertEqual(launch(self.bin_dir / "codex"), "codex-cli 1.0.0")
        self.assertFalse((self.root / "codex.checked").exists())
        self.assertEqual(list(self.root.glob("codex-*")), [])
        self.assertEqual(list(self.bin_dir.glob(".codex-update-*")), [])

    def test_subprocess_timeout_and_expired_overall_budget_stop_work(self):
        updater = updater_module.Updater()
        with self.assertRaises(subprocess.TimeoutExpired):
            updater.run([sys.executable, "-c", "import time; time.sleep(30)"], limit=0.05)

        updater.deadline = time.monotonic() - 1
        with mock.patch.object(updater_module.subprocess, "run") as run:
            with self.assertRaises(TimeoutError):
                updater.run([sys.executable, "-c", "raise AssertionError('must not run')"])
        run.assert_not_called()

    def test_per_tool_lock_skips_duplicate_update_without_blocking_other_tool(self):
        self.install_old("codex")
        self.install_old("grok")
        active = self.make_updater()
        duplicate = self.make_updater()
        other_tool = self.make_updater()
        staging_started = threading.Event()
        release_stage = threading.Event()
        errors = []
        stage = active.stage.side_effect

        def paused_stage(*args):
            staging_started.set()
            if not release_stage.wait(5):
                raise TimeoutError("test did not release staging")
            return stage(*args)

        def update_in_thread():
            try:
                active.update("codex")
            except BaseException as error:
                errors.append(error)

        active.stage.side_effect = paused_stage
        thread = threading.Thread(target=update_in_thread, daemon=True)
        thread.start()
        try:
            self.assertTrue(staging_started.wait(5))
            duplicate.update("codex")
            duplicate.run.assert_not_called()
            duplicate.latest.assert_not_called()
            duplicate.stage.assert_not_called()
            other_tool.update("grok")
            self.assertEqual(launch(self.bin_dir / "grok"), "grok 1.1.0")
        finally:
            release_stage.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(active.stage.call_count, 1)
        self.assertEqual(launch(self.bin_dir / "codex"), "codex-cli 1.1.0")

    def test_success_cache_is_local_to_each_container_root(self):
        self.install_old("codex")
        first = self.make_updater("1.0.0")
        first.update("codex")
        second_root = self.directory / "second-container-state"
        second = self.make_updater("1.0.0")
        with mock.patch.object(updater_module, "ROOT", second_root):
            second.update("codex")
        first.latest.assert_called_once_with("codex")
        second.latest.assert_called_once_with("codex")
        self.assertTrue((self.root / "codex.checked").exists())
        self.assertTrue((second_root / "codex.checked").exists())

    def test_unprivileged_entrypoint_delegates_only_to_noninteractive_helper(self):
        class ExecCalled(Exception):
            pass

        with mock.patch.object(updater_module.sys, "argv", [str(HELPER), "grok"]), \
             mock.patch.object(updater_module.os, "geteuid", return_value=1000), \
             mock.patch.object(updater_module.os, "execv", side_effect=ExecCalled) as execute, \
             mock.patch.object(updater_module, "Updater") as updater:
            with self.assertRaises(ExecCalled):
                updater_module.main()
        execute.assert_called_once_with(
            "/usr/bin/sudo", ["sudo", "-n", "--", str(HELPER.resolve()), "grok"]
        )
        updater.assert_not_called()

    def test_root_entrypoint_runs_update_directly_and_reports_failure(self):
        with mock.patch.object(updater_module.sys, "argv", [str(HELPER), "codex"]), \
             mock.patch.object(updater_module.os, "geteuid", return_value=0), \
             mock.patch.object(updater_module.os, "execv") as execute, \
             mock.patch.object(updater_module, "Updater") as updater:
            self.assertEqual(updater_module.main(), 0)
            updater.return_value.update.assert_called_once_with("codex")
            execute.assert_not_called()
            updater.return_value.update.side_effect = RuntimeError("offline")
            self.assertEqual(updater_module.main(), 1)


if __name__ == "__main__":
    unittest.main()
