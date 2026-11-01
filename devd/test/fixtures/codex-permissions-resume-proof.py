#!/usr/bin/env python3
"""Cold-restart a private devbox thread and verify its exact permissions.

Requires the isolated container/registry contract of codex-code-mode-proof.py.
Only the fixture's own app-server processes are stopped. Uses a deterministic
loopback provider and unannotated MCP tool, with no accounts or production data.
--expect-lost-permissions reproduces the old cold-resume bug. Explicit read-only
resume must still win over saved YOLO in both versions.
"""
import argparse
import grp
import json
import os
from pathlib import Path
import runpy
import tempfile


SUPPORT = runpy.run_path(str(Path(__file__).with_name('codex-code-mode-proof.py')))
require = SUPPORT['require']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--dispatcher', type=Path, required=True)
    parser.add_argument('--expect-lost-permissions', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'routed proof starts as root and drops to UID 1000')
    base = args.base.resolve(strict=True)
    require(base == args.base and base.stat().st_uid == 0 and not base.stat().st_mode & 0o022,
            'base must be a canonical root-owned dedicated directory')
    route, container = SUPPORT['inspect_route'](base, args.registry)
    root = Path(tempfile.mkdtemp(prefix='cold-resume-', dir=base))
    root.chmod(0o755)
    home, runtime = root / 'home', root / 'runtime'
    for path in (home, runtime):
        path.mkdir(mode=0o700)
        os.chown(path, 1000, 1000)
    code = '''
const matches = ALL_TOOLS.filter(t => t.name.includes("code_mode_probe") && t.name.endsWith("identity"));
if (matches.length !== 1) throw new Error("Expected fixture identity MCP tool");
text(await tools[matches[0].name]({}));
'''
    responses = SUPPORT['ResponsesFixture'](code)
    proof = {'binary': str(args.binary), 'root': str(root), 'phases': [], 'real_model_used': False}
    rpc = None
    docker_gid = grp.getgrnam('docker').gr_gid

    def as_dev():
        os.setgroups([docker_gid])
        os.setgid(1000)
        os.setuid(1000)

    def connect():
        return SUPPORT['StdioRPC'](args.binary, home, route['cwd'], preexec_fn=as_dev, extra_env={
            'DEVD_CODEX_ROUTES_FILE': str(args.registry),
            'DEVD_CODEX_EXEC_DISPATCH': str(args.dispatcher),
            'DEVD_CODEX_RUNTIME_DIR': str(runtime)})

    def turn(tid, phase, allowed, settings):
        responses.requests.clear()
        offset = len(rpc.events)
        result = rpc.call('turn/start', {'threadId': tid, 'input': [{
            'type': 'text', 'text': 'Run only the offline fixture identity tool.'}]})
        done = rpc.read_until(lambda x: x.get('method') == 'turn/completed' and
            x['params']['threadId'] == tid and x['params']['turn']['id'] == result['turn']['id'])
        require(done['params']['turn']['status'] == 'completed', 'fixture turn did not complete')
        calls = [x['params']['item'] for x in rpc.events[offset:]
                 if x.get('method') == 'item/completed' and x['params']['item'].get('type') == 'mcpToolCall']
        require(len(calls) == 1, 'expected exactly one nested MCP call')
        call = calls[0]
        if allowed:
            require(call['status'] == 'completed' and not call.get('error'), 'MCP unexpectedly denied: ' + repr(call))
            identity = json.loads(call['result']['content'][0]['text'])
            require(identity == {'hostname': SUPPORT['CONTAINER'], 'cwd': route['cwd'], 'uid': 1000},
                    'MCP executed in the wrong environment')
        else:
            require(call['status'] == 'failed' and 'approval policy is never' in json.dumps(call.get('error')),
                    'expected MCP permission denial: ' + repr(call))
        proof['phases'].append({'phase': phase, 'sandbox': settings['sandbox'],
            'approval_policy': settings['approvalPolicy'], 'mcp_allowed': allowed})

    try:
        config = SUPPORT['SUPPORT']['fixture_config'](responses.start()).replace(
            'sandbox_mode = "danger-full-access"', 'sandbox_mode = "workspace-write"') + (
            '\n[features]\ncode_mode = true\ncode_mode_only = true\ncode_mode_host = true\n'
            '\n[mcp_servers.code_mode_probe]\ncommand = "python3"\nargs = ' +
            json.dumps(['-u', '-c', SUPPORT['MCP']]) + '\nstartup_timeout_sec = 15\n')
        (home / 'config.toml').write_text(config)
        os.chown(home / 'config.toml', 1000, 1000)
        rpc = connect()
        started = rpc.call('thread/start', {'cwd': route['cwd'], 'approvalPolicy': 'never',
            'sandbox': 'danger-full-access', 'ephemeral': False})
        tid = started['thread']['id']
        require(started['sandbox']['type'] == 'dangerFullAccess', 'initial YOLO not applied')
        turn(tid, 'initial_yolo', True, started)
        rpc.close()
        rpc = connect()  # New process, exact same saved thread, ID-only resume.
        resumed = rpc.call('thread/resume', {'threadId': tid})
        expected = 'workspaceWrite' if args.expect_lost_permissions else 'dangerFullAccess'
        require(resumed['sandbox']['type'] == expected, 'unexpected restored sandbox: ' + repr(resumed['sandbox']))
        turn(tid, 'cold_resume', not args.expect_lost_permissions, resumed)
        rpc.close()
        rpc = connect()
        overridden = rpc.call('thread/resume', {'threadId': tid, 'sandbox': 'read-only'})
        require(overridden['sandbox']['type'] == 'readOnly', 'explicit restriction did not win')
        turn(tid, 'explicit_read_only', False, overridden)
        SUPPORT['inspect_route'](base, args.registry, container['Id'])
        proof['passed'] = True
    finally:
        if rpc:
            rpc.close()
        responses.close()
        (root / 'evidence.json').write_text(json.dumps(proof, indent=2) + '\n')
    print(json.dumps(proof))


if __name__ == '__main__':
    main()
