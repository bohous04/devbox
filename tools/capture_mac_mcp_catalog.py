#!/usr/bin/env python3
"""Captures the discovery responses of a mac MCP server into a catalog for mac-mcp-bridge.

Usage (from the VPS host or from the mac):
    python3 capture_mac_mcp_catalog.py <user>@<mac-tailnet-ip> /opt/homebrew/bin/xcodebuildmcp mcp \
        > /etc/devd/mac-mcp/xcode/catalog.json
"""
import json
import subprocess
import sys

PROTOCOL = '2024-11-05'
# Same shape as DISCOVERY in image/mac-mcp-bridge/bridge.py — {method: (catalog key,
# key in the RPC response)}. The single place where these names live, so capture() and build_catalog()
# cannot diverge on which page they group under which key.
DISCOVERY = {
    'tools/list': ('tools', 'tools'),
    'resources/list': ('resources', 'resources'),
    'resources/templates/list': ('resource_templates', 'resourceTemplates'),
    'prompts/list': ('prompts', 'prompts'),
}
# Prompts are optional — bridge.load_catalog tolerates their complete absence from the catalog
# (bridge.py:39-40). A server that does not support prompts at all typically answers with a JSON-RPC error
# "Method not found", not an empty list — we take that as "no prompts", not as a crash.
OPTIONAL_KEYS = {'prompts'}
METHOD_NOT_FOUND = -32601


def build_catalog(initialize, tools, resources, resource_templates, prompts=None):
    catalog = {'initialize': initialize, 'tools': tools, 'resources': resources,
               'resource_templates': resource_templates}
    if prompts is not None:
        catalog['prompts'] = prompts
    if not isinstance(initialize.get('serverInfo'), dict) or not isinstance(initialize.get('capabilities'), dict):
        raise ValueError('initialize must carry serverInfo and capabilities.')
    # bridge.dispatch() requires the upstream to echo exactly this version on reconnect
    # (otherwise "protocol changed; refresh the discovery catalog") — without this key
    # it would fall back to VERSIONS from bridge.py, which may be a different version than the one the server
    # actually offers, and the message would point the operator at a catalog that is fine.
    protocol_version = initialize.get('protocolVersion')
    if not isinstance(protocol_version, str) or not protocol_version:
        raise ValueError('initialize must carry protocolVersion.')
    catalog['supported_protocol_versions'] = [protocol_version]
    for key, items in DISCOVERY.values():
        if key not in catalog:
            continue  # optional key (prompts) is simply missing — same as in bridge.load_catalog.
        page = catalog[key]
        if not isinstance(page.get(items), list):
            raise ValueError(f'{key} must contain a list of {items}.')
        # The bridge serves one complete page; with nextCursor the agent would not see some tools.
        if page.get('nextCursor'):
            raise ValueError(f'{key} is paginated — the catalog must be complete.')
    return catalog


def capture(target, argv):
    methods = list(DISCOVERY)
    requests = [{'jsonrpc': '2.0', 'id': 0, 'method': 'initialize', 'params': {
        'protocolVersion': PROTOCOL, 'capabilities': {},
        'clientInfo': {'name': 'mac-mcp-catalog', 'version': '1'}}}]
    requests.append({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
    for i, method in enumerate(methods, start=1):
        requests.append({'jsonrpc': '2.0', 'id': i, 'method': method, 'params': {}})
    payload = ''.join(json.dumps(r) + '\n' for r in requests)

    proc = subprocess.run(['ssh', target, *argv], input=payload, capture_output=True,
                          text=True, timeout=180)
    if proc.returncode != 0:
        # The Mini is asleep, wrong host key, wrong server path — without stderr all that would be left is
        # a confusing KeyError from missing responses a few lines below.
        stderr = proc.stderr[-2000:]
        raise RuntimeError(f'ssh {target} exited with code {proc.returncode}: {stderr}')

    replies = {}
    for line in proc.stdout.splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if isinstance(msg.get('id'), int):
            replies[msg['id']] = msg

    def reply(index, method, tolerate_not_found=False):
        msg = replies.get(index)
        if msg is None:
            raise RuntimeError(f'Server did not respond to {method} (id={index}).')
        if 'error' in msg:
            err = msg['error'] or {}
            if tolerate_not_found and err.get('code') == METHOD_NOT_FOUND:
                return None  # the server does not implement this method — not fatal, just missing.
            raise RuntimeError(f'{method} failed: [{err.get("code")}] {err.get("message")}')
        return msg.get('result', {})

    initialize_result = reply(0, 'initialize')
    discovered = {}
    for i, method in enumerate(methods, start=1):
        key, _ = DISCOVERY[method]
        value = reply(i, method, tolerate_not_found=key in OPTIONAL_KEYS)
        if value is not None:
            discovered[key] = value

    return build_catalog(initialize_result, discovered['tools'], discovered['resources'],
                         discovered['resource_templates'], discovered.get('prompts'))


if __name__ == '__main__':
    json.dump(capture(sys.argv[1], sys.argv[2:]), sys.stdout, indent=1)
