import asyncio, json, os, pathlib, select, subprocess, sys, tempfile, time, unittest

# bridge.py relies on asyncio.timeout() (Python 3.11+). On an older interpreter
# tools/call would crash with an AttributeError outside the caught trio and the test would fail
# on a missing response — a confusing symptom, hence the explicit skip.
requires_timeout = unittest.skipUnless(
    hasattr(asyncio, 'timeout'), 'requires Python 3.11+ (asyncio.timeout)')

HERE = pathlib.Path(__file__).parent
CATALOG = {
    'initialize': {'protocolVersion': '2024-11-05', 'serverInfo': {'name': 'x', 'version': '1'},
                   'capabilities': {'tools': {}}},
    'tools': {'tools': [{'name': 'build', 'description': 'b', 'inputSchema': {'type': 'object'}}]},
    'resources': {'resources': []},
    'resource_templates': {'resourceTemplates': []},
}
REG = {'command': '/bin/false', 'args': [], 'target': 'ai@100.64.0.30',
       'keyTitle': 'SSH Key - Mac mini', 'why': 'test', 'label': 'Xcode', 'callTimeout': 1800}

def rpc(dirpath, messages, expect_ids, timeout=30):
    p = subprocess.Popen([sys.executable, str(HERE / 'bridge.py'), str(dirpath / 'registration.json')],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    p.stdin.write(''.join(json.dumps(m) + '\n' for m in messages).encode())
    p.stdin.flush()
    out, seen, deadline, buf = [], set(), time.monotonic() + timeout, b''
    try:
        # We keep stdin open until all expected responses arrive — if it were
        # closed right after writing (as with subprocess.run(input=...)), main() would hit
        # EOF and bridge.close() would cancel still-running tasks (e.g. tools/call waiting on
        # connect()) before they could respond. We read purely via os.read() on the raw fd
        # (not via TextIOWrapper.readline()) — a buffered readline() can swallow several
        # lines in one os-level read, so select() on the seemingly empty
        # pipe would then needlessly wait for the second line until the deadline.
        while not set(expect_ids) <= seen:
            nl = buf.find(b'\n')
            if nl == -1:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([p.stdout], [], [], remaining)[0]:
                    break  # hard deadline — the test fails on a missing response, not on a hang
                chunk = os.read(p.stdout.fileno(), 65536)
                if not chunk:
                    break
                buf += chunk
                continue
            line, buf = buf[:nl], buf[nl + 1:]
            if not line.strip():
                continue
            msg = json.loads(line)
            out.append(msg)
            if msg.get('id') is not None:
                seen.add(msg['id'])
    finally:
        p.stdin.close()
        p.stdout.close()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
    return out

@requires_timeout
class Discovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = pathlib.Path(self.tmp.name)
        (d / 'registration.json').write_text(json.dumps(REG))
        (d / 'catalog.json').write_text(json.dumps(CATALOG))
        (d / 'known_hosts').write_text('100.64.0.30 ssh-ed25519 AAAA\n')
        self.dir = d

    def tearDown(self):
        self.tmp.cleanup()

    def test_tools_list_is_served_locally_without_touching_the_mac(self):
        # `command` je /bin/false — kdyby most sahal na mac, tohle spadne.
        out = rpc(self.dir, [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
             'params': {'protocolVersion': '2024-11-05', 'capabilities': {}}},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}},
        ], expect_ids={1, 2})
        tools = next(m for m in out if m.get('id') == 2)['result']['tools']
        self.assertEqual([t['name'] for t in tools], ['build'])

    def test_error_text_uses_registration_label_not_opendesign(self):
        out = rpc(self.dir, [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
             'params': {'protocolVersion': '2024-11-05', 'capabilities': {}}},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
             'params': {'name': 'build', 'arguments': {}}},
        ], expect_ids={1, 2})
        text = json.dumps(out)
        self.assertIn('Xcode', text)
        self.assertNotIn('OpenDesign', text)

    def test_preflight_failure_text_reaches_caller_not_the_generic_connection_text(self):
        # A dedicated registration with `preflight`, separate from the shared REG (which does not
        # touch `preflight`, and the other tests rely on that). `/bin/false`
        # does not exist on the Mac — `/bin/sh -c '...; exit 1'` is used instead.
        reg = {**REG, 'preflight': [['/bin/sh', '-c', 'echo rozbito >&2; exit 1']]}
        tmp = tempfile.TemporaryDirectory()
        try:
            d = pathlib.Path(tmp.name)
            (d / 'registration.json').write_text(json.dumps(reg))
            (d / 'catalog.json').write_text(json.dumps(CATALOG))
            (d / 'known_hosts').write_text('100.64.0.30 ssh-ed25519 AAAA\n')
            out = rpc(d, [
                {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                 'params': {'protocolVersion': '2024-11-05', 'capabilities': {}}},
                {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                 'params': {'name': 'build', 'arguments': {}}},
            ], expect_ids={1, 2})
        finally:
            tmp.cleanup()
        text = json.dumps(next(m for m in out if m.get('id') == 2))
        self.assertIn('rozbito', text)
        self.assertNotIn('could not connect to the Mac', text)

if __name__ == '__main__':
    unittest.main()
