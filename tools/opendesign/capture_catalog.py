#!/usr/bin/env python3
"""Capture discovery metadata directly on the Mac; never use SSH or call a tool."""
import argparse
import datetime
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time

VERSIONS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')


class MethodNotFound(Exception):
    pass


class Client:
    def __init__(self, registration):
        self.process = subprocess.Popen(
            [registration['command'], *registration.get('args', [])],
            env={**os.environ, **registration.get('env', {})},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b''
        self.counter = 0

    def send(self, message):
        self.process.stdin.write((json.dumps(message) + '\n').encode())
        self.process.stdin.flush()

    def request(self, method, params, timeout=90):
        self.counter += 1
        request_id = self.counter
        self.send({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        while True:
            while b'\n' not in self.buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self.selector.select(remaining):
                    raise RuntimeError('Timed out reading OpenDesign metadata.')
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError('OpenDesign exited while reading metadata.')
                self.buffer += chunk
                if len(self.buffer) > 8 * 1024 * 1024:
                    raise RuntimeError('OpenDesign metadata frame is too large.')
            raw, self.buffer = self.buffer.split(b'\n', 1)
            message = json.loads(raw)
            if message.get('id') != request_id or 'method' in message:
                continue
            if 'error' in message:
                if message['error'].get('code') == -32601:
                    raise MethodNotFound()
                raise RuntimeError('OpenDesign rejected a metadata request.')
            return message['result']

    def pages(self, method, field):
        items, cursor, seen = [], None, set()
        for _ in range(100):
            result = self.request(method, {'cursor': cursor} if cursor else {})
            items.extend(result[field])
            cursor = result.get('nextCursor')
            if not cursor:
                return {field: items}
            if cursor in seen:
                raise RuntimeError('OpenDesign repeated a pagination cursor.')
            seen.add(cursor)
        raise RuntimeError('Too many OpenDesign metadata pages.')

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=6)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process.stdout.close()
        self.selector.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registration', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    registration = json.loads(args.registration.read_text())
    catalog = {'supported_protocol_versions': [], 'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    for version in VERSIONS:
        client = Client(registration)
        try:
            initial = client.request('initialize', {
                'protocolVersion': version, 'capabilities': {},
                'clientInfo': {'name': 'open-design-catalog-capture', 'version': '1'}})
            if initial['protocolVersion'] == version:
                catalog['supported_protocol_versions'].append(version)
            client.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
            if 'initialize' not in catalog:
                catalog['initialize'] = initial
                catalog['tools'] = client.pages('tools/list', 'tools')
                catalog['resources'] = client.pages('resources/list', 'resources')
                try:
                    catalog['resource_templates'] = client.pages('resources/templates/list', 'resourceTemplates')
                except MethodNotFound:
                    catalog['resource_templates'] = {'resourceTemplates': []}
                if 'prompts' in initial['capabilities']:
                    catalog['prompts'] = client.pages('prompts/list', 'prompts')
        finally:
            client.close()
    if not catalog['supported_protocol_versions']:
        raise RuntimeError('No supported OpenDesign protocol version found.')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=args.output.parent, prefix='.opendesign-catalog-')
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(catalog, output, ensure_ascii=False, indent=2)
            output.write('\n')
        os.replace(temporary, args.output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(json.dumps({'tools': len(catalog['tools']['tools']),
                      'resources': len(catalog['resources']['resources']),
                      'protocol_versions': catalog['supported_protocol_versions']}))


if __name__ == '__main__':
    main()
