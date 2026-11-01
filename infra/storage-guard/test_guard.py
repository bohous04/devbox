import importlib.util
import json
import os
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

    def test_sweep_fails_closed_when_inventory_stale(self):
        guard.atomic(self.g.state/'inventory.json',{'time':1,'sessions':[]})
        with self.assertRaisesRegex(RuntimeError,'Stale'):self.g.sweep()

    def test_disk_samples_keep_actual_growth_window(self):
        baseline={'time':time.time()-3600,'used_bytes':100,'available_bytes':1000000,'percent':1}
        guard.atomic(self.g.state/'disk-history.json',[baseline])
        with patch.object(self.g,'disk',return_value={'time':time.time(),'used_bytes':200,'available_bytes':1000000,'percent':1}),patch.object(self.g,'publish'),patch.object(self.g,'notify'):
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


if __name__=='__main__':unittest.main()
