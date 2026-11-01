#!/usr/bin/env python3
"""Manual live offsite restore/sweep verification, using unique disposable fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

spec=importlib.util.spec_from_file_location('guard',Path('/usr/local/lib/devbox-storage/guard.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
g=m.Guard(m.read(m.DEFAULT_CONFIG))
token=uuid.uuid4().hex[:10]
root=g.root/('_storage-guard-test-'+token)
repo=root/'repo'
owner='dev-storage-guard-fixture-'+token
owner_root=g.root/'_sessions'/owner
work=owner_root/'.worktrees'/'probe'
repo.mkdir(parents=True)
def git(cwd,*args):
    return m.run(['/usr/bin/git','-c','safe.directory=*','-c','user.name=StorageGuard',
                  '-c','user.email=storage@localhost','-C',cwd,*args]).decode().strip()
git(repo,'init')
(repo/'tracked.txt').write_text('baseline\n')
(repo/'.gitignore').write_text('*.tmp\n')
git(repo,'add','.')
git(repo,'commit','-m','disposable fixture baseline')
work.parent.mkdir(parents=True)
git(repo,'worktree','add','--detach',str(work),'HEAD')
(work/'tracked.txt').write_text('unique detached commit\n')
git(work,'commit','-am','disposable fixture detached commit')
head=git(work,'rev-parse','HEAD')
(work/'tracked.txt').write_text('uncommitted change\n')
(work/'untracked.txt').write_text('untracked preservation\n')
(work/'ignored.tmp').write_text('ignored preservation\n')
common=repo/'.git'
paths=[work,*g.git_storage(common)]
archive,_=g.archive(paths,'smoke-worktree')
with tempfile.TemporaryDirectory(prefix='storage-guard-restore-',dir='/var/tmp') as target:
    subprocess.run(['borg','--lock-wait','30','extract',g.c['borg_repo']+'::'+archive],
                   env=g.borg_env(),cwd=target,check=True,timeout=300)
    restored=Path(target)/str(work).lstrip('/')
    assert (restored/'tracked.txt').read_text()=='uncommitted change\n'
    assert (restored/'untracked.txt').read_text()=='untracked preservation\n'
    assert (restored/'ignored.tmp').read_text()=='ignored preservation\n'
    restored_git=Path(target)/str(common).lstrip('/')
    m.run(['/usr/bin/git','--git-dir',restored_git,'cat-file','-e',head+'^{commit}'])
g.audit('worktree-restore-test-passed',archive=archive,detached_head=head,
        verified=['dirty tracked','untracked','ignored','detached commit objects'])
# Actual removal is authorized only AFTER the independent restoration succeeded.
registry=m.read(g.state/'registry.json',{})
key=owner+':'+str(work)
registry[key]=dict(session=owner,path=str(work),released_at=time.time()-90000,created_by_guard=True)
m.atomic(g.state/'registry.json',registry)
g.sweep()
assert not work.exists(), 'Verified disposable fixture was not swept'
saved=m.read(g.state/'registry.json')[key]
assert saved.get('archive') and saved.get('removed_at')
print(json.dumps(dict(worktree_restore=True,verified_sweep=True,archive=saved['archive'])))
# Only our uniquely named test roots are removed; their data is already verified offsite.
shutil.rmtree(root)
shutil.rmtree(owner_root)
