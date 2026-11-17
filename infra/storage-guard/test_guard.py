import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
from unittest.mock import Mock
from types import SimpleNamespace

HERE=Path(__file__).parent
def module(name):
    s=importlib.util.spec_from_file_location(name,HERE/(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
guard=module('guard');client=module('client')
host=module('host-docker')


class Safety(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name).resolve()
        self.cfg=json.loads((HERE/'config.example.json').read_text())
        self.cfg.update(root=str(self.root),state_dir=str(self.root/'state'))
        self.g=guard.Guard(self.cfg)
    def tearDown(self):self.tmp.cleanup()

    @patch.dict(os.environ, {'DEVBOX_STORAGE_GUARD': '1'})
    def test_pressure_blocks_only_expanding_commands(self):
        self.assertTrue(client.expanding('git',['-C','repo','worktree','add','new']))
        self.assertTrue(client.expanding('git',['-c','safe.directory=*','clone','source']))
        self.assertTrue(client.expanding('docker',['buildx','build','.']))
        self.assertFalse(client.expanding('git',['status']))
        self.assertFalse(client.expanding('git',['worktree','remove','old']))
        self.assertFalse(client.expanding('docker',['exec','db','psql']))
        self.assertFalse(client.expanding('docker',['compose','ps']))
        self.assertTrue(client.expanding('docker',['compose','up','-d']))
        self.assertIsNotNone(client.preflight({'blocked':True,'reserve_bytes':0,'reason':'test'}))
        self.assertIsNone(client.preflight({'blocked':False,'reserve_bytes':0,'measured_at':time.time()}))

    @patch.dict(os.environ, {'DEVBOX_STORAGE_GUARD': '1'})
    def test_stale_inventory_does_not_admit_more_copies(self):
        self.assertIsNotNone(client.preflight({'reserve_bytes':0,'measured_at':time.time()-20000}))

    def test_hosts_without_the_guard_are_never_blocked(self):
        # No DEVBOX_STORAGE_GUARD from devd and no published state: plain pass-through,
        # even inside a session and even with an empty inventory.
        env = {k: v for k, v in os.environ.items() if k != 'DEVBOX_STORAGE_GUARD'}
        env['DEVD_SESSION_ID'] = 'dev-acme-web'
        with patch.dict(os.environ, env, clear=True), patch.object(client, 'STATE', Path('/nonexistent/state.json')):
            self.assertIsNone(client.preflight({}))
            self.assertIsNone(client.preflight({'blocked': True, 'reserve_bytes': 0}))
        with patch.dict(os.environ, {**env, 'DEVBOX_STORAGE_GUARD': '1'}, clear=True), patch.object(client, 'STATE', Path('/nonexistent/state.json')):
            self.assertIsNotNone(client.preflight({}))

    def test_collect_events_drops_unusable_records_and_writes_registry_once(self):
        control=self.root/'control';events=control/'storage-events';events.mkdir(parents=True)
        good=dict(kind='created',time=1.0,session='dev-a',path='/srv/x',purpose='t')
        (events/'good.json').write_text(json.dumps(good))
        (events/'other.json').write_text(json.dumps({**good,'session':'dev-b'}))  # not this session
        (events/'nopath.json').write_text(json.dumps({**good,'path':None}))
        (events/'broken.json').write_text('{not json')
        (events/'notime.json').write_text(json.dumps({k:v for k,v in good.items() if k!='time'}))
        writes=[]
        real=guard.atomic
        with patch.object(guard,'beneath',return_value=True), \
             patch.object(guard,'atomic',side_effect=lambda *a,**k:(writes.append(a[0]),real(*a,**k))):
            self.g.collect_events([dict(name='dev-a',control=str(control))])
        self.assertEqual(list(events.iterdir()),[])
        self.assertEqual(len(writes),1)
        self.assertIn('dev-a:/srv/x',guard.read(self.g.state/'registry.json'))

    def test_bare_repo_worktree_globs_come_from_config(self):
        self.assertEqual(self.g.c.get('bare_repo_worktree_globs', []), [])

    def test_signature_detects_replacement_even_same_size_and_mtime(self):
        p=self.root/'file';p.write_text('one');s=p.stat();old=guard.signature(p)
        p.unlink();p.write_text('two');os.utime(p,ns=(s.st_atime_ns,s.st_mtime_ns))
        self.assertNotEqual(old,guard.signature(p))

    def test_signature_accepts_fifo_and_detects_its_replacement(self):
        d=self.root/'dind';d.mkdir();f=d/'auxfiles';os.mkfifo(f)
        old=guard.signature(d)
        self.assertEqual(old,guard.signature(d))
        f.unlink();os.mkfifo(f)
        self.assertNotEqual(old,guard.signature(d))
    def test_symlink_escape_is_not_managed(self):
        managed=self.root/'managed';managed.mkdir()
        (managed/'link').symlink_to('/etc')
        self.assertFalse(guard.beneath(managed/'link'/'passwd',managed))
        self.assertFalse(guard.beneath(managed,managed))

    def retained_fixture(self):
        name = 'dev-apps-web-2'
        workspace = self.root / '_sessions' / name
        workspace.mkdir(parents=True)
        (workspace / 'dirty.txt').write_text('keep this')
        bare = self.root / 'apps/web.git'; bare.mkdir(parents=True)
        registry = self.root / 'routes.json'
        route = dict(container=name, cwd=str(workspace), environment_id='devbox_' + name,
                     thread_ids=['11111111-1111-4111-8111-111111111111'],
                     restore=dict(folder='apps', project='apps', repo='web', solo=0,
                                  worktree=str(workspace), bare=str(bare), branch='main'))
        registry.write_text(json.dumps(dict(routes=[route])));registry.chmod(0o600)
        self.g.c.update(remote_registry=str(registry), remote_registry_uid=os.getuid())
        container = dict(Name='/' + name, Mounts=[dict(Source=str(workspace), Destination='/workspace'),
                                                dict(Source=str(bare), Destination=str(bare))])
        return workspace, registry, route, container

    def test_retained_native_workspace_is_not_part_of_deletion_backup(self):
        workspace, registry, route, container = self.retained_fixture()
        extra = self.root / '_claude-projects' / container['Name'].lstrip('/')
        extra.mkdir(parents=True);(extra / 'transcript.jsonl').write_text('archive me')
        self.assertEqual(self.g.retained_workspace(container), workspace)
        paths, shared = self.g.managed_sources(container)
        self.assertEqual(paths, [extra]);self.assertEqual(shared, [])
        self.assertEqual((workspace / 'dirty.txt').read_text(), 'keep this')

    def test_untrusted_or_inconsistent_retention_never_skips_workspace_backup(self):
        workspace, registry, route, container = self.retained_fixture()
        import copy
        variants = []
        for key, value in [('restore_error', 'stale'), ('thread_ids', []), ('thread_ids', ['bad']),
                           ('cwd', str(self.root)), ('environment_id', 'other')]:
            invalid = copy.deepcopy(route);invalid[key] = value;variants.append([invalid])
        invalid = copy.deepcopy(route);invalid['restore']['worktree'] = str(self.root);variants.append([invalid])
        variants.append([route, route])
        for routes in variants:
            registry.write_text(json.dumps(dict(routes=routes)))
            self.assertIsNone(self.g.retained_workspace(container))
            paths, _ = self.g.managed_sources(container)
            self.assertIn(workspace, paths)
        registry.write_text(json.dumps(dict(routes=[route])));registry.chmod(0o666)
        self.assertIsNone(self.g.retained_workspace(container))
        registry.chmod(0o600)
        self.g.c['remote_registry_uid'] = os.getuid() + 1
        self.assertIsNone(self.g.retained_workspace(container))

    def test_archive_warning_never_authorizes_deletion(self):
        p=self.root/'work';p.mkdir();(p/'unique').write_text('important')
        with patch.object(self.g,'borg',side_effect=RuntimeError('rc=1')):
            with self.assertRaises(RuntimeError):self.g.archive([p],'test')
        self.assertEqual((p/'unique').read_text(),'important')

    def test_changed_source_rejected_after_integrity_check(self):
        p=self.root/'work';p.write_text('one')
        def borg(args):
            if args[0]=='extract':p.write_text('two')
            return b''
        with patch.object(self.g,'borg',side_effect=borg):
            with self.assertRaisesRegex(RuntimeError,'changed'):self.g.archive([p],'test')
        self.assertTrue(p.exists())

    def test_end_ready_checks_metadata_without_rehashing(self):
        p=self.root/'work';p.mkdir();(p/'f').write_text('one')
        c={'Id':'abc','State':{'Running':False}}
        guard.atomic(self.g.state/'prepared'/'abc.json',dict(container_id='abc',signatures={str(p):guard.signature(p)},repository=self.cfg['borg_repo'],verified_at=time.time()))
        with patch.object(guard,'digest',side_effect=AssertionError('rehash')):
            self.assertTrue(self.g.end_ready(c))
            (p/'f').write_text('two!')
            self.assertFalse(self.g.end_ready(c))
    def test_end_ready_trusts_recent_full_check_only_when_fresh(self):
        p=self.root/'work';p.mkdir();(p/'f').write_text('one')
        c={'Id':'abc','State':{'Running':False}}
        rec=dict(container_id='abc',signatures={str(p):guard.signature(p)},repository=self.cfg['borg_repo'],verified_at=time.time())
        guard.atomic(self.g.state/'prepared'/'abc.json',rec)
        (p/'f').write_text('changed!')
        with patch.object(guard,'signature',side_effect=AssertionError('walk')):
            self.assertTrue(self.g.end_ready(c,fresh=300))
        rec['checked_at']=rec['verified_at']=time.time()-400
        guard.atomic(self.g.state/'prepared'/'abc.json',rec)
        self.assertFalse(self.g.end_ready(c,fresh=300))
        self.assertFalse(self.g.end_ready({'Id':'abc','State':{'Running':True}},fresh=300))
    def test_shared_git_store_changes_do_not_block_but_owned_ones_do(self):
        own=self.root/'work';own.mkdir();(own/'f').write_text('one')
        shared=self.root/'repo.git';shared.mkdir();(shared/'o').write_text('a')
        calls=[]
        def borg(args,allow_warning=False):
            calls.append((args[0],allow_warning))
            if args[0]=='extract':(shared/'new').write_text('sibling commit')
            return b''
        with patch.object(self.g,'borg',side_effect=borg):
            name,sigs=self.g.archive([own],'test',[shared])
        self.assertEqual(list(sigs),[str(own.resolve())])
        self.assertIn(('create',True),calls)
        def borg2(args,allow_warning=False):
            if args[0]=='extract':(own/'f').write_text('two')
            return b''
        with patch.object(self.g,'borg',side_effect=borg2):
            with self.assertRaisesRegex(RuntimeError,'changed'):self.g.archive([own],'test',[shared])
    @unittest.skipUnless(Path('/proc').is_dir(), 'Linux procfs integration test')
    def test_reference_scan_detects_open_file(self):
        p=self.root/'open';p.write_text('x')
        proc=subprocess.Popen(['python3','-c','import sys,time; f=open(sys.argv[1]); print("ready",flush=True); time.sleep(15)',str(p)],stdout=subprocess.PIPE)
        try:
            proc.stdout.readline()
            self.assertTrue(guard.referenced(p))
        finally:proc.terminate();proc.wait();proc.stdout.close()

    def test_running_session_never_ready_for_removal(self):
        atomic=guard.atomic
        atomic(self.g.state/'prepared'/'abc.json',{'container_id':'abc','signatures':{}})
        self.assertFalse(self.g.end_ready({'Id':'abc','State':{'Running':True}}))

    def test_modified_stopped_session_invalidates_proof(self):
        p=self.root/'source';p.write_text('first')
        guard.atomic(self.g.state/'prepared'/'abc.json',dict(container_id='abc',signatures={str(p):guard.signature(p)},repository=self.cfg['borg_repo'],verified_at=time.time()))
        self.assertTrue(self.g.end_ready({'Id':'abc','State':{'Running':False}}))
        p.write_text('changed')
        self.assertFalse(self.g.end_ready({'Id':'abc','State':{'Running':False}}))

    def test_unknown_or_active_owner_not_swept(self):
        p=self.root/'_sessions'/'dev-owner'/'copy';p.mkdir(parents=True);(p/'unique').write_text('keep')
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[{'name':'dev-owner'}]})
        guard.atomic(self.g.state/'registry.json',{'x':{'session':'dev-owner','path':str(p),'released_at':1}})
        with patch.object(self.g,'archive',side_effect=AssertionError('must not archive')):
            self.g.sweep()
        self.assertTrue((p/'unique').exists())

    def git(self, p, text):
        # `.git` older than any release: a worktree created before it was released.
        (p/'.git').write_text(text);os.utime(p/'.git',(0,0))

    def released(self, *names, session='dev-owner', released_at=1):
        owner=self.root/'_sessions'/session
        out={}
        for n in names:
            p=owner/'.worktrees'/n;p.mkdir(parents=True);(p/'file').write_text(n)
            out[n]=p
        guard.atomic(self.g.state/'registry.json',{n:{'session':session,'path':str(p),'released_at':released_at} for n,p in out.items()})
        return out

    def test_broken_registration_is_archived_and_removed(self):
        # Agents run `git worktree prune` in their container, which unregisters the nested
        # worktrees of every other session. Those released copies used to stay on disk forever
        # ("not a git repository" -> review), ~500 GB on the devbox. Archive + rm them instead.
        bare=self.root/'fivem'/'repo.git';(bare/'worktrees').mkdir(parents=True);(bare/'objects').mkdir()
        w=self.released('broken')['broken']
        self.git(w,f'gitdir: {bare}/worktrees/broken\n')   # admin dir pruned
        other=bare/'worktrees'/'other';other.mkdir();(other/'gitdir').write_text('/workspace/.worktrees/other/.git\n')
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[]})
        archived=[]
        def fake_archive(paths,kind,shared=(),require_stable=True):
            archived.append([str(x) for x in paths]);return 'arch',{str(x):guard.signature(x) for x in paths}
        with patch.object(guard,'run',side_effect=RuntimeError('fatal: not a git repository')), \
             patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'archive',side_effect=fake_archive):
            self.g.sweep()
        self.assertEqual(archived,[[str(w)]])
        self.assertFalse(w.exists())
        self.assertTrue(other.exists(), 'registrations of other worktrees stay')
        self.assertEqual(guard.read(self.g.state/'registry.json')['broken']['archive'],'arch')

    def test_other_git_failure_is_kept_for_review(self):
        bare=self.root/'fivem'/'repo.git';(bare/'worktrees'/'w').mkdir(parents=True);(bare/'objects').mkdir()
        w=self.released('w')['w'];self.git(w,f'gitdir: {bare}/worktrees/w\n')   # registered, git just failed
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[]})
        with patch.object(guard,'run',side_effect=RuntimeError('timeout')), \
             patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'archive',side_effect=AssertionError('must not archive')):
            self.g.sweep()
        self.assertTrue(w.exists())
        self.assertTrue(any(c['path']==str(w) for c in guard.read(self.g.state/'review.json')['candidates']))

    def test_recreated_path_is_no_longer_released(self):
        control=self.root/'control';events=control/'storage-events';events.mkdir(parents=True)
        guard.atomic(self.g.state/'registry.json',{'dev-a:/srv/x':{'session':'dev-a','path':'/srv/x','released_at':1,'removed_at':2,'archive':'a'}})
        (events/'1.json').write_text(json.dumps(dict(kind='created',time=3.0,session='dev-a',path='/srv/x')))
        with patch.object(guard,'beneath',return_value=True):
            self.g.collect_events([dict(name='dev-a',control=str(control))])
        e=guard.read(self.g.state/'registry.json')['dev-a:/srv/x']
        self.assertNotIn('released_at',e);self.assertNotIn('removed_at',e)
        # A late-read release of the OLD copy (older timestamp) must not mark the new one.
        (events/'2.json').write_text(json.dumps(dict(kind='release',time=1.5,session='dev-a',path='/srv/x')))
        with patch.object(guard,'beneath',return_value=True):
            self.g.collect_events([dict(name='dev-a',control=str(control))])
        self.assertNotIn('released_at',guard.read(self.g.state/'registry.json')['dev-a:/srv/x'])

    def test_worktree_recreated_outside_the_shim_is_kept(self):
        w=self.released('w',released_at=time.time()-7200)['w'];(w/'.git').write_text('gitdir: x\n')   # fresh .git
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[]})
        with patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'archive',side_effect=AssertionError('must not archive')):
            self.g.sweep()
        self.assertTrue(w.exists())

    def test_released_worktrees_share_one_archive(self):
        ws=self.released('a','b','c')
        for p in ws.values():self.git(p,'gitdir: x\n')
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[]})
        calls=[];archived=[]
        def fake_run(args,*a,**k):
            calls.append([str(x) for x in args])
            if 'remove' in calls[-1]:shutil.rmtree(calls[-1][-1])
            return (str(self.root/'repo.git')+'\n').encode()
        def fake_archive(paths,kind,shared=(),require_stable=True):
            archived.append(sorted(map(str,paths)));return 'arch',{str(x):guard.signature(x) for x in paths}
        with patch.object(guard,'run',side_effect=fake_run), \
             patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'git_storage',return_value=[]), \
             patch.object(self.g,'archive',side_effect=fake_archive):
            self.g.sweep()
        self.assertEqual(archived,[sorted(map(str,ws.values()))])
        removes=[c for c in calls if 'remove' in c]
        self.assertEqual(len(removes),3)
        self.assertTrue(all(c.count('--force')==2 for c in removes), 'locked agent worktrees too')
        self.assertTrue(all('removed_at' in e for e in guard.read(self.g.state/'registry.json').values()))

    def test_worktree_changed_during_archive_is_kept(self):
        ws=self.released('a','b')
        for p in ws.values():self.git(p,'gitdir: x\n')
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[]})
        def fake_archive(paths,kind,shared=(),require_stable=True):
            self.assertFalse(require_stable)
            sigs={str(x):guard.signature(x) for x in paths}
            (ws['a']/'file').write_text('new work')
            return 'arch',sigs
        def fake_run(args,*a,**k):
            if 'remove' in args:shutil.rmtree(args[-1])
            return (str(self.root/'repo.git')+'\n').encode()
        with patch.object(guard,'run',side_effect=fake_run), \
             patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'git_storage',return_value=[]), \
             patch.object(self.g,'archive',side_effect=fake_archive):
            self.g.sweep()
        self.assertTrue(ws['a'].exists());self.assertFalse(ws['b'].exists())

    def test_live_owner_grace_is_one_hour(self):
        ws=self.released('old','fresh',session='dev-live',released_at=time.time()-7200)
        for w in ws.values():self.git(w,'gitdir: x\n')
        reg=guard.read(self.g.state/'registry.json');reg['fresh']['released_at']=time.time()-600
        guard.atomic(self.g.state/'registry.json',reg)
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[{'name':'dev-live'}]})
        seen=[]
        def fake_archive(paths,kind,shared=(),require_stable=True):
            seen.extend(map(str,paths));raise RuntimeError('stop here')
        with patch.object(guard,'run',return_value=(str(self.root/'repo.git')+'\n').encode()), \
             patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'git_storage',return_value=[]), \
             patch.object(self.g,'archive',side_effect=fake_archive):
            self.g.sweep()
        self.assertIn(str(ws['old']),seen);self.assertNotIn(str(ws['fresh']),seen)

    def test_disk_pressure_starts_the_sweep_with_cooldown(self):
        full={'time':time.time(),'used_bytes':90,'available_bytes':10,'percent':90}
        with patch.object(self.g,'disk',return_value=full),patch.object(self.g,'publish'),patch.object(self.g,'notify'), \
             patch.object(guard.subprocess,'run',return_value=SimpleNamespace(returncode=0,stderr=b'')) as run:
            self.g.sample();self.g.sample()
        starts=[c for c in run.call_args_list if 'devbox-storage-maintenance.service' in c.args[0]]
        self.assertEqual(len(starts),1)

    def test_failed_sweep_start_retries_next_sample(self):
        full={'time':time.time(),'used_bytes':90,'available_bytes':10,'percent':90}
        with patch.object(self.g,'disk',return_value=full),patch.object(self.g,'publish'),patch.object(self.g,'notify'), \
             patch.object(guard.subprocess,'run',return_value=SimpleNamespace(returncode=1,stderr=b'nope')) as run:
            self.g.sample();self.g.sample()
        self.assertEqual(len(run.call_args_list),2)

    def test_no_sweep_without_pressure(self):
        ok={'time':time.time(),'used_bytes':10,'available_bytes':10**15,'percent':10}
        with patch.object(self.g,'disk',return_value=ok),patch.object(self.g,'publish'),patch.object(self.g,'notify'), \
             patch.object(guard.subprocess,'run') as run:
            self.g.sample()
        self.assertFalse(run.called)

    def test_worktree_prune_is_refused_inside_sessions(self):
        with patch.dict(os.environ,{'DEVD_SESSION_ID':'dev-a'}):
            self.assertTrue(client.shared_prune('git',['-C','/workspace','worktree','prune']))
            self.assertFalse(client.shared_prune('git',['worktree','remove','x']))
        with patch.dict(os.environ,{k:v for k,v in os.environ.items() if k!='DEVD_SESSION_ID'},clear=True):
            self.assertFalse(client.shared_prune('git',['worktree','prune']))

    def test_sweep_fails_closed_when_inventory_stale(self):
        guard.atomic(self.g.state/'inventory.json',{'time':1,'sessions':[]})
        with self.assertRaisesRegex(RuntimeError,'Stale'):self.g.sweep()

    def test_disk_samples_keep_actual_growth_window(self):
        baseline={'time':time.time()-3600,'used_bytes':100,'available_bytes':1000000,'percent':1}
        guard.atomic(self.g.state/'disk-history.json',[baseline])
        with patch.object(self.g,'disk',return_value={'time':time.time(),'used_bytes':200,'available_bytes':1000000,'percent':1}),patch.object(self.g,'publish'),patch.object(self.g,'notify'),patch.object(self.g,'start_sweep'):
            s=self.g.sample()
        self.assertEqual(s['growth_bytes_24h'],100)
        self.assertAlmostEqual(s['growth_window_seconds'],3600,delta=2)

    def test_session_budget_override_does_not_block_current_work(self):
        self.g.c['session_limits']={'dev-big-repo':{'warn_gib':100,'block_gib':120}}
        row=dict(name='dev-big-repo',control='/var/lib/devd/sessions/test',bytes=82*guard.GIB,measured_at=time.time())
        disk=dict(percent=39,available_bytes=1000*guard.GIB)
        with patch.object(guard,'atomic') as save:self.g.publish([row],disk)
        self.assertFalse(save.call_args.args[1]['blocked'])
        row['name']='dev-normal'
        with patch.object(guard,'atomic') as save:self.g.publish([row],disk)
        self.assertTrue(save.call_args.args[1]['blocked'])

    def test_notifications_can_be_muted_during_deployment(self):
        self.g.c['notify_enabled']=False
        with patch.object(guard.urllib.request,'urlopen',side_effect=AssertionError('must not notify')):
            self.g.notify('test','deployment message')

    def history_batch(self, restored_content, mutate=False):
        p=(self.root/'history.jsonl').resolve();p.write_text('original preserved history')
        sig={str(p):guard.signature(p)}
        def extract(args,**kw):
            dest=Path(kw['cwd'])/str(p).lstrip('/')
            dest.parent.mkdir(parents=True)
            dest.write_text(restored_content)
            if mutate:p.write_text('changed while archived')
            return b''
        with patch.object(guard,'held_files',return_value=set()),patch.object(self.g,'archive',return_value=('test-archive',sig)),patch.object(guard,'run',side_effect=extract),patch.object(self.g,'disk',return_value={'available_bytes':1000*guard.GIB}):
            self.g.offload_histories([p])
        return p

    def test_history_only_removed_after_identical_full_restoration(self):
        p=self.history_batch('original preserved history')
        self.assertFalse(p.exists())

    def test_corrupted_history_restoration_preserves_original(self):
        with self.assertRaisesRegex(RuntimeError,'hash mismatch'):
            self.history_batch('corrupted restoration')
        self.assertEqual((self.root/'history.jsonl').read_text(),'original preserved history')

    def test_changed_history_after_archival_is_retained(self):
        p=self.history_batch('original preserved history',mutate=True)
        self.assertEqual(p.read_text(),'changed while archived')

    def test_clone_ownership_parser_does_not_record_auth_url(self):
        p=client.clone_destination(['clone','--branch','main','https://private-token@example.test/org/repo.git'],self.root)
        self.assertEqual(p,self.root.resolve()/'repo')
        self.assertNotIn('private-token',str(p))
        p=client.clone_destination(['clone','--depth','1','remote','custom'],self.root)
        self.assertEqual(p,self.root.resolve()/'custom')

    def test_post_creation_install_failure_does_not_orphan_session(self):
        g=Mock()
        g.publish.side_effect=RuntimeError('test install failure')
        c={'State':{'Running':True},'Mounts':[]}
        with patch.object(host,'load',return_value=g),patch.object(host,'gate'),patch.object(host,'inspect',return_value=c),patch.object(host.subprocess,'run',return_value=SimpleNamespace(returncode=0)),patch.object(host.sys,'argv',['docker','run','--name','dev-fixture','image']):
            self.assertEqual(host.main(),0)
        g.audit.assert_called()

    def test_expired_or_other_repository_proof_denies_removal(self):
        proof=dict(container_id='abc',signatures={},repository='wrong-repository',verified_at=time.time())
        guard.atomic(self.g.state/'prepared'/'abc.json',proof)
        self.assertFalse(self.g.end_ready({'Id':'abc','State':{'Running':False}}))
        proof.update(repository=self.cfg['borg_repo'],verified_at=time.time()-4000)
        guard.atomic(self.g.state/'prepared'/'abc.json',proof)
        self.assertFalse(self.g.end_ready({'Id':'abc','State':{'Running':False}}))

    def test_legacy_git_registration_keeps_raw_data_without_guessing_head(self):
        workspace=self.root/'workspace';workspace.mkdir()
        common=self.root/'repo.git';(common/'objects').mkdir(parents=True)
        (common/'refs').mkdir()
        pointer='gitdir: '+str(common/'worktrees'/'missing')+'\n'
        (workspace/'.git').write_text(pointer)
        (workspace/'unique').write_text('preserve me')
        c={'Name':'/dev-fixture','Mounts':[{'Source':str(workspace),'Destination':'/workspace'},
                                         {'Source':str(common),'Destination':str(common)}]}
        with patch.object(guard,'run',side_effect=RuntimeError('missing legacy registration')):
            paths=self.g.managed_paths(c)
        self.assertIn(workspace,paths)
        self.assertIn(common/'objects',paths)
        self.assertEqual((workspace/'.git').read_text(),pointer)
        self.assertEqual((workspace/'unique').read_text(),'preserve me')


class InspectExisting(unittest.TestCase):
    def proc(self,rc,out,err):
        return SimpleNamespace(returncode=rc,stdout=out,stderr=err)
    def test_container_removed_mid_inspect_is_skipped(self):
        out=json.dumps([{'Name':'/dev-a'}]).encode()
        with patch.object(guard.subprocess,'run',return_value=self.proc(1,out,b'error: no such object: ae136b0f4dba\nError: No such object: 9c4626378ffc\n')):
            self.assertEqual([c['Name'] for c in guard.inspect_existing(['a','ae136b0f4dba','9c4626378ffc'])],['/dev-a'])
    def test_other_inspect_errors_still_fail(self):
        with patch.object(guard.subprocess,'run',return_value=self.proc(1,b'','Cannot connect to the Docker daemon\n'.encode())):
            with self.assertRaises(RuntimeError):guard.inspect_existing(['a'])
    def test_no_ids_skips_docker(self):
        with patch.object(guard.subprocess,'run',side_effect=AssertionError('called')):
            self.assertEqual(guard.inspect_existing([]),[])


if __name__=='__main__':unittest.main()
