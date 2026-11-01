"""Exercise OSC delivery through a private real tmux server and an outer PTY."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
import uuid


HOOK = Path(__file__).resolve().parents[2] / "image/vendor/warp-hooks/warp-hook.sh"


@unittest.skipUnless(shutil.which("tmux"), "requires tmux")
class WarpStatusPtyTests(unittest.TestCase):
    def test_codex_working_question_done_survive_real_tmux_passthrough(self):
        name = "warp-status-test-" + uuid.uuid4().hex
        env = {**os.environ, "TERM": "xterm-256color"}
        env.pop("TMUX", None)
        env.pop("TMUX_PANE", None)
        client_pid = None
        master = None
        command = ["tmux", "-L", name]

        def tmux(*args):
            return subprocess.check_output(command + list(args), env=env, timeout=5, text=True).strip()

        try:
            tmux("-f", "/dev/null", "new-session", "-d", "-s", "qa", "-x", "100", "-y", "30", "sleep", "120")
            tmux("set-option", "-g", "allow-passthrough", "on")
            socket = tmux("display-message", "-p", "#{socket_path}")
            server = tmux("display-message", "-p", "#{pid}")
            pane = tmux("display-message", "-p", "#{pane_id}")
            client_pid, master = pty.fork()
            if client_pid == 0:
                os.execvpe("tmux", command + ["attach-session", "-t", "qa"], env)

            def read_until(predicate, seconds=3):
                deadline = time.monotonic() + seconds
                while time.monotonic() < deadline:
                    if select.select([master], [], [], 0.1)[0]:
                        captured.extend(os.read(master, 65536))
                    if predicate():
                        return
                self.fail("Expected tmux output did not arrive")

            captured = bytearray()
            read_until(lambda: bool(captured))
            with tempfile.TemporaryDirectory(prefix="warp-status-state-") as directory:
                if not shutil.which("timeout"):
                    shim = Path(directory) / "timeout"
                    shim.write_text("#!/usr/bin/env python3\nimport subprocess,sys\ntry:\n sys.exit(subprocess.run(sys.argv[2:],timeout=float(sys.argv[1].removesuffix('s'))).returncode)\nexcept subprocess.TimeoutExpired:\n sys.exit(124)\n")
                    shim.chmod(0o755)
                hook_env = {**env, "PATH": directory + os.pathsep + env["PATH"], "TMUX": f"{socket},{server},0", "TMUX_PANE": pane,
                            "DEVD_WARP_AGENT": "codex", "CODEX_HOME": directory, "GROK_HOME": directory}
                hook_env.pop("WARP_CLIENT_VERSION", None)
                hook_env.pop("WARP_CLI_AGENT_PROTOCOL_VERSION", None)

                def events():
                    return [json.loads(value) for value in re.findall(rb"\x1b\]777;notify;warp://cli-agent;([^\x07]+)\x07", captured)]

                def emit(event, extra=None, expected=None):
                    before = len(events())
                    base = {"sessionId": "grok-parent"} if hook_env["DEVD_WARP_AGENT"] == "grok" else {"session_id": "parent"}
                    payload = {**base, "cwd": directory, **(extra or {})}
                    result = subprocess.run(["bash", str(HOOK), "--tty", event], env=hook_env,
                                            input=json.dumps(payload), capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")
                    self.assertEqual(result.stderr, "")
                    if expected:
                        read_until(lambda: len(events()) > before)
                        self.assertEqual(events()[-1]["event"], expected)

                emit("session_start", expected="session_start")
                emit("prompt_submit", expected="prompt_submit")
                emit("pre_tool_use", {"tool_name": "functions.request_user_input"}, "permission_request")
                emit("tool_complete", {"tool_name": "exec_command"})
                emit("prompt_submit", {"session_id": "child", "agent_id": "child"})
                emit("tool_complete", {"tool_name": "functions.request_user_input"}, "tool_complete")
                emit("stop", expected="stop")
                emit("tool_complete", {"tool_name": "exec_command"})
                emit("stop", {"session_id": "previous"})
                # A fresh foreground prompt is the barrier after all silent events.
                emit("prompt_submit", expected="prompt_submit")
                actual = events()
                self.assertEqual([item["event"] for item in actual], ["session_start", "prompt_submit", "permission_request", "tool_complete", "stop", "prompt_submit"])
                self.assertTrue(all(item["agent"] == "codex" and item["session_id"] == "parent" for item in actual))
                # Queued post-tool hooks must not resurrect a completed turn.
                emit("stop", expected="stop")
                with ThreadPoolExecutor(max_workers=6) as pool:
                    list(pool.map(lambda _: emit("tool_complete", {"tool_name": "exec_command"}), range(6)))
                emit("prompt_submit", expected="prompt_submit")
                self.assertEqual([e["event"] for e in events()][-3:], ["prompt_submit", "stop", "prompt_submit"])

                # Async questions must stay visible after their immediate return.
                emit("pre_tool_use", {"tool_name": "functions.request_user_input_async"}, "permission_request")
                emit("tool_complete", {"tool_name": "functions.request_user_input_async"})
                emit("tool_complete", {"tool_name": "exec_command"})
                emit("stop")
                state = json.loads(tmux("show-options", "-pqv", "-t", pane, "@devd_warp_state"))
                self.assertEqual(state["event"], "permission_request")
                emit("prompt_submit", expected="prompt_submit")
                self.assertEqual([e["event"] for e in events()][-2:], ["permission_request", "prompt_submit"])

                # Grok uses camelCase payloads and its own logical foreground owner.
                # A newly attached Warp negotiates native support without
                # restarting the existing agent or changing its environment.
                hook_env.update(DEVD_WARP_AGENT="grok", DEVD_WARP_GROK_NATIVE="0")
                tmux("set-option", "-t", "qa", "@devd_warp_grok_native", "1")
                emit("session_start", expected="session_start")
                emit("prompt_submit", {"promptId": "grok-turn"}, "prompt_submit")
                emit("pre_tool_use", {"toolName": "GrokBuild:ask_user_question", "toolUseId": "q"}, "permission_request")
                emit("tool_complete", {"toolName": "Bash", "toolUseId": "other"})
                emit("tool_complete", {"toolName": "ask_user_question", "toolUseId": "q"}, "tool_complete")
                emit("stop_failure", {"promptId": "grok-turn", "error": "rate_limit"}, "stop_failure")
                self.assertEqual([e["event"] for e in events()][-5:], ["session_start", "prompt_submit", "permission_request", "tool_complete", "stop_failure"])
                self.assertTrue(all(e["agent"] == "grok" for e in events()[-5:]))
                # Reconnecting from an older client overrides inherited env too.
                hook_env["DEVD_WARP_GROK_NATIVE"] = "1"
                tmux("set-option", "-t", "qa", "@devd_warp_grok_native", "0")
                emit("prompt_submit", expected="prompt_submit")
                self.assertEqual(events()[-1]["agent"], "claude")
                state = json.loads(tmux("show-options", "-pqv", "-t", pane, "@devd_warp_state"))
                self.assertEqual(state["agent"], "grok")

        finally:
            subprocess.run(command + ["kill-server"], env=env, capture_output=True, timeout=5)
            if client_pid:
                try:
                    os.kill(client_pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                os.waitpid(client_pid, 0)
            if master is not None:
                os.close(master)


if __name__ == "__main__":
    unittest.main()
