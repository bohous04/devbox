#!/usr/bin/env python3
"""Exercise installed Codex -> standalone Code Mode -> exec and MCP offline.

Example (base must be a dedicated, existing directory):
  python3 codex-code-mode-proof.py --binary /opt/codex-devbox/codex --base /tmp/proof

Optional --registry/--dispatcher use exactly one dedicated Docker route whose
container is dev-codex-code-mode-proof and cwd is BASE/workspace. It must already
be running as dev, with only its workspace mounted at /workspace and the same
canonical cwd. Put CODE_MODE_CONTAINER in workspace/sentinel.txt beforehand.
This harness does not create, stop, remove, or restart any container. It writes
only a new run directory under BASE. --expect-missing-host asserts the original
packaging failure instead of success; never remove an installed production host
to exercise that mode. Every Responses request goes to an in-process loopback
fixture, with a fresh CODEX_HOME and no credentials inherited.
"""
import argparse
import grp
import http.server
import json
import os
from pathlib import Path
import runpy
import shlex
import socket
import subprocess
import tempfile
import threading
import uuid


SUPPORT = runpy.run_path(str(Path(__file__).with_name('codex-native-fixture.py')))
StdioRPC = SUPPORT['StdioRPC']
CONTAINER = 'dev-codex-code-mode-proof'
MARKER = 'CODE_MODE_CONTAINER'
MCP = '''import json,os,socket,sys
for line in sys.stdin:
    x=json.loads(line);i=x.get('id');m=x.get('method')
    if i is None:continue
    if m=='initialize':r={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'code-mode-proof','version':'1'}}
    elif m=='tools/list':r={'tools':[{'name':'identity','description':'Credential-free Code Mode identity proof','inputSchema':{'type':'object','properties':{}}}]}
    elif m=='tools/call':r={'content':[{'type':'text','text':json.dumps({'hostname':socket.gethostname(),'cwd':os.getcwd(),'uid':os.getuid()})}]}
    else:r={}
    print(json.dumps({'jsonrpc':'2.0','id':i,'result':r}),flush=True)
'''


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def inspect_route(base, registry, expected_id=None):
    data = json.loads(registry.read_text())
    require(set(data) == {'routes'} and len(data['routes']) == 1,
            'registry must contain exactly one isolated route and no lifecycle URL')
    route = data['routes'][0]
    require(route.get('container') == CONTAINER and route.get('cwd') == str(base / 'workspace'),
            'refusing a route outside the dedicated proof workspace/container')
    info = json.loads(subprocess.check_output(['docker', 'inspect', CONTAINER], text=True))[0]
    require(info['State']['Running'] and info['State']['Status'] == 'running', 'proof container must be running')
    require(not info['HostConfig']['Privileged'], 'proof container must not be privileged')
    require(info['Config']['User'] in ('dev', '1000', '1000:1000'), 'proof container must run as dev')
    require(info['Config']['Hostname'] == CONTAINER, 'proof container hostname mismatch')
    mounts = info['Mounts']
    require(len(mounts) == 2 and {m['Destination'] for m in mounts} == {'/workspace', route['cwd']} and
            all(m['Type'] == 'bind' and m['Source'] == route['cwd'] and m['RW'] for m in mounts),
            'proof container must have only its two exact workspace bind mounts')
    require((base / 'workspace').resolve() == base / 'workspace', 'workspace must be canonical')
    sentinel = base / 'workspace' / 'sentinel.txt'
    require(not sentinel.is_symlink() and sentinel.read_text().strip() == MARKER, 'proof sentinel mismatch')
    if expected_id:
        require(info['Id'] == expected_id, 'proof container was unexpectedly replaced')
    return route, info


class ResponsesFixture:
    def __init__(self, source):
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
                suffix = uuid.uuid4().hex
                if len(owner.requests) == 1:
                    item = {'type': 'custom_tool_call', 'call_id': 'code_mode_probe',
                            'name': 'exec', 'input': source}
                else:
                    item = {'type': 'message', 'id': 'msg_' + suffix, 'role': 'assistant',
                            'phase': 'final_answer', 'content': [{'type': 'output_text', 'text': 'Proof complete.'}]}
                rid = 'resp_' + suffix
                events = [
                    {'type': 'response.created', 'response': {'id': rid}},
                    {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                    {'type': 'response.completed', 'response': {'id': rid,
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--registry', type=Path)
    parser.add_argument('--dispatcher', type=Path)
    parser.add_argument('--expect-missing-host', action='store_true')
    args = parser.parse_args()
    base = args.base.absolute()
    require(base.is_dir() and base.resolve() == base and base != Path('/'), 'base must be an existing canonical directory')
    require(base.stat().st_uid == os.geteuid() and not base.stat().st_mode & 0o022,
            'base must be owned by the caller and not group/world writable')
    require(bool(args.registry) == bool(args.dispatcher), 'registry and dispatcher must be supplied together')
    require(args.binary.is_absolute() and args.binary.is_file(), 'binary must be an absolute installed executable')
    route = info = None
    if args.registry:
        require(os.geteuid() == 0, 'routed proof must start as root and drops app-server to UID 1000')
        require(args.registry.is_absolute() and args.dispatcher.is_absolute(), 'routing paths must be absolute')
        route, info = inspect_route(base, args.registry)
    root = Path(tempfile.mkdtemp(prefix='run-code-mode-', dir=base))
    root.chmod(0o755)
    home = root / 'home'
    home.mkdir(mode=0o700)
    runtime = root / 'runtime'
    runtime.mkdir(mode=0o700)
    cwd = Path(route['cwd']) if route else root
    expected_host = CONTAINER if route else socket.gethostname()
    expected_uid = 1000 if route else os.geteuid()
    command_code = 'import json,os,socket; print(json.dumps({"hostname":socket.gethostname(),"cwd":os.getcwd(),"uid":os.getuid()}))'
    command = 'python3 -c ' + shlex.quote(command_code)
    if route:
        command += ' && cat sentinel.txt'
    source = ('const command = await tools.exec_command(' + json.dumps({'cmd': command, 'yield_time_ms': 1000,
               'max_output_tokens': 500}) + '); text({exec: command});\n'
              'const probe = ALL_TOOLS.find(t => t.name.includes("code_mode_probe") && t.name.endsWith("identity"));\n'
              'if (!probe) throw new Error("Code Mode MCP identity tool missing");\n'
              'text({mcp: await tools[probe.name]({})}); text("CODE_MODE_NESTED_TOOLS_OK");')
    responses = ResponsesFixture(source)
    rpc = None
    proof = {'binary': str(args.binary), 'root': str(root), 'routed': bool(route), 'model_service_used': False}
    try:
        config = SUPPORT['fixture_config'](responses.start()) + (
            '\n[features]\ncode_mode = true\ncode_mode_only = true\ncode_mode_host = true\n'
            '\n[mcp_servers.code_mode_probe]\ncommand = "python3"\nargs = ' + json.dumps(['-u', '-c', MCP]) +
            '\nstartup_timeout_sec = 15\n')
        (home / 'config.toml').write_text(config)
        extra_env = {}
        preexec_fn = None
        if route:
            for path in (home, home / 'config.toml', runtime):
                os.chown(path, 1000, 1000)
            docker_gid = grp.getgrnam('docker').gr_gid

            def as_dev():
                os.setgroups([docker_gid])
                os.setgid(1000)
                os.setuid(1000)

            preexec_fn = as_dev
            extra_env = {'DEVD_CODEX_ROUTES_FILE': str(args.registry),
                         'DEVD_CODEX_EXEC_DISPATCH': str(args.dispatcher),
                         'DEVD_CODEX_RUNTIME_DIR': str(runtime)}
        rpc = StdioRPC(args.binary, home, cwd, extra_env=extra_env, preexec_fn=preexec_fn)
        started = rpc.call('thread/start', {'cwd': str(cwd), 'model': 'gpt-5.4',
            'modelProvider': 'devbox_smoke', 'approvalPolicy': 'never', 'sandbox': 'danger-full-access',
            'ephemeral': True})
        tid = started['thread']['id']
        turn = rpc.call('turn/start', {'threadId': tid, 'input': [{'type': 'text', 'text': 'Run the isolated offline Code Mode proof.'}]})
        completed = rpc.read_until(lambda x: x.get('method') == 'turn/completed' and
            x['params']['threadId'] == tid and x['params']['turn']['id'] == turn['turn']['id'])
        require(completed['params']['turn']['status'] == 'completed', 'fixture turn failed: ' + repr(completed))
        require(len(responses.requests) == 2, 'expected exactly one tool call and one final fixture response')
        output = next(x['output'] for x in responses.requests[-1]['input']
                      if x.get('type') == 'custom_tool_call_output' and x.get('call_id') == 'code_mode_probe')
        output_text = output if isinstance(output, str) else json.dumps(output)
        items = [x['params']['item'] for x in rpc.events if x.get('method') == 'item/completed']
        commands = [x for x in items if x.get('type') == 'commandExecution']
        mcps = [x for x in items if x.get('type') == 'mcpToolCall']
        if args.expect_missing_host:
            host_missing = ('codex-code-mode-host' in output_text and
                            ('host executable was not found' in output_text or
                             'No such file or directory (os error 2)' in output_text))
            require(not (args.binary.resolve().parent / 'codex-code-mode-host').exists(),
                    'negative proof requires an already missing sibling host')
            require(host_missing and not commands and not mcps,
                    'original missing-host failure was not reproduced: ' + output_text)
            proof['missing_host_reproduced'] = True
        else:
            require('CODE_MODE_NESTED_TOOLS_OK' in output_text, 'Code Mode did not finish nested calls: ' + output_text)
            require(len(commands) == 1 and commands[0].get('exitCode') == 0 and commands[0].get('status') == 'completed',
                    'nested exec did not succeed: ' + repr(commands))
            command_output = commands[0]['aggregatedOutput']
            identity = json.loads(command_output.splitlines()[0])
            expected = {'hostname': expected_host, 'cwd': str(cwd), 'uid': expected_uid}
            require(identity == expected and commands[0]['cwd'] == str(cwd), 'nested exec ran in wrong environment: ' + repr(identity))
            if route:
                require(MARKER in command_output, 'nested exec missed container sentinel')
            require(len(mcps) == 1 and mcps[0].get('status') == 'completed' and not mcps[0].get('error'),
                    'nested MCP did not succeed: ' + repr(mcps))
            require(json.loads(mcps[0]['result']['content'][0]['text']) == expected, 'nested MCP ran in wrong environment')
            require('Code Mode is unavailable' not in json.dumps(rpc.events), 'availability warning remained')
            proof.update({'code_mode': True, 'nested_exec': identity, 'nested_mcp': True})
        if route:
            inspect_route(base, args.registry, info['Id'])
        proof['passed'] = True
    finally:
        if rpc:
            rpc.close()
            proof['events'] = rpc.events
            proof['stderr'] = rpc.stderr.decode(errors='replace')
        proof['responses_requests'] = responses.requests
        responses.close()
        (root / 'evidence.json').write_text(json.dumps(proof, indent=2))
    print(json.dumps({k: v for k, v in proof.items() if k not in ('events', 'stderr', 'responses_requests')}))


if __name__ == '__main__':
    main()
