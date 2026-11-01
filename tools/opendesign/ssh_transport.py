#!/usr/bin/python3
"""Run the installed Mac OpenDesign MCP over brokered SSH for this devbox."""
import json
import os
import pathlib
import re
import shlex
import signal
import subprocess
import sys
import uuid


def main():
    if len(sys.argv) != 2:
        raise ValueError('Expected the absolute path to the Mac MCP registration JSON.')
    if not os.environ.get('DEVD_SESSION_ID'):
        raise ValueError('DEVD_SESSION_ID is missing; enable its env_vars forwarding in Codex.')
    config_path = pathlib.Path(sys.argv[1])
    if not config_path.is_absolute():
        raise ValueError('Registration path must be absolute.')
    config = json.loads(config_path.read_text())
    if not re.fullmatch(r'[A-Za-z0-9_.-]+@[A-Za-z0-9][A-Za-z0-9.-]*', config['target']):
        raise ValueError('Expected an explicit user@hostname SSH target.')
    known_hosts = config_path.with_name('known_hosts')
    if not known_hosts.is_file():
        raise ValueError('The verified Mac SSH host key is missing.')
    command = config['command']
    if not command.startswith('/'):
        raise ValueError('The installed Mac MCP launch command must be absolute.')
    args = config.get('args', [])
    if not isinstance(args, list) or not all(isinstance(v, str) for v in args):
        raise ValueError('Invalid Mac MCP arguments.')
    remote_env = config.get('env', {})
    if any(k not in {'ELECTRON_RUN_AS_NODE', 'OD_DATA_DIR', 'OD_MCP_BOOTSTRAP_ARGS', 'OD_MCP_BOOTSTRAP_COMMAND', 'OD_SIDECAR_CLIENT_ENDPOINT'} or not isinstance(v, str) for k, v in remote_env.items()):
        raise ValueError('Unexpected Mac environment field; inspect the official registration.')
    launch = ['/usr/bin/env', *(f'{k}={v}' for k, v in remote_env.items()), command, *args]
    marker = ('OPENDESIGN_MCP_' + uuid.uuid4().hex).encode()
    remote = "printf '%s\\n' " + shlex.quote(marker.decode()) + '; exec ' + shlex.join(launch)
    broker = [
        '/usr/local/bin/srv', 'SSH Key - MacBook', '--why',
        'OpenDesign MCP connection from the authorized devbox to the Mac',
        config['target'], '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', f'UserKnownHostsFile={known_hosts}', '-o', 'GlobalKnownHostsFile=/dev/null',
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
        print(f'OpenDesign Mac bridge: {exc}', file=sys.stderr)
        sys.exit(1)
