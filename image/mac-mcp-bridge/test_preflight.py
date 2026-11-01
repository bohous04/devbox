import asyncio, unittest
from preflight import Preflight

class Reg:
    def __init__(self, preflight):
        self.preflight = preflight
        self.label = 'Xcode'

class PreflightRuns(unittest.TestCase):
    def test_runs_commands_once_even_when_called_twice(self):
        marker = ['/bin/sh', '-c', 'echo tick >> /tmp/preflight-test-marker']
        import pathlib
        pathlib.Path('/tmp/preflight-test-marker').unlink(missing_ok=True)
        p = Preflight(Reg([marker]))
        asyncio.run(self._twice(p))
        self.assertEqual(pathlib.Path('/tmp/preflight-test-marker').read_text().count('tick'), 1)

    async def _twice(self, p):
        await p.ensure()
        await p.ensure()

    def test_empty_preflight_is_a_noop(self):
        asyncio.run(Preflight(Reg([])).ensure())

    def test_failing_command_raises_with_stderr(self):
        p = Preflight(Reg([['/bin/sh', '-c', 'echo rozbito >&2; exit 3']]))
        with self.assertRaises(RuntimeError) as ctx:
            asyncio.run(p.ensure())
        self.assertIn('rozbito', str(ctx.exception))

    def test_missing_binary_raises_runtime_error_naming_the_command(self):
        # A missing binary (the image was not rebuilt with mac-sync) is an OSError from
        # create_subprocess_exec, not a return code — it must be wrapped in a
        # RuntimeError with the command name, otherwise dispatch() reports a mac outage
        # that has nothing to do with it.
        p = Preflight(Reg([['/no/such/mac-sync-binary']]))
        with self.assertRaises(RuntimeError) as ctx:
            asyncio.run(p.ensure())
        self.assertIn('/no/such/mac-sync-binary', str(ctx.exception))

    def test_failure_is_not_cached_so_retry_can_succeed(self):
        reg = Reg([['/bin/sh', '-c', 'exit 3']])
        p = Preflight(reg)
        with self.assertRaises(RuntimeError):
            asyncio.run(p.ensure())
        reg.preflight = [['/bin/sh', '-c', 'exit 0']]
        asyncio.run(p.ensure())   # must work again after the fix

    def test_cancelled_task_does_not_replay_failure(self):
        # Cancelling ensure() mid-run must not replay the old error.
        # If the task is cancelled, the next ensure() must run the command again.
        import pathlib
        marker = pathlib.Path('/tmp/preflight-cancel-test-marker')
        marker.unlink(missing_ok=True)

        # A slow command that fails — gives time to cancel.
        reg = Reg([['/bin/sh', '-c', 'sleep 0.3; echo attempt >> /tmp/preflight-cancel-test-marker; exit 1']])
        p = Preflight(reg)

        asyncio.run(self._test_cancel_then_retry(p, reg, marker))

    async def _test_cancel_then_retry(self, p, reg, marker):
        # Start ensure() and cancel it mid-run.
        # shield() protects the sub-task, so it keeps running even after ensure() is cancelled.
        ensure_task = asyncio.create_task(p.ensure())
        await asyncio.sleep(0.1)  # Wait until the command is running
        ensure_task.cancel()
        try:
            await ensure_task
        except asyncio.CancelledError:
            pass

        # Wait until the underlying task finishes with an error.
        # Without this, ensure() would just attach again to the still-running task.
        await asyncio.sleep(0.3)

        # Fix the command so it succeeds.
        reg.preflight = [['/bin/sh', '-c', 'echo attempt >> /tmp/preflight-cancel-test-marker; exit 0']]
        await p.ensure()   # must run again, not reuse the old error

        # Verify it ran twice (after the cancel and after the fix).
        self.assertEqual(marker.read_text().count('attempt'), 2)

if __name__ == '__main__':
    unittest.main()
