#!/usr/bin/env python3
"""Verify the reported read-only MCP calls through a running native app-server.

Uses a fresh ephemeral thread and a deterministic loopback Responses provider.
It inherits the selected project's existing MCP configuration, never reads or
copies credentials, never edits a work item/timer, and retains only statuses.
Run only against an authorized project. --expect-denied reproduces the managed
permissions / never-approval conflict without changing any existing thread.
"""
import argparse
import json
from pathlib import Path
import runpy
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--rpc-module', required=True, type=Path)
    parser.add_argument('--cwd', required=True)
    parser.add_argument('--expect-denied', action='store_true')
    args = parser.parse_args()
    Rpc = runpy.run_path(str(args.rpc_module))['Rpc']
    fixture = runpy.run_path(str(Path(__file__).with_name('codex-code-mode-proof.py')))
    calls = [
        {'server': 'acme', 'tool': 'workitem', 'args': {
            'action': 'retrieve_by_identifier', 'work_item_identifier': 'SHOP-94',
            'expand': 'assignees,state'}},
        {'server': 'time_tracking', 'tool': 'list_running_entries', 'args': {}},
        {'server': 'time_tracking', 'tool': 'list_catalog', 'args': {
            'kind': 'projects', 'query': 'shop'}},
    ]
    source = 'const calls = ' + json.dumps(calls) + ';\n' + '''
for (const call of calls) {
  const matches = ALL_TOOLS.filter(t => t.name.includes(call.server) && t.name.endsWith(call.tool));
  if (matches.length !== 1) throw new Error("Expected one tool: " + call.tool);
  try {
    await tools[matches[0].name](call.args);
    text({tool: call.tool, dispatched: true});
  } catch (error) {
    text({tool: call.tool, denied: String(error).includes("approval policy is never")});
  }
}
'''
    responses = fixture['ResponsesFixture'](source)

    class AuditRpc(Rpc):
        def __init__(self, *pos, **kw):
            self.completed = []
            self.turns = []
            self.tid = None
            super().__init__(*pos, **kw)

        def receive(self):
            message = super().receive()
            params = message.get('params', {})
            if params.get('threadId') == self.tid:
                if message.get('method') == 'item/completed':
                    item = params['item']
                    if item.get('type') == 'mcpToolCall':
                        # Keep no work-item contents, account data, or timer rows.
                        error = item.get('error')
                        result = item.get('result') or {}
                        self.completed.append({'server': item.get('server'),
                            'tool': item.get('tool'), 'status': item.get('status'),
                            'has_error': bool(error) or bool(result.get('isError')),
                            'approval_denied': 'approval policy is never' in json.dumps(error)})
                elif message.get('method') == 'turn/completed':
                    self.turns.append(params['turn'])
            return message

    rpc = None
    try:
        url = responses.start()
        rpc = AuditRpc(args.socket, timeout=60)
        started = rpc.call('thread/start', {
            'cwd': args.cwd, 'model': 'gpt-5.4', 'modelProvider': 'devbox_mcp_read_proof',
            'approvalPolicy': 'never',
            'sandbox': 'workspace-write' if args.expect_denied else 'danger-full-access',
            'ephemeral': True,
            'config': {
                'model_providers.devbox_mcp_read_proof': {
                    'name': 'Local read-only MCP proof', 'base_url': url,
                    'wire_api': 'responses', 'requires_openai_auth': False,
                    'supports_websockets': False},
                'features.code_mode': True, 'features.code_mode_only': True,
                'features.code_mode_host': True},
        })
        rpc.tid = started['thread']['id']
        rpc.call('turn/start', {'threadId': rpc.tid, 'input': [{
            'type': 'text', 'text': 'Run the three read-only MCP diagnostics; do not modify any work item or timer.'}]})
        deadline = time.monotonic() + 120
        while not rpc.turns and time.monotonic() < deadline:
            rpc.receive()
        if not rpc.turns or rpc.turns[-1]['status'] != 'completed':
            raise RuntimeError('Read-only diagnostic turn did not complete')
        if len(rpc.completed) != len(calls):
            raise RuntimeError('Expected three MCP calls; got ' + json.dumps(rpc.completed))
        passed = (all(c['approval_denied'] for c in rpc.completed) if args.expect_denied else
                  all(c['status'] == 'completed' and not c['has_error'] for c in rpc.completed))
        print(json.dumps({'passed': passed, 'expected_denial': args.expect_denied,
                          'calls': rpc.completed, 'real_model_used': False}))
        if not passed:
            raise RuntimeError('MCP read-only verification failed')
    finally:
        if rpc:
            if rpc.tid:
                rpc.call('thread/unsubscribe', {'threadId': rpc.tid})
            rpc.close()
        responses.close()


if __name__ == '__main__':
    main()
