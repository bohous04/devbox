#!/usr/bin/python3
"""Preparing the mac before the first real call (rsync of sources, xcodegen).

Runs only on `tools/call`, not on discovery — otherwise every session start would touch
the mac (and possibly wait for key approval), even if the agent builds nothing.
"""
import asyncio

STDERR_TAIL = 2000


class Preflight:
    def __init__(self, registration):
        self.registration = registration
        self.done = False
        self.running = None

    async def ensure(self):
        if self.done:
            return
        running = self.running
        if running is None or running.done():
            # Do not recycle a finished task: it would carry an old failure even after the cause is removed.
            running = self.running = asyncio.create_task(self.run())
        try:
            # Concurrent calls share one run; cancelling one must not kill it for the others.
            await asyncio.shield(running)
        finally:
            if running.done():
                self.running = None
                # A failure is NOT cached: after a fix (freed space, woken mac)
                # the next call must run again, without restarting the session.
                self.done = not running.cancelled() and running.exception() is None

    async def run(self):
        for cmd in self.registration.preflight:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            except OSError as exc:
                # A missing binary (the image was not rebuilt with mac-sync) would otherwise
                # fail as an OSError and dispatch() would mistakenly report it as a lost
                # connection to the mac — while the mac has nothing to do with it.
                raise RuntimeError(
                    f'{self.registration.label}: mac preparation did not start '
                    f'({cmd[0]}): {exc}') from exc
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                detail = (stderr or b'').decode('utf-8', 'replace')[-STDERR_TAIL:]
                raise RuntimeError(
                    f'{self.registration.label}: mac preparation failed '
                    f'({cmd[0]}, exit {proc.returncode}).\n{detail}')
