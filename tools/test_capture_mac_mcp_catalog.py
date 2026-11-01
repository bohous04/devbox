import json
import unittest
from unittest import mock

from capture_mac_mcp_catalog import METHOD_NOT_FOUND, build_catalog, capture


class BuildCatalog(unittest.TestCase):
    def test_shape_matches_what_bridge_load_catalog_expects(self):
        c = build_catalog(
            initialize={'protocolVersion': '2024-11-05', 'serverInfo': {'name': 'x', 'version': '1'},
                        'capabilities': {'tools': {}}},
            tools={'tools': [{'name': 'build'}]},
            resources={'resources': []},
            resource_templates={'resourceTemplates': []},
        )
        self.assertEqual(set(c) >= {'initialize', 'tools', 'resources', 'resource_templates'}, True)
        self.assertEqual(c['tools']['tools'][0]['name'], 'build')

    def test_supported_protocol_versions_records_what_server_actually_negotiated(self):
        # bridge.dispatch() reads this key and without it falls back to VERSIONS from bridge.py —
        # capture must record exactly the version the initialize response echoed.
        c = build_catalog(
            initialize={'protocolVersion': '2025-06-18', 'serverInfo': {}, 'capabilities': {}},
            tools={'tools': []}, resources={'resources': []}, resource_templates={'resourceTemplates': []})
        self.assertEqual(c['supported_protocol_versions'], ['2025-06-18'])

    def test_missing_protocol_version_is_rejected(self):
        with self.assertRaises(ValueError):
            build_catalog(
                initialize={'serverInfo': {}, 'capabilities': {}},
                tools={'tools': []}, resources={'resources': []}, resource_templates={'resourceTemplates': []})

    def test_paginated_response_is_rejected(self):
        # bridge.load_catalog rejects a catalog with nextCursor — let it break here, not in a session.
        with self.assertRaises(ValueError):
            build_catalog(
                initialize={'protocolVersion': '2024-11-05', 'serverInfo': {}, 'capabilities': {}},
                tools={'tools': [], 'nextCursor': 'abc'},
                resources={'resources': []}, resource_templates={'resourceTemplates': []})

    def test_prompts_included_when_present(self):
        c = build_catalog(
            initialize={'protocolVersion': '2024-11-05', 'serverInfo': {}, 'capabilities': {}},
            tools={'tools': []}, resources={'resources': []}, resource_templates={'resourceTemplates': []},
            prompts={'prompts': [{'name': 'greet'}]},
        )
        self.assertEqual(c['prompts']['prompts'][0]['name'], 'greet')

    def test_prompts_key_absent_when_not_given(self):
        # bridge.load_catalog tolerates missing 'prompts' — the server need not support it.
        c = build_catalog(
            initialize={'protocolVersion': '2024-11-05', 'serverInfo': {}, 'capabilities': {}},
            tools={'tools': []}, resources={'resources': []}, resource_templates={'resourceTemplates': []})
        self.assertNotIn('prompts', c)


# --- capture(): error paths against live ssh (subprocess.run mocked) ------------------------
#
# None of this is verified against a real MCP server — only against what its response would
# look like as input. Real verification waits for a run against the mini.

INIT_OK = {'jsonrpc': '2.0', 'id': 0, 'result': {
    'protocolVersion': '2024-11-05', 'serverInfo': {'name': 'x', 'version': '1'},
    'capabilities': {'tools': {}}}}
TOOLS_OK = {'jsonrpc': '2.0', 'id': 1, 'result': {'tools': [{'name': 'build'}]}}
RESOURCES_OK = {'jsonrpc': '2.0', 'id': 2, 'result': {'resources': []}}
TEMPLATES_OK = {'jsonrpc': '2.0', 'id': 3, 'result': {'resourceTemplates': []}}
PROMPTS_OK = {'jsonrpc': '2.0', 'id': 4, 'result': {'prompts': [{'name': 'greet'}]}}
PROMPTS_NOT_FOUND = {'jsonrpc': '2.0', 'id': 4,
                      'error': {'code': METHOD_NOT_FOUND, 'message': 'Method not found'}}


def _stdout(replies):
    return ''.join(json.dumps(r) + '\n' for r in replies)


def _completed(stdout='', stderr='', returncode=0):
    completed = mock.Mock()
    completed.returncode = returncode
    completed.stdout = stdout
    completed.stderr = stderr
    return completed


class Capture(unittest.TestCase):
    @mock.patch('capture_mac_mcp_catalog.subprocess.run')
    def test_nonzero_exit_raises_naming_code_and_stderr(self, run):
        # Mini asleep / wrong host key / wrong server path — ssh itself fails.
        run.return_value = _completed(stdout='', stderr='ssh: connect to host mini: Connection refused',
                                       returncode=255)
        with self.assertRaises(RuntimeError) as ctx:
            capture('ai@mini', ['/opt/homebrew/bin/xcodebuildmcp', 'mcp'])
        self.assertIn('255', str(ctx.exception))
        self.assertIn('Connection refused', str(ctx.exception))

    @mock.patch('capture_mac_mcp_catalog.subprocess.run')
    def test_rpc_error_on_required_method_raises_with_code_and_message(self, run):
        broken_tools = {'jsonrpc': '2.0', 'id': 1, 'error': {'code': -32000, 'message': 'boom'}}
        run.return_value = _completed(stdout=_stdout([INIT_OK, broken_tools, RESOURCES_OK, TEMPLATES_OK]))
        with self.assertRaises(RuntimeError) as ctx:
            capture('ai@mini', ['/opt/homebrew/bin/xcodebuildmcp', 'mcp'])
        self.assertIn('-32000', str(ctx.exception))
        self.assertIn('boom', str(ctx.exception))
        self.assertIn('tools/list', str(ctx.exception))

    @mock.patch('capture_mac_mcp_catalog.subprocess.run')
    def test_missing_reply_names_the_method_not_a_bare_keyerror(self, run):
        # tools/list (id=1) never responds — the server crashed mid-session.
        run.return_value = _completed(stdout=_stdout([INIT_OK, RESOURCES_OK, TEMPLATES_OK]))
        with self.assertRaises(RuntimeError) as ctx:
            capture('ai@mini', ['/opt/homebrew/bin/xcodebuildmcp', 'mcp'])
        self.assertIn('tools/list', str(ctx.exception))

    @mock.patch('capture_mac_mcp_catalog.subprocess.run')
    def test_prompts_captured_when_server_offers_them(self, run):
        run.return_value = _completed(stdout=_stdout(
            [INIT_OK, TOOLS_OK, RESOURCES_OK, TEMPLATES_OK, PROMPTS_OK]))
        catalog = capture('ai@mini', ['/opt/homebrew/bin/xcodebuildmcp', 'mcp'])
        self.assertEqual(catalog['prompts']['prompts'][0]['name'], 'greet')

    @mock.patch('capture_mac_mcp_catalog.subprocess.run')
    def test_prompts_method_not_found_is_tolerated_not_fatal(self, run):
        run.return_value = _completed(stdout=_stdout(
            [INIT_OK, TOOLS_OK, RESOURCES_OK, TEMPLATES_OK, PROMPTS_NOT_FOUND]))
        catalog = capture('ai@mini', ['/opt/homebrew/bin/xcodebuildmcp', 'mcp'])
        self.assertNotIn('prompts', catalog)


if __name__ == '__main__':
    unittest.main()
