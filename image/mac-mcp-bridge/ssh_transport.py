#!/usr/bin/python3
"""Run the installed Mac MCP server over brokered SSH for this devbox."""
import os
import pathlib
import shlex
import signal
import subprocess
import sys
import uuid

from registration import load_registration


def main():
    if len(sys.argv) != 2:
        raise ValueError('Expected the absolute path to the Mac MCP registration JSON.')
    if not os.environ.get('DEVD_SESSION_ID'):
        raise ValueError('DEVD_SESSION_ID is missing; enable its env_vars forwarding in Codex.')
    reg = load_registration(pathlib.Path(sys.argv[1]))
    launch = ['/usr/bin/env', *(f'{k}={v}' for k, v in reg.env.items()), reg.command, *reg.args]
    marker = ('MAC_MCP_' + uuid.uuid4().hex).encode()
    remote = "printf '%s\\n' " + shlex.quote(marker.decode()) + '; exec ' + shlex.join(launch)
    broker = [
        '/usr/local/bin/srv', reg.key_title, '--why', reg.why,
        reg.target, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', f'UserKnownHostsFile={reg.known_hosts}', '-o', 'GlobalKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3', remote,
    ]
    proc = subprocess.Popen(broker, stdin=sys.stdin.buffer, stdout=subprocess.PIPE,
                            stderr=sys.stderr.buffer, bufsize=0, start_new_session=True)

    def stop(signum, _frame):
        if proc.poll() is None:
            os.killpg(proc.pid, signum)

    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, stop)
    try:
        # srv writes key-broker status to stdout. Keep it out of the MCP stream.
        while True:
            line = proc.stdout.readline()
            if not line:
                return proc.wait() or 1
            if line.rstrip(b'\r\n') == marker:
                break
            sys.stderr.buffer.write(line)
            sys.stderr.buffer.flush()
        while True:
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        return proc.wait()
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as exc:
        print(f'mac-mcp-bridge: {exc}', file=sys.stderr)
        sys.exit(1)
