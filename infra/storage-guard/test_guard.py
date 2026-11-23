import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
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

    def container_worktrees(self):
        """Two sessions that each added /workspace/.worktrees/w: git names their registrations w and w1."""
        git=lambda *a,cwd:subprocess.run(['git','-c','user.name=t','-c','user.email=t@t','-c','init.defaultBranch=main',*a],cwd=cwd,check=True,capture_output=True)
        src=self.root/'src';src.mkdir();git('init',cwd=src);(src/'a').write_text('a')
        git('add','.',cwd=src);git('commit','-m','a',cwd=src)
        bare=self.root/'fivem'/'repo.git';git('clone','--bare',str(src),str(bare),cwd=self.root)
        owners=[self.root/'_sessions'/n for n in ('dev-owner','dev-other')]
        for o in owners:git('worktree','add','--detach',str(o/'.worktrees'/'w'),cwd=bare)
        for name in ('w','w1'):(bare/'worktrees'/name/'gitdir').write_text('/workspace/.worktrees/w/.git\n')
        return bare,owners

    def test_worktree_registered_from_the_container_is_removed(self):
        # A worktree added inside the container is registered as /workspace/...; the host path
        # never matched it, so `worktree remove` failed with "is not a working tree" and
        # released worktrees (192 GB) stayed on disk.
        bare,(owner,other)=self.container_worktrees()
        self.g.remove_worktree(owner/'.worktrees'/'w',owner)
        self.assertFalse((owner/'.worktrees'/'w').exists());self.assertFalse((bare/'worktrees'/'w').exists())
        self.assertEqual((bare/'worktrees'/'w1'/'gitdir').read_text(),'/workspace/.worktrees/w/.git\n',
                         'the other session keeps its registration')
        self.assertTrue((other/'.worktrees'/'w'/'a').exists())

    def test_registration_of_another_session_is_never_taken_over(self):
        # The agent controls `.git`: pointed at the other session's registration, removing it
        # would also unregister that session's live worktree.
        bare,(owner,other)=self.container_worktrees()
        w=owner/'.worktrees'/'w';(w/'.git').write_text(f'gitdir: {bare}/worktrees/w1\n')
        with self.assertRaises(RuntimeError):self.g.remove_worktree(w,owner)
        self.assertTrue(w.exists())
        self.assertEqual((bare/'worktrees'/'w1'/'gitdir').read_text(),'/workspace/.worktrees/w/.git\n')

    def test_unregistered_removal_drops_only_its_own_registration(self):
        bare,(owner,other)=self.container_worktrees()
        self.g.remove_unregistered(owner/'.worktrees'/'w',owner)
        self.assertFalse((owner/'.worktrees'/'w').exists());self.assertFalse((bare/'worktrees'/'w').exists())
        self.assertTrue((bare/'worktrees'/'w1').exists(),'the other session keeps its registration')

    def test_unregistered_removal_never_takes_another_sessions_registration(self):
        bare,(owner,other)=self.container_worktrees()
        w=owner/'.worktrees'/'w';(w/'.git').write_text(f'gitdir: {bare}/worktrees/w1\n')
        self.g.remove_unregistered(w,owner)
        self.assertFalse(w.exists())
        self.assertTrue((bare/'worktrees'/'w1').exists(),"the other session's live worktree stays registered")

    def idle_worktree(self, hours_idle=13):
        """A clean worktree whose HEAD is on the remote, in session dev-owner, last touched hours_idle ago."""
        git=lambda *a,cwd:subprocess.run(['git','-c','user.name=t','-c','user.email=t@t','-c','init.defaultBranch=main',*a],cwd=cwd,check=True,capture_output=True)
        remote=self.root/'remote.git';git('init','--bare',str(remote),cwd=self.root)
        repo=self.root/'repo';git('clone',str(remote),str(repo),cwd=self.root);(repo/'a').write_text('a')
        git('add','.',cwd=repo);git('commit','-m','a',cwd=repo);git('push','origin','HEAD',cwd=repo)
        w=self.root/'_sessions'/'dev-owner'/'.worktrees'/'w';git('worktree','add','--detach',str(w),cwd=repo)
        old=time.time()-hours_idle*3600
        for f in [w,w/'.git',*(repo/'.git'/'worktrees'/'w').rglob('*')]:os.utime(f,(old,old))
        registry={'dev-owner:'+str(w):dict(session='dev-owner',path=str(w),kind='discovered-review')}
        guard.atomic(self.g.state/'registry.json',registry)
        return w,registry

    def test_idle_clean_worktree_is_released(self):
        # Agents rarely release their worktrees: 45 clean, pushed ones (~180 GB) sat untouched
        # for four days and the disk filled up.
        w,registry=self.idle_worktree()
        with patch.object(guard,'referenced',return_value=False):self.g.release_idle(registry,[])
        e=guard.read(self.g.state/'registry.json')['dev-owner:'+str(w)]
        self.assertTrue(e['auto_released'])
        self.assertLess(e['released_at'],time.time()-self.g.c['release_grace_hours']*3600,'removed by this sweep, no extra grace')
        self.assertEqual(registry['dev-owner:'+str(w)]['released_at'],e['released_at'],'the running sweep sees it too')

    def test_busy_or_unfinished_worktree_is_not_released(self):
        cases={'recent git activity':dict(hours=1),'process inside':dict(ref=True),
               'uncommitted file':dict(dirty=True),'mounted':dict(mounted=True),
               'lock with a reason':dict(admin=('locked','Active work; preserve')),
               'paused rebase':dict(admin=('rebase-merge',None)),
               'worktree-only ref':dict(admin=('refs/bisect','')),}
        for why,c in cases.items():
            with self.subTest(why):
                self.tearDown();self.setUp()
                w,registry=self.idle_worktree(c.get('hours',13))
                if c.get('dirty'):(w/'new').write_text('work')
                if c.get('admin'):
                    name,text=c['admin'];f=self.root/'repo'/'.git'/'worktrees'/'w'/name
                    if text is None:f.mkdir()
                    elif text=='':f.mkdir(parents=True);(f/'bad').write_text('0'*40)
                    else:f.write_text(text)
                with patch.object(guard,'referenced',return_value=c.get('ref',False)):
                    self.g.release_idle(registry,[str(w)] if c.get('mounted') else [])
                self.assertNotIn('released_at',guard.read(self.g.state/'registry.json')['dev-owner:'+str(w)])

    def test_default_lock_does_not_keep_an_idle_worktree(self):
        w,registry=self.idle_worktree()
        (self.root/'repo'/'.git'/'worktrees'/'w'/'locked').write_text('added with --lock\n')
        with patch.object(guard,'referenced',return_value=False):self.g.release_idle(registry,[])
        self.assertTrue(guard.read(self.g.state/'registry.json')['dev-owner:'+str(w)]['auto_released'])

    def test_sweep_removes_an_idle_clean_worktree(self):
        w,registry=self.idle_worktree()
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[{'name':'dev-owner'}]})
        with patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'archive',side_effect=AssertionError('in Git: no archive')):
            self.g.sweep()
        self.assertFalse(w.exists())
        self.assertIn('removed_at',guard.read(self.g.state/'registry.json')['dev-owner:'+str(w)])

    def test_auto_released_worktree_used_again_is_never_archived(self):
        # Its agent came back: an auto-release must not turn into archive + removal under it.
        w,registry=self.idle_worktree()
        with patch.object(guard,'referenced',return_value=False):self.g.release_idle(registry,[])
        (w/'new').write_text('work')
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[{'name':'dev-owner'}]})
        with patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'archive',side_effect=AssertionError('must not archive')):
            self.g.sweep()
        self.assertTrue((w/'new').exists())
        e=guard.read(self.g.state/'registry.json')['dev-owner:'+str(w)]
        self.assertNotIn('released_at',e);self.assertNotIn('auto_released',e)

    def test_idle_check_does_not_touch_the_index(self):
        # `git status` refreshes the index; the check itself must not look like activity.
        w,registry=self.idle_worktree()
        index=self.root/'repo'/'.git'/'worktrees'/'w'/'index';before=index.stat().st_mtime
        (w/'a').touch()   # stat change git status would write back
        self.g.in_git(w)
        self.assertEqual(index.stat().st_mtime,before)

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

    def test_clean_pushed_worktree_is_removed_without_archive(self):
        # Archiving ~13 GB checkouts whose content is already on the remote took the sweep past
        # its 4 h limit every run, so nothing was ever removed and the disk filled up.
        ws=self.released('pushed','local')
        for p in ws.values():self.git(p,'gitdir: x\n')
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[]})
        archived=[];removed=[]
        def fake_run(args,*a,**k):
            args=[str(x) for x in args]
            if 'remove' in args:removed.append(args[-1]);shutil.rmtree(args[-1])
            return (str(self.root/'repo.git')+'\n').encode()
        def fake_archive(paths,kind,shared=(),require_stable=True):
            archived.append(sorted(map(str,paths)));return 'arch',{str(x):guard.signature(x) for x in paths}
        with patch.object(guard,'run',side_effect=fake_run), \
             patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'in_git',side_effect=lambda p:p.name=='pushed'), \
             patch.object(self.g,'pin_history',return_value=0), \
             patch.object(self.g,'git_storage',return_value=[]), \
             patch.object(self.g,'archive',side_effect=fake_archive):
            self.g.sweep()
        self.assertEqual(archived,[[str(ws['local'])]])
        self.assertEqual(removed[0],str(ws['pushed']),'clean copies go first, before any archive')
        reg=guard.read(self.g.state/'registry.json')
        self.assertIsNone(reg['pushed']['archive']);self.assertEqual(reg['local']['archive'],'arch')

    def test_clean_worktree_used_meanwhile_is_kept(self):
        w=self.released('w')['w'];self.git(w,'gitdir: x\n')
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[]})
        checks=iter([True,False])   # dirty by the time it is about to be removed
        with patch.object(guard,'run',return_value=(str(self.root/'repo.git')+'\n').encode()), \
             patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'in_git',side_effect=lambda p:next(checks)), \
             patch.object(self.g,'git_storage',return_value=[]), \
             patch.object(self.g,'archive',side_effect=AssertionError('must not archive')):
            self.g.sweep()
        self.assertTrue(w.exists())
        self.assertNotIn('removed_at',guard.read(self.g.state/'registry.json')['w'])

    def test_in_git_requires_clean_tree_pushed_head_and_only_generated_ignores(self):
        git=lambda *a,cwd:subprocess.run(['git','-c','user.name=t','-c','user.email=t@t','-c','init.defaultBranch=main',*a],cwd=cwd,check=True,capture_output=True)
        remote=self.root/'remote.git';git('init','--bare',str(remote),cwd=self.root)
        repo=self.root/'repo';git('clone',str(remote),str(repo),cwd=self.root)
        (repo/'.gitignore').write_text('__pycache__/\n.env\n');(repo/'a').write_text('a')
        git('add','.',cwd=repo);git('commit','-m','a',cwd=repo);git('push','origin','HEAD',cwd=repo)
        w=self.root/'wt';git('worktree','add','--detach',str(w),cwd=repo)
        self.assertTrue(self.g.in_git(w))
        (w/'__pycache__').mkdir();(w/'__pycache__'/'x.pyc').write_text('x')
        self.assertTrue(self.g.in_git(w),'regenerable ignored output is not work')
        (w/'.env').write_text('SECRET=1')
        self.assertFalse(self.g.in_git(w),'ignored local config exists nowhere else');(w/'.env').unlink()
        (w/'build').mkdir();(w/'build'/'.env').write_text('SECRET=1')
        self.assertFalse(self.g.in_git(w),'a secret inside an output-named dir is still a secret');shutil.rmtree(w/'build')
        git('update-index','--skip-worktree','a',cwd=w);(w/'a').write_text('hidden')
        self.assertFalse(self.g.in_git(w),'edits hidden by skip-worktree')
        git('update-index','--no-skip-worktree','a',cwd=w);git('checkout','a',cwd=w)
        self.assertTrue(self.g.in_git(w))
        git('sparse-checkout','set','--no-cone','/*','!/a',cwd=w)
        self.assertFalse((w/'a').exists())
        self.assertTrue(self.g.in_git(w),'a file a sparse checkout left out holds no work')
        git('sparse-checkout','disable',cwd=w)
        (w/'new').write_text('n')
        self.assertFalse(self.g.in_git(w),'untracked file');(w/'new').unlink()
        (w/'a').write_text('changed')
        self.assertFalse(self.g.in_git(w),'modified file')
        git('commit','-am','local',cwd=w)
        self.assertFalse(self.g.in_git(w),'commit not on any remote')
        (w/'b').write_text('b');git('add','b',cwd=w);git('commit','-m','detached work',cwd=w)
        left=subprocess.run(['git','rev-parse','HEAD'],cwd=w,capture_output=True,text=True).stdout.strip()
        git('checkout','--detach','origin/main',cwd=w)
        self.assertTrue(self.g.in_git(w),'files are all in Git; history is pinned separately')
        self.assertEqual(self.g.pin_history(w),2,'both commits left behind exist only in the reflog')
        pinned=subprocess.run(['git','for-each-ref','--format=%(objectname)','refs/devbox/released/'],cwd=repo,capture_output=True,text=True).stdout.split()
        self.assertIn(left,pinned)
        git('worktree','remove',str(w),cwd=repo);git('gc','--prune=now',cwd=repo)
        git('cat-file','-e',left,cwd=repo)
        pins=lambda:subprocess.run(['git','for-each-ref','--format=%(objectname)','refs/devbox/released/'],cwd=repo,capture_output=True,text=True).stdout.split()
        git('branch','keep',left,cwd=repo)
        self.assertEqual(self.g.expire_pins(repo),2,'a branch now holds both (the second is its parent)')
        self.assertEqual(pins(),[])
        git('update-ref','refs/devbox/released/x',left,cwd=repo);git('branch','-D','keep',cwd=repo)
        self.assertEqual(self.g.expire_pins(repo),0,'unreachable and recent: kept')
        self.g.c['released_pin_days']=-1
        self.assertEqual(self.g.expire_pins(repo),1,'older than the limit')
        self.assertEqual(pins(),[])

    def test_archive_batches_persist_progress_and_stop_at_budget(self):
        self.g.c.update(sweep_batch_size=2,sweep_budget_seconds=0)
        ws=self.released('a','b','c')
        for p in ws.values():self.git(p,'gitdir: x\n')
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[]})
        archived=[]
        def fake_run(args,*a,**k):
            args=[str(x) for x in args]
            if 'remove' in args:shutil.rmtree(args[-1])
            return (str(self.root/'repo.git')+'\n').encode()
        def fake_archive(paths,kind,shared=(),require_stable=True):
            archived.append(len(paths));return 'arch',{str(x):guard.signature(x) for x in paths}
        with patch.object(guard,'run',side_effect=fake_run), \
             patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'in_git',return_value=False), \
             patch.object(self.g,'git_storage',return_value=[]), \
             patch.object(self.g,'notify') as notify, \
             patch.object(self.g,'archive',side_effect=fake_archive):
            self.g.sweep()
        self.assertEqual(archived,[2],'one batch always runs, no new batch past the budget')
        reg=guard.read(self.g.state/'registry.json')
        self.assertEqual(sum('removed_at' in e for e in reg.values()),2)
        self.assertEqual(notify.call_args.args[0],'sweep-backlog')
        self.g.c.update(sweep_budget_seconds=3600)
        with patch.object(guard,'run',side_effect=fake_run), \
             patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'in_git',return_value=False), \
             patch.object(self.g,'git_storage',return_value=[]), \
             patch.object(self.g,'archive',side_effect=fake_archive):
            self.g.sweep()
        self.assertEqual(archived,[2,1],'the next run continues with the rest')

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

    def test_checkout_slots_limit_parallel_worktree_adds_per_repository(self):
        # Five parallel 13 GB `worktree add` saturated the disk and devd hung for 12 minutes.
        repo=self.root/'repo';subprocess.run(['git','init','-q',str(repo)],check=True)
        held=[client.checkout_slot(['-C',str(repo)],slots=2,wait=0) for _ in range(2)]
        self.assertTrue(all(held))
        with self.assertRaises(TimeoutError):
            client.checkout_slot(['-C',str(repo)],slots=2,wait=0)
        held[0].close()
        self.assertIsNotNone(client.checkout_slot(['-C',str(repo)],slots=2,wait=0),'a freed slot is reused')

    def test_worktree_add_is_sparse_when_the_repository_asks_for_it(self):
        git=lambda *a,cwd:subprocess.run(['git','-c','user.name=t','-c','user.email=t@t','-c','init.defaultBranch=main',*a],cwd=cwd,check=True,capture_output=True)
        src=self.root/'src';src.mkdir();git('init',cwd=src)
        (src/'props').mkdir();(src/'props'/'big.bin').write_text('x');(src/'code.lua').write_text('c')
        git('add','.',cwd=src);git('commit','-m','a',cwd=src)
        bare=self.root/'r.git';git('clone','--bare',str(src),str(bare),cwd=self.root)
        git('update-ref','refs/remotes/origin/main','main',cwd=bare)  # HEAD is pushed
        main=self.root/'main';git('worktree','add',str(main),'main',cwd=bare)
        add=lambda path,**env:subprocess.run([sys.executable,str(Path(client.__file__)),'git','-C',str(main),'worktree','add','--detach',str(path)],
                                             env={**os.environ,'DEVBOX_STORAGE_STATE':str(self.root/'none.json'),**env},capture_output=True,text=True)
        r=add(self.root/'full');self.assertEqual(r.returncode,0,r.stderr)
        self.assertTrue((self.root/'full'/'props'/'big.bin').exists(),'no pattern file: full checkout')
        (bare/'devbox-sparse-checkout').write_text('# assets\n/*\n!/props/\n')
        r=add(self.root/'sparse');self.assertEqual(r.returncode,0,r.stderr)
        self.assertTrue((self.root/'sparse'/'code.lua').exists())
        self.assertFalse((self.root/'sparse'/'props').exists())
        self.assertIn('sparse-checkout disable',r.stderr)
        self.assertEqual(subprocess.run(['git','status','--porcelain'],cwd=self.root/'sparse',capture_output=True,text=True).stdout,'')
        self.assertTrue(self.g.in_git(self.root/'sparse'),'the fast sweep accepts it')
        self.assertTrue((main/'props'/'big.bin').exists(),'other worktrees keep their files')
        r=add(self.root/'optout',DEVBOX_FULL_CHECKOUT='1');self.assertEqual(r.returncode,0,r.stderr)
        self.assertTrue((self.root/'optout'/'props'/'big.bin').exists())
        shutil.rmtree(self.root/'sparse')  # a stale registration, as prune is refused in sessions
        r=subprocess.run([sys.executable,str(Path(client.__file__)),'git','-C',str(main),'worktree','add','-f','--detach','../sparse'],
                         env={**os.environ,'DEVBOX_STORAGE_STATE':str(self.root/'none.json')},capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertTrue((self.root/'sparse'/'code.lua').exists(),'a reused registration is filled too')
        self.assertEqual(subprocess.run(['git','status','--porcelain'],cwd=self.root/'sparse',capture_output=True,text=True).stdout,'')

    def test_worktree_add_path_from_argv(self):
        base=Path('/w')
        for rest,want in ((['worktree','add','p'],'/w/p'),(['worktree','add','-b','x','p','main'],'/w/p'),
                          (['worktree','add','-f','--detach','-q','/abs/p'],'/abs/p'),(['worktree','add','--reason','r','--lock','p'],'/w/p'),
                          (['worktree','add','--','-p'],'/w/-p'),(['worktree','add','-b','x'],None)):
            self.assertEqual(client.worktree_add_path(rest,base),want,rest)

    def test_lost_worktree_registration_is_detected(self):
        ws=self.root/'ws';ws.mkdir();reg=self.root/'repo.git'/'worktrees'/'ws';reg.mkdir(parents=True)
        (ws/'.git').write_text(f'gitdir: {reg}\n')
        self.assertFalse(guard.lost_registration(ws))
        reg.rmdir()
        self.assertTrue(guard.lost_registration(ws))
        (ws/'.git').unlink();(ws/'.git').mkdir()
        self.assertFalse(guard.lost_registration(ws),'a plain clone has a .git directory')
        self.assertFalse(guard.lost_registration(self.root/'missing'))

    def test_checkout_slot_outside_a_repository_is_left_to_git(self):
        self.assertIsNone(client.checkout_slot(['-C',str(self.root)],slots=2,wait=0))

    def test_checkout_slots_are_published_to_sessions(self):
        control=self.root/'var'/'lib'/'devd'/'s';control.mkdir(parents=True)
        self.g.c['checkout_slots']=3
        with patch.object(guard,'beneath',return_value=True):
            self.g.publish([dict(name='dev-a',control=str(control),bytes=0,measured_at=1)],dict(percent=1,available_bytes=10**15))
        self.assertEqual(guard.read(control/'storage-state.json')['checkout_slots'],3)

    def test_worktree_prune_is_refused_inside_sessions(self):
        with patch.dict(os.environ,{'DEVD_SESSION_ID':'dev-a'}):
            self.assertTrue(client.shared_prune('git',['-C','/workspace','worktree','prune']))
            self.assertFalse(client.shared_prune('git',['worktree','remove','x']))
        with patch.dict(os.environ,{k:v for k,v in os.environ.items() if k!='DEVD_SESSION_ID'},clear=True):
            self.assertFalse(client.shared_prune('git',['worktree','prune']))

    def orphan(self, name, age=7200):
        bare=self.root/'fivem'/'repo.git';(bare/'objects').mkdir(parents=True,exist_ok=True)
        d=self.root/'_sessions'/name;(d/'.worktrees'/'x').mkdir(parents=True);(d/'file').write_text('work')
        (d/'.git').write_text(f'gitdir: {bare}/worktrees/{name}\n')
        admin=bare/'worktrees'/name;admin.mkdir(parents=True);(admin/'gitdir').write_text(f'{d}/.git\n');(admin/'locked').write_text('')
        old=time.time()-age
        for x in (d,d/'.git'):os.utime(x,(old,old))
        return d,admin

    def run_orphan_sweep(self, live=(), containers=(), archived=None):
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[]})
        guard.atomic(self.g.state/'containers.json',[{'Id':'x','Name':'/'+n,'Mounts':[],'State':{}} for n in containers])
        guard.atomic(self.g.state/'registry.json',{})
        def fake_archive(paths,kind,shared=(),require_stable=True):
            if archived is not None:archived.extend(map(str,paths))
            return 'arch',{str(Path(x).resolve()):guard.signature(Path(x).resolve()) for x in paths}
        with patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'devd_sessions',return_value=set(live)), \
             patch.object(self.g,'container_exists',side_effect=lambda n:n in containers), \
             patch.object(self.g,'archive',side_effect=fake_archive):
            self.g.sweep()

    def test_orphan_session_dir_is_archived_and_removed_with_its_registration(self):
        # Ended sessions whose workspace devd retained (or a failed start) stayed on disk forever,
        # and a leftover LOCKED registration then broke a new session with the same name.
        d,admin=self.orphan('dev-p-r-3')
        archived=[]
        self.run_orphan_sweep(archived=archived)
        self.assertEqual(archived,[str(d)])
        self.assertFalse(d.exists());self.assertFalse(admin.exists())

    def test_session_known_to_devd_or_with_container_is_kept(self):
        a,_=self.orphan('dev-p-r-4');b,_=self.orphan('dev-p-r-5')
        self.run_orphan_sweep(live=['dev-p-r-4'],containers=['dev-p-r-5'])
        self.assertTrue(a.exists());self.assertTrue(b.exists())

    def test_recent_session_dir_is_kept(self):
        # devd checks the worktree out before the container exists.
        d,_=self.orphan('dev-p-r-6',age=60)
        self.run_orphan_sweep()
        self.assertTrue(d.exists())

    def test_empty_devd_list_with_session_containers_removes_nothing(self):
        d,_=self.orphan('dev-p-r-8')
        self.run_orphan_sweep(live=(),containers=['dev-other-1'])
        self.assertTrue(d.exists())

    def test_detached_head_of_orphan_is_pinned_and_registration_archived(self):
        d,admin=self.orphan('dev-p-r-9')
        sha='a'*40;(admin/'HEAD').write_text(sha+'\n');(admin/'commondir').write_text('../..\n')
        archived=[];calls=[]
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[]})
        guard.atomic(self.g.state/'containers.json',[]);guard.atomic(self.g.state/'registry.json',{})
        def fake_archive(paths,kind,shared=(),require_stable=True):
            archived.extend(map(str,shared));return 'arch',{str(Path(x).resolve()):guard.signature(Path(x).resolve()) for x in paths}
        with patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'devd_sessions',return_value=set()), \
             patch.object(self.g,'container_exists',return_value=False), \
             patch.object(guard,'run',side_effect=lambda a,*x,**k:calls.append([str(v) for v in a]) or b''), \
             patch.object(self.g,'archive',side_effect=fake_archive):
            self.g.sweep()
        self.assertIn(str(admin),archived)
        self.assertTrue(any('update-ref' in c and 'refs/devbox/ended/dev-p-r-9' in c and sha in c for c in calls))
        self.assertFalse(d.exists())

    def test_session_claimed_during_archive_is_kept(self):
        d,_=self.orphan('dev-p-r-10')
        answers=iter([set(),{'dev-p-r-10'}])
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[]})
        guard.atomic(self.g.state/'containers.json',[]);guard.atomic(self.g.state/'registry.json',{})
        with patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'devd_sessions',side_effect=lambda:next(answers)), \
             patch.object(self.g,'container_exists',return_value=False), \
             patch.object(self.g,'archive',side_effect=lambda paths,*a,**k:('arch',{str(Path(x).resolve()):guard.signature(Path(x).resolve()) for x in paths})):
            self.g.sweep()
        self.assertTrue(d.exists())

    def test_unreachable_devd_removes_no_session_dir(self):
        d,_=self.orphan('dev-p-r-7')
        guard.atomic(self.g.state/'inventory.json',{'time':time.time(),'sessions':[]})
        guard.atomic(self.g.state/'containers.json',[])
        with patch.object(guard,'referenced',return_value=False), \
             patch.object(self.g,'devd_sessions',side_effect=OSError('connection refused')), \
             patch.object(self.g,'archive',side_effect=AssertionError('must not archive')):
            self.g.sweep()
        self.assertTrue(d.exists())

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

    def preserve_with_unit(self,states,ready_after):
        """preserve() against a fake systemd: `states` are the unit's successive ActiveStates (the last repeats);
        the proof lands after `ready_after` inspections. Returns the systemd-run calls."""
        c={'Id':'0123456789abcdef','Name':'/dev-fixture','State':{'Running':False}}
        g=Mock()
        checks=[]
        g.end_ready.side_effect=lambda c,fresh=None:(fresh is None and (checks.append(1) or len(checks)>=ready_after))
        states=list(states);started=[]
        def fake_run(cmd,**k):
            if cmd[0]=='systemd-run':
                started.append(cmd);return SimpleNamespace(returncode=0,stdout='',stderr='')
            state=states.pop(0) if len(states)>1 else states[0]
            if cmd[:2]==['systemctl','show']:
                return SimpleNamespace(returncode=0,stdout=state+'\n',stderr='')
            if cmd[:2]==['systemctl','is-active']:  # as systemd answers it: 0 for "active" only
                return SimpleNamespace(returncode=0 if state=='active' else 3,stdout='',stderr='')
            raise AssertionError(cmd)
        with patch.object(host.subprocess,'run',side_effect=fake_run),patch.object(host,'inspect',return_value=c),patch.object(host.time,'sleep'):
            host.preserve(g,c)
        return started

    def test_preservation_already_activating_is_waited_for_not_started_again(self):
        # A oneshot prepare-end is "activating" for as long as it runs: a second systemd-run of its name would fail.
        self.assertEqual(self.preserve_with_unit(['activating'],ready_after=3),[])

    def test_preservation_is_started_once_and_waited_for_while_activating(self):
        started=self.preserve_with_unit(['inactive','activating'],ready_after=3)
        self.assertEqual(len(started),1)
        self.assertIn('devbox-storage-end-0123456789ab',started[0])

    def test_preservation_that_finished_between_checks_is_not_called_failed(self):
        # --collect: a finished unit is gone (inactive) by the time it is asked; its proof decides.
        # The first inspection sees no proof yet; the unit has finished by the time it is asked.
        self.assertEqual(len(self.preserve_with_unit(['inactive','inactive'],ready_after=2)),1)

    def test_failed_preservation_denies_removal(self):
        with self.assertRaisesRegex(RuntimeError,'Offsite preservation failed'):
            self.preserve_with_unit(['inactive','failed'],ready_after=99)

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
