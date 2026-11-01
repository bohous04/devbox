#!/usr/bin/env python3
"""Reusable, credential-free configuration and stdio RPC for native proofs.

The caller owns the dedicated app-server process and loopback Responses server.
This module never opens the user's Codex home or reads authentication state.
"""
import json
import os
import select
import signal
import subprocess
import time


def fixture_config(url):
    if not url.startswith("http://127.0.0.1:"):
        raise ValueError("the fixture provider must be loopback HTTP")
    return (
        'model = "gpt-5.4"\nmodel_provider = "devbox_smoke"\n'
        'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
        '[model_providers.devbox_smoke]\nname = "Local deterministic smoke"\n'
        'base_url = ' + json.dumps(url.rstrip('/')) + '\n'
        'wire_api = "responses"\nrequires_openai_auth = false\n'
        'supports_websockets = false\n'
    )


class StdioRPC:
    """Native newline JSON RPC client for one dedicated app-server process."""

    def __init__(self, binary, home, cwd, *, extra_env=None, preexec_fn=None):
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(home),
               'CODEX_HOME': str(home), 'RUST_LOG': 'warn', 'TERM': 'xterm-256color'}
        env.update(extra_env or {})
        self.process = subprocess.Popen(
            [str(binary), 'app-server', '--stdio'], cwd=cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, preexec_fn=preexec_fn)
        self.buffer = b''
        self.events = []
        self.stderr = b''
        self.next_id = 0
        try:
            self.call('initialize', {
                'clientInfo': {'name': 'devbox-unified-proof', 'version': '1'},
                'capabilities': {'experimentalApi': True}})
            self.send({'method': 'initialized', 'params': {}})
        except BaseException:
            self.close()
            raise

    def send(self, message):
        self.process.stdin.write((json.dumps(message) + '\n').encode())
        self.process.stdin.flush()

    def read_until(self, predicate, timeout=100):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                if not line:
                    continue
                message = json.loads(line)
                self.events.append(message)
                if predicate(message):
                    return message
            if self.process.poll() is not None:
                raise RuntimeError('app-server exited: ' + self.stderr.decode(errors='replace')[-2000:])
            for stream in select.select([self.process.stdout, self.process.stderr], [], [], 0.1)[0]:
                data = os.read(stream.fileno(), 65536)
                if stream == self.process.stdout:
                    self.buffer += data
                else:
                    self.stderr += data
        raise TimeoutError('app-server response timed out; stderr: ' +
                           self.stderr.decode(errors='replace')[-2000:])

    def call(self, method, params):
        self.next_id += 1
        request_id = self.next_id
        self.send({'id': request_id, 'method': method, 'params': params})
        response = self.read_until(lambda x: x.get('id') == request_id)
        if 'error' in response:
            raise RuntimeError(method + ': ' + json.dumps(response['error']))
        return response['result']

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=3)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream:
                stream.close()
