"""Protocol regressions for OpenDesign's deferred SSH connection.

Every test runs a copy of the real bridge with a fake sibling SSH transport.
The transport-start marker models the user-visible key approval side effect.
"""
import asyncio
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
CATALOG = {
    'initialize': {
        'protocolVersion': '2025-11-25',
        'capabilities': {'tools': {}, 'resources': {}},
        'serverInfo': {'name': 'open-design', 'version': '0.2.0'},
        'instructions': 'Cached OpenDesign instructions.',
    },
    'tools': {'tools': [{
        'name': 'echo',
        'description': 'A tool provided by the connected Mac.',
        'inputSchema': {'type': 'object', 'properties': {'value': {'type': 'string'}}},
    }]},
    'resources': {'resources': []},
    'resource_templates': {'resourceTemplates': []},
}

FAKE_TRANSPORT = r'''
import json
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
registration = Path(sys.argv[1])
assert registration.is_absolute()
assert json.loads(registration.read_text())['target'] == 'test@example.invalid'

def log(event):
    with (root / 'events.jsonl').open('a') as stream:
        stream.write(json.dumps(event) + '\n')

def send(message):
    print(json.dumps(message), flush=True)

def tool_result(message):
    return {'jsonrpc': '2.0', 'id': message['id'], 'result': {
        'content': [{'type': 'text', 'text': json.dumps(
            message.get('params', {}).get('arguments', {}), sort_keys=True)}],
        'isError': False,
    }}

log({'event': 'start', 'pid': os.getpid(), 'registration': str(registration)})
if (root / 'fail_once').exists():
    (root / 'fail_once').unlink()
    print('Simulated SSH key connection refusal', file=sys.stderr, flush=True)
    sys.exit(7)

pending = []
cancel_pending = {}
server_pending = {}
for line in sys.stdin:
    message = json.loads(line)
    log({'event': 'message', 'message': message})
    method = message.get('method')
    if method is None and message.get('id') in server_pending:
        original = server_pending.pop(message['id'])
        send(tool_result(original))
    elif method == 'initialize':
        if (root / 'slow_initialize').exists():
            continue
        send({'jsonrpc': '2.0', 'id': message['id'], 'result': {
            'protocolVersion': '2025-11-25',
            'capabilities': {'tools': {}, 'resources': {}},
            'serverInfo': {'name': 'connected-open-design', 'version': '0.2.0'},
        }})
    elif method == 'tools/call':
        arguments = message.get('params', {}).get('arguments', {})
        if arguments.get('request_client_roots'):
            server_pending['server-roots-request'] = message
            send({'jsonrpc': '2.0', 'id': 'server-roots-request', 'method': 'roots/list', 'params': {}})
            if arguments.get('cancel_server_request'):
                send({'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {
                    'requestId': 'server-roots-request', 'reason': 'No longer need the roots',
                }})
                send(tool_result(server_pending.pop('server-roots-request')))
        elif arguments.get('wait_for_cancel'):
            cancel_pending[message['id']] = message
        elif arguments.get('hold_for_pair'):
            pending.append(message)
            if len(pending) == 2:
                send(tool_result(pending.pop()))
                send(tool_result(pending.pop()))
        else:
            send(tool_result(message))
    elif method == 'notifications/cancelled':
        cancelled = cancel_pending.pop(message.get('params', {}).get('requestId'), None)
        if cancelled:
            # A server can race cancellation: this late result must be discarded.
            send(tool_result(cancelled))
    elif method == 'resources/read':
        send({'jsonrpc': '2.0', 'id': message['id'], 'result': {
            'contents': [{'uri': message['params']['uri'],
                          'mimeType': 'text/plain', 'text': 'Read from the Mac'}],
        }})
    elif method == 'ping':
        send({'jsonrpc': '2.0', 'id': message['id'], 'result': {}})
    elif 'id' in message:
        send({'jsonrpc': '2.0', 'id': message['id'], 'error': {
            'code': -32601, 'message': 'Unexpected upstream method: ' + str(method),
        }})
log({'event': 'eof'})
'''


class BridgeProcess:
    def __init__(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        shutil.copyfile(ROOT / 'tools/opendesign/bridge.py', self.root / 'bridge.py')
        (self.root / 'ssh_transport.py').write_text(FAKE_TRANSPORT)
        (self.root / 'catalog.json').write_text(json.dumps(CATALOG))
        self.registration = self.root / 'registration.json'
        self.registration.write_text(json.dumps({
            'target': 'test@example.invalid',
            'command': '/Applications/Test OpenDesign',
            'args': [],
        }))
        (self.root / 'known_hosts').write_text('example.invalid ssh-ed25519 fake-test-key\n')
        self.messages = queue.Queue()
        self.errors = []
        self.process = subprocess.Popen(
            [sys.executable, str(self.root / 'bridge.py'), str(self.registration)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
            env={**os.environ, 'DEVD_SESSION_ID': 'opendesign-lazy-regression'},
        )
        self.output_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self.error_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self.output_thread.start()
        self.error_thread.start()

    def _read_stdout(self):
        for line in self.process.stdout:
            try:
                self.messages.put(json.loads(line))
            except json.JSONDecodeError:
                self.messages.put({'invalid_json': line})
        self.messages.put(None)

    def _read_stderr(self):
        self.errors.extend(self.process.stderr)

    def send(self, method, request_id=None, params=None):
        message = {'jsonrpc': '2.0', 'method': method}
        if request_id is not None:
            message['id'] = request_id
        if params is not None:
            message['params'] = params
        self.process.stdin.write(json.dumps(message) + '\n')
        self.process.stdin.flush()

    def receive(self, timeout=4):
        try:
            message = self.messages.get(timeout=timeout)
        except queue.Empty as exc:
            raise AssertionError('Bridge response timed out. stderr: ' + ''.join(self.errors)) from exc
        if message is None:
            raise AssertionError('Bridge closed stdout. stderr: ' + ''.join(self.errors))
        if 'invalid_json' in message:
            raise AssertionError('Non-protocol output on stdout: ' + repr(message['invalid_json']))
        return message

    def request(self, method, request_id, params=None):
        self.send(method, request_id, params)
        result = self.receive()
        if result.get('id') != request_id:
            raise AssertionError(f'Expected response ID {request_id!r}, got {result!r}')
        return result

    def initialize(self, capabilities=None):
        result = self.request('initialize', 'client-init', {
            'protocolVersion': '2025-11-25', 'capabilities': capabilities or {},
            'clientInfo': {'name': 'lazy-bridge-regression', 'version': '1.0'},
        })
        self.send('notifications/initialized')
        return result

    def events(self):
        path = self.root / 'events.jsonl'
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()]

    def starts(self):
        return [event for event in self.events() if event['event'] == 'start']

    def methods(self):
        return [event['message']['method'] for event in self.events()
                if event['event'] == 'message' and 'method' in event['message']]

    def wait_for_method(self, method, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for event in self.events():
                if event['event'] == 'message' and event['message'].get('method') == method:
                    return event['message']
            time.sleep(0.01)
        raise AssertionError(f'Upstream did not receive {method}. stderr: ' + ''.join(self.errors))

    def close_input(self):
        if not self.process.stdin.closed:
            self.process.stdin.close()

    def close(self):
        self.close_input()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)
        # Reap only fake transports from this test, including failed cleanup cases.
        for event in self.starts():
            try:
                os.kill(event['pid'], 15)
            except ProcessLookupError:
                pass
        self.output_thread.join(timeout=1)
        self.error_thread.join(timeout=1)
        self.process.stdout.close()
        self.process.stderr.close()
        self.temporary.cleanup()


# bridge.py relies on asyncio.timeout() (Python 3.11+, the devbox has 3.12); on an older
# interpreter dispatch would fail with AttributeError and the tests on a response timeout.
@unittest.skipUnless(hasattr(asyncio, 'timeout'), 'requires Python 3.11+ (asyncio.timeout)')
class OpenDesignLazyBridgeTest(unittest.TestCase):
    def setUp(self):
        self.bridge = BridgeProcess()
        self.addCleanup(self.bridge.close)

    def assert_tool_result(self, response, arguments):
        self.assertNotIn('error', response)
        result = response['result']
        self.assertFalse(result.get('isError', False), result)
        self.assertEqual(result['content'], [
            {'type': 'text', 'text': json.dumps(arguments, sort_keys=True)},
        ])

    def test_startup_and_discovery_never_request_ssh(self):
        self.assertEqual(self.bridge.initialize()['result'], CATALOG['initialize'])
        for request_id, method, expected in [
            (1, 'tools/list', CATALOG['tools']),
            (2, 'resources/list', CATALOG['resources']),
            (3, 'resources/templates/list', CATALOG['resource_templates']),
            (4, 'ping', {}),
        ]:
            with self.subTest(method=method):
                self.assertEqual(self.bridge.request(method, request_id)['result'], expected)
        self.assertEqual(self.bridge.starts(), [], 'Discovery caused the SSH approval side effect')

    def test_first_tool_connects_and_later_calls_reuse_transport(self):
        self.bridge.initialize()
        first = {'value': 'first result'}
        second = {'value': 'second result'}
        self.assert_tool_result(self.bridge.request('tools/call', 'first-call', {
            'name': 'echo', 'arguments': first,
        }), first)
        self.assert_tool_result(self.bridge.request('tools/call', 42, {
            'name': 'echo', 'arguments': second,
        }), second)
        self.assertEqual(len(self.bridge.starts()), 1)
        self.assertEqual(self.bridge.methods(), [
            'initialize', 'notifications/initialized', 'tools/call', 'tools/call',
        ])

    def test_simultaneous_calls_correlate_out_of_order_responses(self):
        self.bridge.initialize()
        expected = {
            'parallel-one': {'value': 'one', 'hold_for_pair': True},
            2: {'value': 'two', 'hold_for_pair': True},
        }
        for request_id, arguments in expected.items():
            self.bridge.send('tools/call', request_id, {'name': 'echo', 'arguments': arguments})
        responses = [self.bridge.receive(), self.bridge.receive()]
        self.assertEqual({response['id'] for response in responses}, set(expected))
        for response in responses:
            self.assert_tool_result(response, expected[response['id']])
        self.assertEqual(len(self.bridge.starts()), 1)
        self.assertEqual(self.bridge.methods().count('initialize'), 1)

    def test_failed_connection_is_tool_error_and_next_explicit_call_can_retry(self):
        self.bridge.initialize()
        (self.bridge.root / 'fail_once').touch()
        failed = self.bridge.request('tools/call', 'failure', {
            'name': 'echo', 'arguments': {'value': 'must fail'},
        })
        self.assertNotIn('error', failed)
        self.assertTrue(failed['result'].get('isError'), failed)
        self.assertTrue(any(item.get('type') == 'text' and item.get('text')
                            for item in failed['result'].get('content', [])), failed)
        self.assertEqual(len(self.bridge.starts()), 1)
        self.assertEqual(self.bridge.request('ping', 'after-failure')['result'], {})
        self.assertEqual(len(self.bridge.starts()), 1, 'Local ping retried SSH')
        arguments = {'value': 'retry worked'}
        self.assert_tool_result(self.bridge.request('tools/call', 'retry', {
            'name': 'echo', 'arguments': arguments,
        }), arguments)
        self.assertEqual(len(self.bridge.starts()), 2)

    def test_resource_read_connects_and_returns_upstream_content(self):
        self.bridge.initialize()
        self.assertEqual(self.bridge.starts(), [])
        result = self.bridge.request('resources/read', 'resource-read', {
            'uri': 'opendesign://project/example',
        })
        self.assertEqual(result['result'], {'contents': [{
            'uri': 'opendesign://project/example',
            'mimeType': 'text/plain', 'text': 'Read from the Mac',
        }]})
        self.assertEqual(len(self.bridge.starts()), 1)
        self.assertEqual(self.bridge.methods(), [
            'initialize', 'notifications/initialized', 'resources/read',
        ])

    def test_cancellation_maps_id_discards_late_result_and_keeps_connection_usable(self):
        self.bridge.initialize()
        self.bridge.send('tools/call', 'client-cancel-me', {
            'name': 'echo', 'arguments': {'wait_for_cancel': True},
        })
        upstream_call = self.bridge.wait_for_method('tools/call')
        self.assertNotEqual(upstream_call['id'], 'client-cancel-me')
        self.bridge.send('notifications/cancelled', params={
            'requestId': 'client-cancel-me', 'reason': 'User stopped this call',
        })
        cancellation = self.bridge.wait_for_method('notifications/cancelled')
        self.assertEqual(cancellation['params']['requestId'], upstream_call['id'])
        arguments = {'value': 'call after cancellation'}
        self.assert_tool_result(self.bridge.request('tools/call', 'still-usable', {
            'name': 'echo', 'arguments': arguments,
        }), arguments)
        # The fake writes its late cancelled result before the second call's reply.
        # A leaked result therefore fails request()'s exact response-ID check above.
        self.assertEqual(self.bridge.request('ping', 'after-cancellation')['result'], {})
        self.assertEqual(len(self.bridge.starts()), 1)

    def test_initialize_cancellation_is_ignored_even_before_dispatch_runs(self):
        messages = [
            {'jsonrpc': '2.0', 'id': 'init-cancel-race', 'method': 'initialize', 'params': {
                'protocolVersion': '2025-11-25', 'capabilities': {},
                'clientInfo': {'name': 'initialization-cancellation-test', 'version': '1.0'},
            }},
            {'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {
                'requestId': 'init-cancel-race',
            }},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 'after-init', 'method': 'ping'},
        ]
        # One write makes both requests available before scheduled dispatch tasks run.
        self.bridge.process.stdin.write(''.join(json.dumps(message) + '\n' for message in messages))
        self.bridge.process.stdin.flush()
        response = self.bridge.receive()
        self.assertEqual(response['id'], 'init-cancel-race')
        self.assertEqual(response['result'], CATALOG['initialize'])
        self.assertEqual(self.bridge.receive(), {'jsonrpc': '2.0', 'id': 'after-init', 'result': {}})
        self.assertEqual(self.bridge.starts(), [])

    def test_server_request_reply_is_forwarded_with_original_upstream_id(self):
        self.bridge.initialize({'roots': {}})
        arguments = {'request_client_roots': True}
        self.bridge.send('tools/call', 'requests-roots', {'name': 'echo', 'arguments': arguments})
        server_request = self.bridge.receive()
        self.assertEqual(server_request['method'], 'roots/list')
        self.assertNotEqual(server_request['id'], 'server-roots-request')
        reply = {'jsonrpc': '2.0', 'id': server_request['id'], 'result': {'roots': []}}
        self.bridge.process.stdin.write(json.dumps(reply) + '\n')
        self.bridge.process.stdin.flush()
        response = self.bridge.receive()
        self.assertEqual(response['id'], 'requests-roots')
        self.assert_tool_result(response, arguments)
        upstream_replies = [event['message'] for event in self.bridge.events()
                            if event['event'] == 'message' and 'method' not in event['message']]
        self.assertEqual(upstream_replies, [{**reply, 'id': 'server-roots-request'}])

    def test_server_request_cancellation_uses_the_client_visible_id(self):
        self.bridge.initialize({'roots': {}})
        arguments = {'request_client_roots': True, 'cancel_server_request': True}
        self.bridge.send('tools/call', 'cancels-roots', {'name': 'echo', 'arguments': arguments})
        server_request = self.bridge.receive()
        self.assertEqual(server_request['method'], 'roots/list')
        self.assertNotEqual(server_request['id'], 'server-roots-request')
        cancellation = self.bridge.receive()
        self.assertEqual(cancellation['method'], 'notifications/cancelled')
        self.assertEqual(cancellation['params']['requestId'], server_request['id'])
        self.assertEqual(cancellation['params']['reason'], 'No longer need the roots')
        response = self.bridge.receive()
        self.assertEqual(response['id'], 'cancels-roots')
        self.assert_tool_result(response, arguments)

    def assert_transport_stops_on_eof(self):
        child_pid = self.bridge.starts()[0]['pid']
        self.bridge.close_input()
        self.assertEqual(self.bridge.process.wait(timeout=3), 0)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.02)
        else:
            self.fail('SSH transport remained alive after the client closed stdin')

    def test_client_eof_stops_the_connected_transport(self):
        self.bridge.initialize()
        self.bridge.request('tools/call', 'connect-before-eof', {'name': 'echo', 'arguments': {}})
        self.assert_transport_stops_on_eof()

    def test_client_eof_during_upstream_initialization_stops_transport(self):
        self.bridge.initialize()
        (self.bridge.root / 'slow_initialize').touch()
        self.bridge.send('tools/call', 'connecting-at-eof', {'name': 'echo', 'arguments': {}})
        self.bridge.wait_for_method('initialize')
        self.assert_transport_stops_on_eof()


if __name__ == '__main__':
    unittest.main()
