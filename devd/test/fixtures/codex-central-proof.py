#!/usr/bin/env python3
"""Prove native central Codex routing with a deterministic loopback model.

Run as root on an isolated Linux Docker host. Before running, create the two
running containers dev-codex-unified-a and dev-codex-unified-b, with matching
hostnames, user dev (UID 1000), and ONLY a writable bind from BASE/workspaces/a
or b to /workspace. Each directory must contain sentinel.txt with CONTAINER_A
or CONTAINER_B. Optional PROBE_CONTAINER_ENV is asserted when configured.

The harness never creates containers. It stops only the validated A container;
an actual model turn must restart it through the dispatcher. It writes fixture
files only in the validated workspaces and a fresh BASE/run-* directory, keeps
all evidence, and leaves both test containers running after success. No real
model service, credentials, production registry, or production home is used.
The binary must include its installed native resources (especially exec-server).
"""
import argparse
import grp
import http.server
import json
import os
from pathlib import Path
import runpy
import subprocess
import threading
import time
import uuid


fixture = runpy.run_path(str(Path(__file__).with_name('codex-native-fixture.py')))
StdioRPC = fixture['StdioRPC']
NAMES = {c: 'dev-codex-unified-' + c for c in 'ab'}
MCP = '''import json,os,socket,sys
for line in sys.stdin:
    x=json.loads(line);i=x.get('id');m=x.get('method')
    if i is None:continue
    if m=='initialize':r={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'probe','version':'1'}}
    elif m=='tools/list':r={'tools':[{'name':'identity','description':'Isolated deterministic identity fixture','inputSchema':{'type':'object','properties':{}}}]}
    elif m=='tools/call':r={'content':[{'type':'text','text':json.dumps({'hostname':socket.gethostname(),'cwd':os.getcwd(),'home':os.getenv('HOME'),'marker':open('/workspace/sentinel.txt').read().strip(),'container_env':os.getenv('PROBE_CONTAINER_ENV')})}]}
    else:r={}
    print(json.dumps({'jsonrpc':'2.0','id':i,'result':r}),flush=True)
'''
HOOK = '''import json,os,socket,sys
payload=json.load(sys.stdin)
with open('/workspace/hook-proof.jsonl','a') as f:f.write(json.dumps({'hostname':socket.gethostname(),'cwd':os.getcwd(),'override':os.getenv('PROBE_OVERRIDE'),'home':os.getenv('HOME'),'event':payload.get('hook_event_name')})+'\\n')
'''


def require(condition, detail):
    # Do not let python -O disable proof or safety assertions.
    if not condition:
        raise AssertionError(detail)


def inspect_containers(base, expected_ids=None, require_running=False):
    """Read-only guard, called before any fixture writes and before each turn."""
    data = json.loads(subprocess.check_output(
        ['docker', 'inspect', *NAMES.values()], text=True))
    require(len(data) == 2, 'expected exactly the two named proof containers')
    found = {d['Name'].lstrip('/'): d for d in data}
    require(set(found) == set(NAMES.values()), 'unexpected Docker container names')
    result = {}
    for c, name in NAMES.items():
        d = found[name]
        workspace = base / 'workspaces' / c
        require(workspace.is_dir() and workspace.resolve() == workspace,
                'proof workspace must be an existing canonical directory: ' + str(workspace))
        mounts = d.get('Mounts', [])
        require(len(mounts) == 1 and mounts[0].get('Type') == 'bind' and
                mounts[0].get('Source') == str(workspace) and
                mounts[0].get('Destination') == '/workspace' and mounts[0].get('RW') is True,
                name + ' must have only its exact writable proof workspace bind')
        require(d['Config'].get('Hostname') == name, name + ' hostname mismatch')
        require(d['Config'].get('User') in ('dev', '1000', '1000:1000'),
                name + ' must run as dev / UID 1000')
        require(not d.get('HostConfig', {}).get('Privileged'), name + ' must not be privileged')
        if expected_ids:
            require(d['Id'] == expected_ids[c], name + ' was replaced during the proof')
        if require_running:
            require(d.get('State', {}).get('Running'), name + ' must already be running')
        require((workspace / 'sentinel.txt').read_text().strip() == 'CONTAINER_' + c.upper(),
                name + ' sentinel mismatch')
        # Do not overwrite/follow existing fixture symlinks outside the bound workspace.
        for filename in ('probe-mcp.py', 'probe-hook.py', 'hook-proof.jsonl', 'sentinel.txt'):
            path = workspace / filename
            require(not path.is_symlink(), 'fixture file must not be a symlink: ' + str(path))
            require(not path.exists() or (path.is_file() and path.stat().st_nlink == 1),
                    'fixture file must be a plain file with one link: ' + str(path))
        result[c] = d
    return result


class ResponsesFixture:
    def __init__(self):
        self.requests = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                if self.path != '/v1/responses':
                    self.send_error(404)
                    return
                request = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
                owner.requests.append(request)
                items = request.get('input', [])
                last_user = max((i for i, x in enumerate(items) if x.get('role') == 'user'), default=-1)
                results = [x for x in items[last_user + 1:]
                           if x.get('type') in ('function_call_output', 'custom_tool_call_output')]
                suffix = uuid.uuid4().hex
                if not results:
                    item = {'type': 'function_call', 'id': 'fc_' + suffix, 'call_id': 'call_' + suffix,
                            'name': 'exec_command', 'arguments': json.dumps({
                                'cmd': 'pwd; hostname; cat sentinel.txt; printf "uid="; id -u; '
                                       'printf "home="; printenv HOME; printf "codex_home="; printenv CODEX_HOME',
                                'yield_time_ms': 1000, 'max_output_tokens': 500})}
                elif len(results) == 1 and not any(
                        x.get('type') == 'tool_search_call' for x in items[last_user + 1:]):
                    item = {'type': 'tool_search_call', 'call_id': 'call_' + suffix, 'execution': 'client',
                            'arguments': {'query': 'probe identity hostname container marker', 'limit': 5}}
                elif len(results) == 1:
                    item = {'type': 'function_call', 'id': 'fc_' + suffix, 'call_id': 'call_' + suffix,
                            'namespace': 'mcp__probe', 'name': 'identity', 'arguments': '{}'}
                elif len(results) == 2:
                    item = {'type': 'custom_tool_call', 'call_id': 'call_' + suffix, 'name': 'apply_patch',
                            'input': '*** Begin Patch\n*** Add File: patch-' + suffix +
                                     '.txt\n+native patch fixture\n*** End Patch\n'}
                else:
                    item = {'type': 'message', 'id': 'msg_' + suffix, 'role': 'assistant',
                            'phase': 'final_answer', 'content': [
                                {'type': 'output_text', 'text': 'Fixture complete.'}]}
                response_id = 'resp_' + suffix
                events = [
                    {'type': 'response.created', 'response': {'id': response_id}},
                    {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                    {'type': 'response.completed', 'response': {'id': response_id,
                     'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}]
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                for event in events:
                    self.wfile.write(('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n').encode())
                    self.wfile.flush()

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self.thread.start()
        return 'http://127.0.0.1:' + str(self.server.server_port) + '/v1'

    def close(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()


def write_registry(path, routes):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps({'routes': routes}))
    temporary.chmod(0o644)
    temporary.replace(path)


def run(args):
    require(os.geteuid() == 0, 'run as root on an isolated Linux Docker host')
    base = Path(args.base).resolve(strict=True)
    binary = Path(args.binary).resolve(strict=True)
    dispatcher = Path(args.dispatcher).resolve(strict=True)
    require(base.is_dir() and base.stat().st_uid == 0 and not base.stat().st_mode & 0o022,
            'base must be a root-owned directory, not writable by group or others')
    require(binary.is_file() and os.access(binary, os.X_OK), 'binary must be executable')
    require(dispatcher.is_file() and os.access(dispatcher, os.X_OK), 'dispatcher must be executable')
    docker_gid = grp.getgrnam('docker').gr_gid
    containers = inspect_containers(base, require_running=True)  # Before ANY mutation.
    container_ids = {c: d['Id'] for c, d in containers.items()}
    expected_env = {c: next((v.split('=', 1)[1] for v in d['Config'].get('Env', [])
                            if v.startswith('PROBE_CONTAINER_ENV=')), None)
                    for c, d in containers.items()}
    root = base / ('run-' + str(int(time.time())) + '-' + uuid.uuid4().hex[:8])
    root.mkdir(mode=0o755)  # Registry parent stays owned by root; daemon cannot replace it.
    home = root / 'home'
    home.mkdir(mode=0o700)
    runtime = root / 'runtime'
    runtime.mkdir(mode=0o700)
    for path in (home, runtime):
        os.chown(path, 1000, 1000)
    routes = [{'cwd': str(base / 'workspaces' / c), 'container': NAMES[c],
               'environment_id': 'devbox_' + NAMES[c], 'thread_ids': []} for c in 'ab']
    registry = root / 'routes.json'
    write_registry(registry, routes[:1])
    responses = ResponsesFixture()
    url = responses.start()
    config = fixture['fixture_config'](url) + (
        '\n[mcp_servers.probe]\ncommand = "python3"\nargs = ["-u", "/workspace/probe-mcp.py"]\n'
        'env_vars = ["PROBE_CONTAINER_ENV"]\nstartup_timeout_sec = 15\n')
    (home / 'config.toml').write_text(config)
    (home / 'hooks.json').write_text(json.dumps({'hooks': {'UserPromptSubmit': [{'hooks': [{
        'type': 'command', 'command': 'PROBE_OVERRIDE=explicit-hook-value python3 /workspace/probe-hook.py',
        'timeout': 10, 'env': {'PROBE_OVERRIDE': 'explicit-hook-value'}}]}]}}))
    for path in home.iterdir():
        os.chown(path, 1000, 1000)
    hook_offsets = {}
    for c in 'ab':
        workspace = base / 'workspaces' / c
        (workspace / 'probe-mcp.py').write_text(MCP)
        (workspace / 'probe-hook.py').write_text(HOOK)
        hook_path = workspace / 'hook-proof.jsonl'
        hook_offsets[c] = len(hook_path.read_text().splitlines()) if hook_path.exists() else 0

    def as_dev():
        os.setgroups([docker_gid])
        os.setgid(1000)
        os.setuid(1000)

    def open_rpc():
        return StdioRPC(binary, home, base, preexec_fn=as_dev, extra_env={
            'DEVD_CODEX_ROUTES_FILE': str(registry),
            'DEVD_CODEX_EXEC_DISPATCH': str(dispatcher),
            'DEVD_CODEX_HOOK_DISPATCH': str(dispatcher),
            'DEVD_CODEX_RUNTIME_DIR': str(runtime)})

    proof = {'root': str(root), 'binary': str(binary), 'dispatcher': str(dispatcher),
             'threads': {}, 'container_ids': container_ids, 'daemon_runs': []}

    def close_rpc(rpc):
        rpc.close()
        proof['daemon_runs'].append({'events': rpc.events, 'stderr': rpc.stderr.decode(errors='replace')})

    def turn(rpc, c, label):
        inspect_containers(base, container_ids)
        thread_id = proof['threads'][c]
        start_index = len(rpc.events)
        started = rpc.call('turn/start', {'threadId': thread_id,
                           'input': [{'type': 'text', 'text': 'Local fixture ' + label}]})
        turn_id = started['turn']['id']
        completed = rpc.read_until(lambda x: x.get('method') == 'turn/completed' and
            x['params']['threadId'] == thread_id and x['params']['turn']['id'] == turn_id)
        require(completed['params']['turn']['status'] == 'completed', repr(completed))
        items = [x['params']['item'] for x in rpc.events[start_index:] if x.get('method') == 'item/completed']
        commands = [x for x in items if x.get('type') == 'commandExecution']
        require(len(commands) == 1 and commands[0].get('status') == 'completed' and
                commands[0].get('exitCode') == 0, 'missing successful command: ' + repr(commands))
        command = commands[0]
        output = command.get('aggregatedOutput', '')
        cwd = str(base / 'workspaces' / c)
        require(command.get('cwd') == cwd and output.splitlines()[0] == cwd and
                NAMES[c] in output and 'CONTAINER_' + c.upper() in output and
                'uid=1000' in output and 'home=/home/dev\n' in output and
                'codex_home=/home/dev/.codex' in output, 'command routed incorrectly: ' + output)
        mcp = [x for x in items if x.get('type') == 'mcpToolCall']
        require(len(mcp) == 1 and mcp[0].get('status') == 'completed' and not mcp[0].get('error'),
                'missing successful MCP: ' + repr(mcp))
        identity = json.loads(mcp[0]['result']['content'][0]['text'])
        require(identity['hostname'] == NAMES[c] and identity['cwd'] == cwd and
                identity['home'] == '/home/dev' and identity['marker'] == 'CONTAINER_' + c.upper(),
                'MCP routed incorrectly: ' + repr(identity))
        if expected_env[c] is not None:
            require(identity['container_env'] == expected_env[c], 'MCP lost container environment')
        patches = [x for x in items if x.get('type') == 'fileChange']
        require(len(patches) == 1 and patches[0].get('status') == 'completed',
                'missing successful patch: ' + repr(patches))
        require(len(patches[0]['changes']) == 1, 'expected one fixture patch')
        patch = Path(patches[0]['changes'][0]['path'])
        require(patch.parent == Path(cwd) and patch.name.startswith('patch-') and
                patch.read_text() == 'native patch fixture\n', 'patch routed incorrectly: ' + str(patch))
        print(json.dumps({'phase': label, 'container': c, 'exec': 'completed',
                          'mcp': 'completed', 'patch': 'completed'}), flush=True)
        return items

    rpc = None
    try:
        rpc = open_rpc()
        hook_data = rpc.call('hooks/list', {'cwds': [r['cwd'] for r in routes]})
        edits = {h['key']: h['currentHash'] for entry in hook_data['data'] for h in entry['hooks']
                 if h.get('trustStatus') in ('untrusted', 'modified')}
        require(edits, 'fixture hook was not discovered')
        rpc.call('config/batchWrite', {'edits': [
            {'keyPath': 'hooks.state.' + json.dumps(key) + '.trusted_hash', 'value': value,
             'mergeStrategy': 'upsert'} for key, value in edits.items()], 'reloadUserConfig': True})
        for c, route in zip('ab', routes):
            if c == 'b':
                write_registry(registry, routes)  # New route discovered by an already running daemon.
            started = rpc.call('thread/start', {'cwd': route['cwd'], 'model': 'gpt-5.4',
                'modelProvider': 'devbox_smoke', 'approvalPolicy': 'never', 'sandbox': 'danger-full-access',
                'historyMode': 'paginated', 'ephemeral': False})
            proof['threads'][c] = started['thread']['id']
            proof['first_' + c] = turn(rpc, c, 'first ' + c)
        inspect_containers(base, container_ids)
        subprocess.run(['docker', 'stop', '-t', '2', container_ids['a']], check=True, stdout=subprocess.DEVNULL)
        proof['list_after_stop'] = rpc.call('thread/list', {'limit': 100, 'sourceKinds': []})
        listed = {t['id'] for t in proof['list_after_stop']['data']}
        require(set(proof['threads'].values()) <= listed, 'stopped container history disappeared')
        rpc.call('mcpServerStatus/list', {})
        time.sleep(3)
        proof['stays_stopped'] = not inspect_containers(base, container_ids)['a']['State']['Running']
        require(proof['stays_stopped'], 'background RPC restarted stopped executor')
        proof['restart_a'] = turn(rpc, 'a', 'after docker stop')
        require(inspect_containers(base, container_ids)['a']['State']['Running'], 'turn did not restart A')
        contender = open_rpc()
        try:
            try:
                contender.call('thread/resume', {'threadId': proof['threads']['a'],
                    'approvalPolicy': 'never', 'sandbox': 'danger-full-access'})
            except RuntimeError as error:
                proof['writer_lock_refusal'] = str(error)
                require('already has an active writer' in str(error), 'resume failed for another reason: ' + str(error))
            else:
                raise AssertionError('second app-server acquired an already-owned thread')
        finally:
            close_rpc(contender)
        close_rpc(rpc)
        rpc = None
        rpc = open_rpc()
        for c in 'ab':
            thread_id = proof['threads'][c]
            resumed = rpc.call('thread/resume', {'threadId': thread_id,
                'approvalPolicy': 'never', 'sandbox': 'danger-full-access'})
            require(resumed['thread']['id'] == thread_id and resumed['thread']['historyMode'] == 'paginated',
                    'resume lost thread identity or history mode')
            proof['resumed_' + c] = resumed['cwd']
            require(resumed['cwd'] == str(base / 'workspaces' / c), 'resume lost canonical cwd')
            proof['after_server_restart_' + c] = turn(rpc, c, 'after host restart ' + c)
            page = rpc.call('thread/turns/list', {'threadId': thread_id, 'limit': 20})
            proof['history_' + c] = page
            require(len(page['data']) == (3 if c == 'a' else 2), 'paginated history lost turns')
        for c in 'ab':
            hook_path = base / 'workspaces' / c / 'hook-proof.jsonl'
            hooks = [json.loads(line) for line in hook_path.read_text().splitlines()[hook_offsets[c]:]]
            require(len(hooks) == (3 if c == 'a' else 2), 'missing or duplicate prompt hooks: ' + repr(hooks))
            require(all(h['hostname'] == NAMES[c] and h['cwd'] == str(base / 'workspaces' / c) and
                        h['override'] == 'explicit-hook-value' and h['home'] == '/home/dev' and
                        h['event'] == 'UserPromptSubmit' for h in hooks), 'hook routed incorrectly: ' + repr(hooks))
            proof['hooks_' + c] = hooks
        proof['success'] = True
        print(json.dumps({'success': True, 'root': str(root), 'stays_stopped': True,
                          'threads': proof['threads'], 'exec': 'completed', 'mcp': 'completed',
                          'patch': 'completed', 'hooks': 'verified', 'writer_lock': 'verified',
                          'history': 'paginated, 3 + 2 turns'}), flush=True)
    except BaseException as error:
        proof['error'] = str(error)
        print(json.dumps({'success': False, 'root': str(root), 'error': str(error)}), flush=True)
        raise
    finally:
        if rpc:
            close_rpc(rpc)
        proof['requests'] = responses.requests
        (root / 'evidence.json').write_text(json.dumps(proof, indent=2))
        responses.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True, help='existing isolated proof directory containing workspaces/a and b')
    parser.add_argument('--binary', required=True, help='installed patched Codex binary with matching resources')
    parser.add_argument('--dispatcher', required=True, help='trusted executable infra/codex-remote/dispatch.py')
    run(parser.parse_args())


if __name__ == '__main__':
    main()
