#!/usr/bin/python3
"""Expose cached OpenDesign discovery locally; open brokered SSH on actual use."""
import asyncio
import copy
import json
import pathlib
import signal
import sys
import uuid

MAX_FRAME = 8 * 1024 * 1024
CONNECT_TIMEOUT = 150
CALL_TIMEOUT = 120
VERSIONS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')
DISCOVERY = {
    'tools/list': ('tools', 'tools'),
    'resources/list': ('resources', 'resources'),
    'resources/templates/list': ('resource_templates', 'resourceTemplates'),
    'prompts/list': ('prompts', 'prompts'),
}
# None of these methods are discovery/prewarming: they ask for actual app data/work.
APP_METHODS = {'tools/call', 'resources/read', 'prompts/get', 'completion/complete',
               'resources/subscribe', 'resources/unsubscribe', 'tasks/get',
               'tasks/result', 'tasks/list', 'tasks/cancel'}


class RpcError(Exception):
    def __init__(self, error):
        self.error = error


def load_catalog(path):
    catalog = json.loads(path.read_text())
    initial = catalog['initialize']
    if not isinstance(initial.get('serverInfo'), dict) or not isinstance(initial.get('capabilities'), dict):
        raise ValueError('Invalid OpenDesign catalog initialization.')
    for method, (key, items) in DISCOVERY.items():
        if key == 'prompts' and key not in catalog:
            continue
        if not isinstance(catalog[key].get(items), list) or catalog[key].get('nextCursor'):
            raise ValueError('OpenDesign discovery catalog must contain all pages.')
    return catalog


class Upstream:
    def __init__(self, owner):
        self.owner = owner
        self.process = None
        self.reader = None
        self.pending = {}
        self.counter = 0
        self.closed = False

    async def start(self):
        self.process = await asyncio.create_subprocess_exec(
            sys.executable, str(pathlib.Path(__file__).with_name('ssh_transport.py')),
            str(self.owner.registration), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=sys.stderr, limit=MAX_FRAME)
        self.reader = asyncio.create_task(self.read())

    async def send(self, message):
        if self.closed:
            raise ConnectionError('OpenDesign transport is closed.')
        self.process.stdin.write((json.dumps(message, separators=(',', ':')) + '\n').encode())
        await self.process.stdin.drain()

    async def request(self, method, params, client_id=None):
        self.counter += 1
        request_id = f'od-upstream-{self.counter}'
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        if client_id is not None:
            self.owner.forwarded[client_id] = (self, request_id)
        try:
            await self.send({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params})
            return await future
        except asyncio.CancelledError:
            if method != 'initialize' and not self.closed:
                try:
                    await self.send({'jsonrpc': '2.0', 'method': 'notifications/cancelled',
                                     'params': {'requestId': request_id}})
                except (OSError, ValueError):
                    pass
            raise
        finally:
            self.pending.pop(request_id, None)
            if client_id is not None:
                self.owner.forwarded.pop(client_id, None)

    async def read(self):
        try:
            while line := await self.process.stdout.readline():
                message = json.loads(line)
                if 'method' not in message:
                    future = self.pending.get(message.get('id'))
                    if future and not future.done():
                        if 'error' in message:
                            future.set_exception(RpcError(message['error']))
                        else:
                            future.set_result(message.get('result', {}))
                elif 'id' in message:
                    # Server-initiated requests have their own ID namespace.
                    request_id = 'od-server-' + uuid.uuid4().hex
                    self.owner.server_requests[request_id] = (self, message['id'])
                    self.owner.send({**message, 'id': request_id})
                else:
                    if message.get('method') == 'notifications/cancelled':
                        params = message.get('params', {})
                        original_id = params.get('requestId')
                        request_id = next((key for key, route in self.owner.server_requests.items()
                                           if route == (self, original_id)), None)
                        if request_id is None:
                            continue
                        self.owner.server_requests.pop(request_id, None)
                        message = {**message, 'params': {**params, 'requestId': request_id}}
                    self.owner.send(message)
        except (OSError, ValueError, asyncio.CancelledError):
            pass
        finally:
            self.closed = True
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(ConnectionError('OpenDesign transport disconnected.'))
            self.owner.server_requests = {
                key: route for key, route in self.owner.server_requests.items() if route[0] is not self}

    async def close(self):
        self.closed = True
        if self.process and self.process.returncode is None:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 0.5)
            except asyncio.TimeoutError:
                try:
                    self.process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(self.process.wait(), 6)
                except asyncio.TimeoutError:
                    self.process.kill()
                    await self.process.wait()
        if self.reader:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)


class Bridge:
    def __init__(self, registration):
        self.registration = registration
        self.catalog = load_catalog(registration.with_name('catalog.json'))
        self.initialization = None
        self.upstream = None
        self.connecting = None
        self.work = {}
        self.request_methods = {}
        self.forwarded = {}
        self.server_requests = {}

    @staticmethod
    def send(message):
        sys.stdout.write(json.dumps(message, separators=(',', ':')) + '\n')
        sys.stdout.flush()

    async def connect(self):
        if self.upstream:
            await self.upstream.close()
            self.upstream = None
        upstream = Upstream(self)
        try:
            async with asyncio.timeout(CONNECT_TIMEOUT):
                await upstream.start()
                result = await upstream.request('initialize', self.initialization)
                if result.get('protocolVersion') != self.initialization['protocolVersion']:
                    raise ConnectionError('OpenDesign protocol changed; refresh its discovery catalog.')
                await upstream.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
            self.upstream = upstream
            return upstream
        except BaseException:
            await upstream.close()
            raise

    async def connection(self):
        if self.upstream and not self.upstream.closed:
            return self.upstream
        if not self.connecting:
            self.connecting = asyncio.create_task(self.connect())
        connecting = self.connecting
        try:
            # Cancelling one call must not cancel other callers' shared initialization.
            return await asyncio.shield(connecting)
        finally:
            if connecting.done() and self.connecting is connecting:
                self.connecting = None

    async def dispatch(self, message):
        request_id, method = message['id'], message['method']
        params = message.get('params') or {}
        submitted = False
        try:
            if method == 'initialize':
                if self.initialization is not None:
                    raise RpcError({'code': -32600, 'message': 'Already initialized.'})
                result = copy.deepcopy(self.catalog['initialize'])
                supported = self.catalog.get('supported_protocol_versions', VERSIONS)
                requested = params.get('protocolVersion')
                if requested in supported:
                    result['protocolVersion'] = requested
                self.initialization = {**params, 'protocolVersion': result['protocolVersion']}
            elif method == 'ping':
                result = {}
            elif self.initialization is None:
                raise RpcError({'code': -32000, 'message': 'Initialize the OpenDesign bridge first.'})
            elif method in DISCOVERY:
                key, items = DISCOVERY[method]
                if params.get('cursor'):
                    raise RpcError({'code': -32602, 'message': 'The local catalog has a single complete page.'})
                result = self.catalog.get(key, {items: []})
            elif method in APP_METHODS:
                upstream = await self.connection()
                async with asyncio.timeout(CALL_TIMEOUT):
                    submitted = True
                    result = await upstream.request(method, params, request_id)
            else:
                raise RpcError({'code': -32601, 'message': 'Method not supported.'})
            self.send({'jsonrpc': '2.0', 'id': request_id, 'result': result})
        except RpcError as exc:
            self.send({'jsonrpc': '2.0', 'id': request_id, 'error': exc.error})
        except asyncio.CancelledError:
            await self.cancel_upstream(request_id)
            raise
        except (OSError, ValueError, asyncio.TimeoutError):
            await self.cancel_upstream(request_id)
            text = ('OpenDesign connection was interrupted or timed out. The operation may have run; '
                    'check its state before repeating a write.' if submitted else
                    'OpenDesign could not connect to the Mac. Check the SSH approval, '
                    'Mac availability and unlocked devbox vault, then explicitly retry.')
            if method == 'tools/call':
                self.send({'jsonrpc': '2.0', 'id': request_id, 'result': {
                    'isError': True, 'content': [{'type': 'text', 'text': text}]}})
            else:
                self.send({'jsonrpc': '2.0', 'id': request_id,
                           'error': {'code': -32000, 'message': text}})
        finally:
            self.work.pop(request_id, None)
            self.request_methods.pop(request_id, None)
            if not self.work and self.connecting and not self.connecting.done():
                connecting, self.connecting = self.connecting, None
                connecting.cancel()
                await asyncio.gather(connecting, return_exceptions=True)

    async def cancel_upstream(self, request_id):
        route = self.forwarded.get(request_id)
        if route:
            upstream, forwarded_id = route
            try:
                await upstream.send({'jsonrpc': '2.0', 'method': 'notifications/cancelled',
                                     'params': {'requestId': forwarded_id}})
            except (OSError, ValueError):
                pass

    async def receive(self, message):
        if not isinstance(message, dict) or message.get('jsonrpc') != '2.0':
            self.send({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid request.'}})
            return
        if 'method' not in message:
            if not isinstance(message.get('id'), (str, int)) or isinstance(message.get('id'), bool):
                return
            route = self.server_requests.pop(message.get('id'), None)
            if route:
                upstream, request_id = route
                if not upstream.closed:
                    await upstream.send({**message, 'id': request_id})
            return
        if 'id' not in message:
            if message['method'] == 'notifications/cancelled':
                params = message.get('params', {})
                request_id = params.get('requestId') if isinstance(params, dict) else None
                if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
                    return
                task = self.work.get(request_id)
                if task and not task.done() and request_id in self.request_methods and self.request_methods[request_id] != 'initialize':
                    task.cancel()
            elif message['method'] != 'notifications/initialized' and self.upstream and not self.upstream.closed:
                await self.upstream.send(message)
            return
        request_id = message['id']
        if (not isinstance(request_id, (str, int)) or isinstance(request_id, bool)
                or request_id in self.work or not isinstance(message['method'], str)
                or not isinstance(message.get('params', {}), dict)):
            self.send({'jsonrpc': '2.0', 'id': request_id,
                       'error': {'code': -32600, 'message': 'Invalid or duplicate request ID.'}})
            return
        self.request_methods[request_id] = message['method']
        task = asyncio.create_task(self.dispatch(message))
        self.work[request_id] = task

        def finished(done):
            # A cancellation before the coroutine starts cannot run its finally block.
            if self.work.get(request_id) is done:
                self.work.pop(request_id, None)
                self.request_methods.pop(request_id, None)

        task.add_done_callback(finished)

    async def close(self):
        tasks = list(self.work.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self.connecting:
            self.connecting.cancel()
            await asyncio.gather(self.connecting, return_exceptions=True)
        if self.upstream:
            await self.upstream.close()


async def main():
    if len(sys.argv) != 2 or not pathlib.Path(sys.argv[1]).is_absolute():
        raise ValueError('Expected the absolute path to the Mac registration JSON.')
    bridge = Bridge(pathlib.Path(sys.argv[1]))
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        loop.add_signal_handler(sig, task.cancel)
    reader = asyncio.StreamReader(limit=MAX_FRAME)
    transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    try:
        while line := await reader.readline():
            try:
                await bridge.receive(json.loads(line))
            except json.JSONDecodeError:
                bridge.send({'jsonrpc': '2.0', 'id': None,
                             'error': {'code': -32700, 'message': 'Invalid JSON.'}})
    finally:
        transport.close()
        await bridge.close()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    except (OSError, ValueError, KeyError):
        print('OpenDesign bridge: local discovery catalog is missing or invalid; reinstall the integration.', file=sys.stderr)
        sys.exit(1)
