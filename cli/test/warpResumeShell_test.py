import os
import pty
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ZSH = shutil.which("zsh")


# The hook is a zsh script for the mac (default shell); on Linux without zsh (e.g. a GitHub runner) it is skipped.
@unittest.skipUnless(ZSH, "requires zsh")
class WarpResumeShellTest(unittest.TestCase):
    def run_hook(self, term):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = root / "calls"
            mock = root / "dev"
            mock.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$RECOVERY_CALLS"\n')
            mock.chmod(0o700)
            hook = Path(__file__).resolve().parents[2] / "infra/devbox-warp-resume.zsh"
            master, slave = pty.openpty()
            try:
                env = {**os.environ, "TERM_PROGRAM": term, "WARP_TERMINAL_SESSION_UUID": "a" * 32,
                       "WARP_BOOTSTRAPPED": "", "RECOVERY_HOOK": str(hook), "RECOVERY_CALLS": str(calls),
                       "DEVBOX_RECOVERY_BUN": "", "DEVBOX_RECOVERY_CLI": "", "PATH": f"{root}:/usr/bin:/bin"}
                script = '''source "$RECOVERY_HOOK"
source "$RECOVERY_HOOK"
for fn in $precmd_functions; do "$fn"; done
WARP_BOOTSTRAPPED=1
for fn in $precmd_functions; do "$fn"; done
for fn in $precmd_functions; do "$fn"; done
'''
                result = subprocess.run([ZSH, "-f", "-i", "-c", script], env=env,
                                        stdin=slave, stdout=slave, stderr=slave, timeout=5)
                self.assertEqual(result.returncode, 0)
                return calls.read_text().splitlines() if calls.exists() else []
            finally:
                os.close(slave)
                os.close(master)

    def test_restored_tty_resumes_once_after_bootstrap_even_if_sourced_twice(self):
        self.assertEqual(self.run_hook("WarpTerminal"), ["resume --auto"])

    def test_other_terminal_does_not_resume(self):
        self.assertEqual(self.run_hook("OtherTerminal"), [])


if __name__ == "__main__":
    unittest.main()
