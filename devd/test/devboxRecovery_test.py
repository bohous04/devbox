import importlib.machinery
import importlib.util
import contextlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid
import types

SOURCE = Path(__file__).resolve().parents[2] / 'image/devbox-recovery'
loader = importlib.machinery.SourceFileLoader('devbox_recovery', str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
r = importlib.util.module_from_spec(spec)
loader.exec_module(r)
SID = '11111111-1111-4111-8111-111111111111'


def pane(agent='claude', event='prompt_submit', account='default'):
    env = {'CLAUDE_CONFIG_DIR': '/home/dev/.claude'} if agent == 'claude' else {'GROK_HOME': '/home/dev/.grok'}
    if agent == 'codex':
        env = {'CODEX_HOME': '/home/dev/.codex', 'DEVD_CODEX_ACCOUNT_ID': account}
    return {'state': {'agent': agent, 'session_id': SID, 'event': event},
            'context': {'runtime': agent, 'profile': agent, 'env': env}}


class PolicyTests(unittest.TestCase):
    def test_exact_resume_only_and_waits_are_never_continued(self):
        for agent in ('claude', 'codex', 'grok'):
            for event in ('permission_request', 'idle_prompt', 'stop', 'stop_failure', 'session_start'):
                result = r.resume_plan(pane(agent, event))
                self.assertFalse(result['active'])
                self.assertIn(SID, result['argv'])
                self.assertNotIn('--continue', result['argv'])
                self.assertNotIn('--last', result['argv'])
            self.assertTrue(r.resume_plan(pane(agent))['active'])
        self.assertIsNone(r.resume_plan(pane('codex', account='')))
        invalid = pane()
        invalid['state']['session_id'] = 'title-or-latest'
        self.assertIsNone(r.resume_plan(invalid))
        invalid = pane('grok')
        invalid['context']['profile'] = 'codex'
        self.assertIsNone(r.resume_plan(invalid))
        self.assertTrue(r.interactive_launch('codex', ['-p', 'restricted', 'resume', SID]))

    def test_journal_agent_prefers_recorded_agent_then_entry_pane_profile(self):
        entry = {'session_name': 'main', 'window_index': 0, 'pane_index': 0, '@devd_agent': 'claude'}
        other = {'session_name': 'main-2', 'window_index': 0, 'pane_index': 0, '@devd_agent': 'grok'}
        self.assertEqual(r.journal_agent({'agent': 'codex', 'panes': [entry]}), 'codex')
        self.assertEqual(r.journal_agent({'panes': [other, entry]}), 'claude')
        self.assertIsNone(r.journal_agent({'panes': [dict(entry, **{'@devd_agent': ''})]}))
        with patch.dict(os.environ, {'DEVD_AGENT': ''}):
            self.assertEqual(r.current_agent(), 'claude')

    def test_nested_helpers_never_replace_parent_state(self):
        with patch.object(r.os, 'isatty', return_value=True), patch.object(r, 'tmux') as tmux:
            for agent, args in [('codex', ['exec', 'task']), ('codex', ['app-server']),
                                ('claude', ['-p', 'task']), ('grok', ['-p', 'task']),
                                ('codex', ['resume', SID, '--help'])]:
                r.record_launch(agent, args)
            tmux.assert_not_called()
        with patch.object(r.os, 'isatty', return_value=False), patch.object(r, 'tmux') as tmux:
            r.record_launch('codex', ['resume', SID])
            tmux.assert_not_called()

    def test_journal_never_contains_credentials_or_prompts(self):
        filtered = r.clean_env({'CODEX_HOME': '/home/dev/.codex', 'XAI_API_KEY': 'secret',
                                'ANTHROPIC_AUTH_TOKEN': 'secret', 'prompt': 'private text'})
        self.assertEqual(filtered, {'CODEX_HOME': '/home/dev/.codex'})

    def test_inner_docker_uses_ids_only_and_refuses_other_daemon(self):
        identifier = 'a' * 64
        saved = {'docker': {'daemon': 'same', 'ids': [identifier]}}
        with patch.object(r, 'docker_snapshot', return_value={'daemon': 'other', 'ids': []}), patch.object(r, 'run') as run:
            with self.assertRaises(ValueError):
                r.restore_docker(saved)
            run.assert_not_called()
        with patch.object(r, 'docker_snapshot', return_value={'daemon': 'same', 'ids': []}), patch.object(r, 'run', side_effect=['exited', '']) as run:
            r.restore_docker(saved)
            self.assertEqual(run.call_args.args[0], ['docker', 'start', identifier])
        with patch.object(r, 'docker_snapshot', return_value={'daemon': 'same', 'ids': []}), patch.object(r, 'run', return_value=''):
            with self.assertRaisesRegex(ValueError, 'missing'):
                r.restore_docker(saved)

    def test_existing_proxy_profile_boolean_is_not_a_model_profile(self):
        p = dict(pane(), pane_id='%1', pane_pid='12', **{'@devd_agent': 'claude-gpt'})
        env = {'TMUX_PANE': '%1', 'DEVBOX_PROXY_PROFILE': '1', 'DEVD_LAUNCH_PROFILE': 'claude-gpt',
               'CLAUDE_CONFIG_DIR': '/home/dev/.claude', 'DEVD_AGENT_MODEL': 'gpt-model'}
        with patch.object(r, 'nearest_agent', return_value=(12, 'claude')), patch.object(r, 'process_env', return_value=env):
            context = r.infer_context(p)
        self.assertEqual(context['profile'], 'claude-gpt')
        self.assertEqual(context['env']['DEVD_AGENT_MODEL'], 'gpt-model')

    def test_standalone_codex_identity_requires_one_open_root_rollout(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            home = base / 'home'
            sessions = home / 'sessions'
            sessions.mkdir(parents=True)
            proc = base / 'proc/12'
            (proc / 'fd').mkdir(parents=True)
            (proc / 'environ').write_bytes(f'CODEX_HOME={home}\0TMUX_PANE=%1\0SECRET=never-copy'.encode())
            child = str(uuid.uuid4())
            with contextlib.closing(sqlite3.connect(home / 'state_5.sqlite')) as db, db:
                db.execute('CREATE TABLE threads (id TEXT, source TEXT, thread_source TEXT, agent_path TEXT)')
                db.executemany('INSERT INTO threads VALUES (?,?,?,?)', [(SID, 'cli', 'user', None),
                               (child, 'cli', 'subagent', '/child')])
            for index, identifier in enumerate((SID, child)):
                file = sessions / ('rollout-' + identifier + '.jsonl')
                file.write_text('private content must not be read')
                (proc / 'fd' / str(index)).symlink_to(file)
            with patch.object(r, 'PROC', base / 'proc'):
                self.assertEqual(r.foreground_codex_identity({'pane_id': '%1'}, 12), SID)
                self.assertIsNone(r.foreground_codex_identity({'pane_id': '%2'}, 12))
                other = str(uuid.uuid4())
                file = sessions / ('rollout-' + other + '.jsonl')
                file.write_text('')
                (proc / 'fd/3').symlink_to(file)
                with contextlib.closing(sqlite3.connect(home / 'state_5.sqlite')) as db, db:
                    db.execute('INSERT INTO threads VALUES (?,?,?,?)', (other, 'cli', 'user', None))
                self.assertIsNone(r.foreground_codex_identity({'pane_id': '%1'}, 12))

    def test_central_unloaded_interrupted_turn_has_one_shared_continue_claim(self):
        class Rpc:
            def __init__(self, *args, **kwargs): pass
            def close(self): pass
            def call(self, *args):
                return {'thread': {'status': {'type': 'notLoaded'}, 'canAcceptDirectInput': True,
                                  'turns': [{'id': '22222222-2222-4222-8222-222222222222', 'status': 'interrupted'}]}}
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / 'devbox-routes.json').write_text(json.dumps({'routes': [{'container': 'dev-one', 'thread_ids': [SID]}]}))
            plan = {'env': {'CODEX_HOME': tmp}, 'session_id': SID}
            with patch.dict(sys.modules, {'rpc': types.SimpleNamespace(Rpc=Rpc)}), patch.dict(os.environ, {'DEVD_SESSION_ID': 'dev-one'}):
                self.assertTrue(r.codex_remote_interrupted(plan))
                self.assertFalse(r.codex_remote_interrupted(plan))
            with patch.dict(sys.modules, {'rpc': types.SimpleNamespace(Rpc=Rpc)}), patch.dict(os.environ, {'DEVD_SESSION_ID': 'dev-other'}):
                self.assertFalse(r.codex_remote_interrupted(plan))


@unittest.skipUnless(shutil.which('tmux'), 'tmux required for isolated real cold-restart proof')
class ColdRestartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='devbox-recovery-proof-')
        self.base = Path(self.temp.name)
        self.root = self.base / 'journal'
        self.socket = 'recovery-proof-' + uuid.uuid4().hex
        self.raw_run = r.run
        self.env = patch.dict(os.environ, {'DEVD_SESSION_ID': 'dev-proof-recovery'})
        self.env.start()
        self.root_patch = patch.object(r, 'ROOT', self.root)
        self.root_patch.start()
        self.gen = 'a' * 24
        self.gen_patch = patch.object(r, 'generation', side_effect=lambda: self.gen)
        self.gen_patch.start()
        self.run_patch = patch.object(r, 'run', side_effect=self.private_run)
        self.run_patch.start()
        self.script = self.base / 'runner'
        # A real subprocess runs launch(), records the fixed agent argv, and stays
        # alive like an interactive CLI. No model or Docker daemon is contacted.
        self.script.write_text(f'''#!/usr/bin/env python3
import importlib.machinery,importlib.util,json,os,sys,time
from pathlib import Path
l=importlib.machinery.SourceFileLoader('recovery',{str(SOURCE)!r})
s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
m.ROOT=Path({str(self.root)!r})
original=Path.is_dir
Path.is_dir=lambda p: str(p).startswith('/home/dev/.') or original(p)
def execute(executable,args,env):
    Path({str(self.base)!r},'launch-'+sys.argv[3]+'.json').write_text(json.dumps({{'argv':args,'env':m.clean_env(env)}}))
    os.execvp('sleep',['sleep','120'])
m.os.execvpe=execute
m.launch(sys.argv[2],int(sys.argv[3]))
''')
        self.script.chmod(0o755)
        self.script_patch = patch.object(r, 'SCRIPT', str(self.script))
        self.script_patch.start()

    def private_run(self, args, **kwargs):
        if args[0] == 'tmux':
            args = ['tmux', '-L', self.socket, '-f', '/dev/null', *args[1:]]
        return self.raw_run(args, **kwargs)

    def tearDown(self):
        self.private_run(['tmux', 'kill-server'], check=False)
        self.script_patch.stop()
        self.run_patch.stop()
        self.gen_patch.stop()
        self.root_patch.stop()
        self.env.stop()
        self.temp.cleanup()

    def seed(self):
        # `exec`: with `sh -c 'sleep 120'` dash (Linux /bin/sh) would leave `sh` in the pane, and
        # snapshot would treat the pane as a plain shell; bash (mac /bin/sh) execs sleep by itself.
        r.tmux('new-session', '-d', '-s', 'main', '-x', '120', '-y', '40', '-c', str(self.base), 'exec sleep 120')
        r.tmux('split-window', '-d', '-h', '-t', 'main:0', '-c', str(self.base), 'exec sleep 120')
        r.tmux('new-window', '-d', '-t', 'main:3', '-c', str(self.base), 'exec sleep 120')
        r.tmux('new-session', '-d', '-s', 'main-2', '-c', str(self.base), 'exec sleep 120')
        r.tmux('set-option', '-t', 'main', '@devd_label', 'Retained label')
        identities = r.tmux('list-panes', '-a', '-F', '#{pane_id}').splitlines()
        for index, identity in enumerate(identities):
            p = pane('grok' if index == 0 else 'claude', 'prompt_submit' if index == 0 else 'permission_request')
            p['state']['session_id'] = str(uuid.uuid4())
            r.tmux('set-option', '-p', '-t', identity, '@devd_warp_state', json.dumps(p['state']))
            r.tmux('set-option', '-p', '-t', identity, '@devd_recovery_context', json.dumps(p['context']))
        r.snapshot(False)
        return identities

    def test_real_multi_session_windows_split_and_exact_single_continue(self):
        identities = self.seed()
        before = r.read(self.root / 'latest.json')
        r.tmux('kill-server')
        self.gen = 'b' * 24
        self.assertTrue(r.restore())
        deadline = time.monotonic() + 10
        while len(list(self.base.glob('launch-*.json'))) != 4 and time.monotonic() < deadline:
            time.sleep(.05)
        calls = [json.loads(p.read_text()) for p in sorted(self.base.glob('launch-*.json'))]
        self.assertEqual(len(calls), 4)
        self.assertEqual(sum(r.CONTINUE in x['argv'] for x in calls), 1)
        self.assertEqual([x['argv'][3] for x in calls], [p['state']['session_id'] for p in before['panes']])
        after = r.topology()
        self.assertEqual([(p['session_name'], p['window_index'], p['pane_index']) for p in after],
                         [(p['session_name'], p['window_index'], p['pane_index']) for p in before['panes']])
        self.assertEqual(r.tmux('show-options', '-qv', '-t', 'main', '@devd_label'), 'Retained label')
        layout = r.tmux('display-message', '-p', '-t', 'main:0', '#{window_layout}')
        self.assertIn('{', layout)  # horizontal split retained rather than tiled
        self.assertTrue(r.restore())  # idempotent with live tmux
        self.assertEqual(len(list(self.base.glob('launch-*.json'))), 4)

    def test_agent_switch_starts_new_agent_in_entry_pane_and_restores_the_rest(self):
        # The container lived with Claude, devd recreated it for `dev --codex` with DEVD_AGENT=codex.
        with patch.dict(os.environ, {'DEVD_AGENT': 'claude'}):
            self.seed()
        before = r.read(self.root / 'latest.json')
        self.assertEqual(before['agent'], 'claude')
        r.tmux('kill-server')
        self.gen = 'e' * 24
        with patch.dict(os.environ, {'DEVD_AGENT': 'codex'}):
            self.assertTrue(r.restore())
        deadline = time.monotonic() + 10
        while len(list(self.base.glob('launch-*.json'))) != 4 and time.monotonic() < deadline:
            time.sleep(.05)
        calls = {int(p.stem.split('-')[1]): json.loads(p.read_text()) for p in self.base.glob('launch-*.json')}
        self.assertEqual(len(calls), 4)
        self.assertEqual(calls[0]['argv'], ['/usr/local/bin/agent-launch'])  # main:0.0 = the new agent
        self.assertEqual([calls[i]['argv'][3] for i in (1, 2, 3)], [p['state']['session_id'] for p in before['panes'][1:]])
        self.assertFalse(any(r.CONTINUE in x['argv'] for x in calls.values()))  # the interrupted work belonged to the old agent

    def test_same_agent_restart_keeps_entry_pane_conversation(self):
        with patch.dict(os.environ, {'DEVD_AGENT': 'codex'}):
            self.seed()
            r.tmux('kill-server')
            self.gen = 'f' * 24
            self.assertTrue(r.restore())
        plan = r.read(self.root / ('plan-' + self.gen + '.json'))
        self.assertNotIn('fresh_agent', plan['panes'][0])
        self.assertIsNotNone(r.resume_plan(plan['panes'][0]))

    def test_last_permission_hook_survives_crash_before_next_timer(self):
        identities = self.seed()
        saved = r.read(self.root / 'latest.json')
        changed = dict(saved['panes'][0]['state'], event='permission_request')
        # Simulate immediate durable hook file, followed by crash before snapshot.
        r.atomic(self.root / ('pane-' + identities[0][1:] + '.json'), {'generation': self.gen, 'state': changed})
        r.tmux('kill-server')
        self.gen = 'c' * 24
        self.assertTrue(r.restore())
        plan = r.read(self.root / ('plan-' + self.gen + '.json'))
        self.assertEqual(plan['panes'][0]['state']['event'], 'permission_request')
        self.assertFalse(r.resume_plan(plan['panes'][0])['active'])

    def test_new_conversation_partial_checkpoint_never_resumes_old_identity(self):
        identities = self.seed()
        r.atomic(self.root / ('pane-' + identities[0][1:] + '.json'), {'generation': self.gen,
                 'state': {'agent': 'grok', 'session_id': str(uuid.uuid4()), 'event': 'prompt_submit'}})
        r.tmux('kill-server')
        self.gen = 'd' * 24
        self.assertTrue(r.restore())
        plan = r.read(self.root / ('plan-' + self.gen + '.json'))
        self.assertIsNone(r.resume_plan(plan['panes'][0]))

    def test_incomplete_restore_never_overwrites_original_journal(self):
        self.seed()
        previous = (self.root / 'latest.json').read_bytes()
        r.atomic(self.root / 'restore-incomplete', {'plan': 'pending'})
        r.snapshot(False)
        self.assertEqual((self.root / 'latest.json').read_bytes(), previous)


class AgyRecovery(unittest.TestCase):
    def agy_pane(self, event='prompt_submit', profile='antigravity', sid=SID):
        return {'state': {'agent': 'agy', 'session_id': sid, 'event': event},
                'context': {'runtime': 'agy', 'profile': profile, 'env': {}}}

    def test_profile_maps_to_agy_runtime(self):
        self.assertEqual(r.RUNTIME['antigravity'], 'agy')
        self.assertIn('antigravity', r.PROFILES)

    def test_resume_plan_uses_conversation_flag(self):
        plan = r.resume_plan(self.agy_pane())
        self.assertEqual(plan['argv'], ['/usr/local/bin/agent-launch', 'antigravity', '--conversation=' + SID])
        self.assertTrue(plan['active'])

    def test_foreign_profile_or_bad_id_does_not_resume(self):
        self.assertIsNone(r.resume_plan(self.agy_pane(profile='claude-grok')))
        self.assertIsNone(r.resume_plan(self.agy_pane(sid='not-a-uuid')))

    def test_claude_gemini_maps_to_claude_runtime(self):
        self.assertEqual(r.RUNTIME['claude-gemini'], 'claude')
        self.assertIn('claude-gemini', r.PROFILES)

    def test_headless_agy_does_not_replace_identity(self):
        for args in (['-p', 'task'], ['--print', 'x'], ['mcp', 'list'], ['models'], ['update']):
            self.assertFalse(r.interactive_launch('agy', args), args)
        self.assertTrue(r.interactive_launch('agy', []))
        self.assertTrue(r.interactive_launch('agy', ['--conversation=' + SID]))

    def recorded_context(self, runtime, args, env):
        # Behaves just like agent-launch: TMUX_PANE set, DEVD_LAUNCH_PROFILE
        # missing (agent-launch removes it before exec and new panes/windows do not inherit it).
        with patch.dict(os.environ, dict(env, TMUX_PANE='%1'), clear=True), \
             patch.object(r.os, 'isatty', return_value=True), \
             patch.object(r, 'tmux') as tmux, \
             patch.object(r, 'snapshot'):
            r.record_launch(runtime, args)
        for call in tmux.call_args_list:
            if '@devd_recovery_context' in call.args:
                return json.loads(call.args[-1])
        return None

    def test_record_launch_without_profile_env_falls_back_to_antigravity(self):
        # Without DEVD_LAUNCH_PROFILE the fallback must pick the canonical profile of runtime "agy"
        # ("antigravity"), not its own runtime name – that is not a key in RUNTIME.
        context = self.recorded_context('agy', [], {})
        self.assertIsNotNone(context)
        self.assertEqual(context['profile'], 'antigravity')

    def test_fallback_profile_still_resumes(self):
        # A pane whose context profile came from the same fallback as above must still
        # resume – not fall into RUNTIME.get(profile) != agent.
        context = self.recorded_context('agy', [], {})
        pane = {'state': {'agent': 'agy', 'session_id': SID, 'event': 'prompt_submit'}, 'context': context}
        self.assertIsNotNone(r.resume_plan(pane))


class LaunchContinueArgsTests(unittest.TestCase):
    """agy accepts the initial prompt only via -i/--prompt-interactive, never as a bare positional
    argument; other runtimes must keep receiving CONTINUE unchanged (launch() argv)."""

    def setUp(self):
        self.orig_cwd = os.getcwd()
        self.temp = tempfile.TemporaryDirectory(prefix='devbox-recovery-launch-')
        self.root = Path(self.temp.name) / 'journal'
        self.work = Path(self.temp.name) / 'work'
        self.work.mkdir()
        self.root_patch = patch.object(r, 'ROOT', self.root)
        self.root_patch.start()
        self.env = patch.dict(os.environ, {'DEVD_SESSION_ID': 'launch-continue-test'})
        self.env.start()
        # Saved account dirs (e.g. /home/dev/.claude) need not exist on the test host.
        original_is_dir = Path.is_dir
        self.is_dir_patch = patch.object(Path, 'is_dir', lambda p: str(p).startswith('/home/dev/.') or original_is_dir(p))
        self.is_dir_patch.start()

    def tearDown(self):
        os.chdir(self.orig_cwd)
        self.is_dir_patch.stop()
        self.env.stop()
        self.root_patch.stop()
        self.temp.cleanup()

    def plan_file(self, agent, profile, env):
        pane = {'pane_current_path': str(self.work), 'state': {'agent': agent, 'session_id': SID, 'event': 'prompt_submit'},
                'context': {'runtime': agent, 'profile': profile, 'env': env}}
        name = 'plan-' + ('0' * 24) + '.json'
        r.atomic(self.root / name, {'session': os.environ['DEVD_SESSION_ID'], 'panes': [pane]})
        r.atomic(self.root / (name + '.ready'), {'ready': True})
        return name

    def test_launch_passes_continue_via_prompt_interactive_flag_for_agy(self):
        plan_file = self.plan_file('agy', 'antigravity', {})
        with patch.object(r.os, 'execvpe') as execvpe:
            r.launch(plan_file, 0)
        args = execvpe.call_args.args[1]
        self.assertEqual(args[-2:], ['-i', r.CONTINUE])

    def test_launch_still_appends_continue_positionally_for_claude(self):
        plan_file = self.plan_file('claude', 'claude', {'CLAUDE_CONFIG_DIR': '/home/dev/.claude'})
        with patch.object(r.os, 'execvpe') as execvpe:
            r.launch(plan_file, 0)
        args = execvpe.call_args.args[1]
        self.assertEqual(args[-1], r.CONTINUE)
        self.assertNotIn('-i', args)


if __name__ == '__main__':
    unittest.main()
