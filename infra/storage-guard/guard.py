#!/usr/bin/env python3
"""Devbox storage accounting, lifecycle preservation and conservative retention.

Unregistered directories/volumes are never automatically deleted. All destructive
retention requires an offsite archive, full Borg integrity read and stable source.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

GIB = 2**30
DEFAULT_CONFIG = Path('/etc/devbox-storage/config.json')
DOCKER = '/usr/bin/docker'


def run(args, timeout=300, **kw):
    p = subprocess.run([str(a) for a in args], capture_output=True, timeout=timeout, **kw)
    if p.returncode:
        raise RuntimeError(f'{Path(str(args[0])).name} {str(args[1])[:50]} failed (rc={p.returncode}): ' +
                           p.stderr.decode(errors='replace')[-800:])
    return p.stdout


def atomic(path, data, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def read(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return default


def du(path):
    return int(run(['du', '-sxB1', '--', path], timeout=600).split()[0])


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def signature(path, hash_content=True):
    """No symlink following. Include ctime/inode to catch replacements during backup.
    hash_content=False keeps the regular-file content slot empty (metadata only)."""
    path = Path(path)
    out = []
    def add(p):
        s = p.lstat()
        # Device nodes, FIFOs and sockets carry no data of their own (nested Docker keeps
        # e.g. volumes/backingFsBlockDev and apt's auxfiles FIFO). Borg stores them as
        # metadata; mode+inode+rdev below still catch a replacement. Rejecting them
        # made every End of a dind session fail permanently.
        special = not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode))
        # Metadata alone misses same-size rewrites within one filesystem timestamp
        # tick. Every regular file is hashed before AND after preservation.
        content = ((digest(p) if hash_content else None) if stat.S_ISREG(s.st_mode) else os.readlink(p) if stat.S_ISLNK(s.st_mode)
                   else f'rdev:{s.st_rdev}' if special else None)
        after = p.lstat()
        if (s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):
            raise RuntimeError('Source changed while calculating preservation manifest')
        out.append((str(p.relative_to(path.parent)), s.st_mode, s.st_dev, s.st_ino,
                    s.st_size, s.st_mtime_ns, s.st_ctime_ns, content))
    add(path)
    if path.is_dir() and not path.is_symlink():
        for parent, dirs, files in os.walk(path, followlinks=False):
            for name in sorted(dirs + files):
                add(Path(parent) / name)
    return sorted(out)


def beneath(path, root):
    p, r = Path(path).resolve(), Path(root).resolve()
    return p != r and r in p.parents


def referenced(path):
    """Conservative scan of cwd/root/fds, including processes inside containers."""
    if not Path('/proc').is_dir():
        return True  # No reliable live reference inventory: never authorize removal.
    target = str(Path(path).resolve())
    source=Path(path).stat()
    identity=(source.st_dev,source.st_ino)
    directory=stat.S_ISDIR(source.st_mode)
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        candidates = [proc / 'cwd', proc / 'root']
        try:
            candidates += list((proc / 'fd').iterdir())
        except FileNotFoundError:
            continue
        except PermissionError:
            return True
        for f in candidates:
            try:
                v = os.readlink(f).removesuffix(' (deleted)')
                if v == target or v.startswith(target + '/'):
                    return True
                # readlink uses the process namespace: /workspace/foo can be the
                # SAME file as /srv/dev/_sessions/owner/foo. Compare inode/device,
                # then walk parents through that process's magic procfs root.
                fs=f.stat()
                if (fs.st_dev,fs.st_ino)==identity:
                    return True
                if directory and fs.st_dev==source.st_dev and v.startswith('/'):
                    p=Path(v)
                    for parent in (p,*p.parents):
                        try:
                            s=(proc/'root'/str(parent).lstrip('/')).stat()
                            if (s.st_dev,s.st_ino)==identity:return True
                        except FileNotFoundError:
                            continue
            except FileNotFoundError:
                pass
            except PermissionError:
                return True
    return False


def held_files(paths):
    """Batch regular-file reference check: one procfs walk for the whole batch."""
    paths=[Path(p) for p in paths]
    identities={(p.stat().st_dev,p.stat().st_ino):p for p in paths}
    held=set()
    if not Path('/proc').is_dir():return set(paths)
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name)==os.getpid():continue
        try:
            links=[proc/'cwd',proc/'root',*list((proc/'fd').iterdir())]
            for f in links:
                try:
                    s=f.stat()
                    p=identities.get((s.st_dev,s.st_ino))
                    if p:held.add(p)
                except (FileNotFoundError,ProcessLookupError):pass
        except (FileNotFoundError,ProcessLookupError):pass
        except PermissionError:return set(paths)
    return held


class Guard:
    def __init__(self, cfg):
        self.c = cfg
        self.root = Path(cfg['root'])
        self.state = Path(cfg['state_dir'])
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)

    def audit(self, action, **values):
        with (self.state / 'actions.jsonl').open('a') as f:
            f.write(json.dumps(dict(time=time.time(), action=action, **values)) + '\n')

    def borg_env(self):
        env = dict(os.environ)
        # Never put passphrases in argv, logs or persisted JSON.
        import shlex
        env.update(BORG_PASSCOMMAND='cat ' + shlex.quote(self.c['borg_passfile']),
                   BORG_RSH='ssh -i ' + shlex.quote(self.c['borg_key']) +
                   ' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15',
                   BORG_REMOTE_PATH='borg-1.4', BORG_RELOCATED_REPO_ACCESS_IS_OK='no',
                   BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK='no')
        return env

    def borg(self, args, timeout=7200, allow_warning=False):
        if not allow_warning:
            return run(['borg', '--lock-wait', '30', *args], timeout=timeout, env=self.borg_env())
        p = subprocess.run(['borg', '--lock-wait', '30', *args], capture_output=True, timeout=timeout, env=self.borg_env())
        if p.returncode not in (0, 1):
            raise RuntimeError(f'borg {args[0]} failed (rc={p.returncode}): ' + p.stderr.decode(errors='replace')[-800:])
        return p.stdout

    def archive(self, paths, kind, shared=()):
        """`shared` = Git common store of a repo other live sessions keep writing to
        (new objects, refs, their worktrees/*). It is archived, but not required to
        be stable: removal never deletes it, and requiring it would deny every End
        while any sibling session commits. Only `paths` authorize deletion."""
        paths = [Path(p).resolve() for p in paths]
        shared = [Path(p).resolve() for p in shared if Path(p).resolve() not in paths]
        if not paths or any(p == Path('/') for p in paths + shared):
            raise RuntimeError('Unsafe archive path')
        name = 'storage-guard-' + kind + '-' + time.strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:8]
        dest = self.c['borg_repo'] + '::' + name
        before = {str(p): signature(p) for p in paths}
        # Exit code 1 is also a failure here: changing files cannot authorize deletion.
        # With shared sources a warning can only come from them — owned paths are
        # re-verified by signature below, so rc=1 is accepted in that case alone.
        create = ['create', '--compression', 'zstd,3', dest, *map(str, paths + shared)]
        self.borg(create, allow_warning=True) if shared else self.borg(create)
        self.borg(['extract', '--dry-run', dest])
        if before != {str(p): signature(p) for p in paths}:
            raise RuntimeError('Source changed during backup; deletion denied')
        self.audit('archive-verified', archive=name, paths=list(before), shared=list(map(str, shared)))
        return name, before

    def notify(self, key, message):
        if not self.c.get('notify_enabled', True):
            self.audit('notification-suppressed',key=key)
            return
        f = self.state / 'notifications.json'
        previous = read(f, {})
        if time.time() - previous.get(key, 0) < self.c['notify_cooldown_seconds']:
            return
        body = json.dumps({'title': 'Devbox: místo na disku', 'message': message}).encode()
        req = urllib.request.Request(self.c['notify_url'], data=body, headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                if r.status not in (200, 204):
                    raise RuntimeError('Notification rejected')
            previous[key] = time.time()
            atomic(f, previous)
        except Exception as e:
            self.audit('notification-failed', reason=str(e))

    def disk(self):
        s = os.statvfs(self.root)
        used = (s.f_blocks - s.f_bfree) * s.f_frsize
        avail = s.f_bavail * s.f_frsize
        percent = 100 * used / (used + avail)
        return dict(time=time.time(), used_bytes=used, available_bytes=avail, percent=round(percent, 2))

    def sample(self):
        current = self.disk()
        history_file = self.state / 'disk-history.json'
        hist = read(history_file, [])
        baseline = min((h for h in hist if h['time'] >= time.time() - 86400),
                       key=lambda h: h['time'], default=current)
        current['growth_bytes_24h'] = current['used_bytes'] - baseline['used_bytes']
        current['growth_window_seconds'] = current['time'] - baseline['time']
        atomic(history_file, [h for h in hist if h['time'] > time.time() - 8 * 86400] + [current])
        atomic(self.state / 'disk.json', current)
        inventory = read(self.state / 'inventory.json', {})
        top = sorted(inventory.get('sessions', []), key=lambda x:x['bytes'], reverse=True)[:3]
        attribution = '; největší sessions: ' + ', '.join(f"{r['name']} {r['bytes']/GIB:.1f} GiB" for r in top) if top else ''
        alerts = []
        if current['percent'] >= self.c['disk_warn_percent'] or current['available_bytes'] < self.c['reserve_gib'] * GIB:
            alerts.append(f"Disk {current['percent']:.1f} %, volno {current['available_bytes']/GIB:.1f} GiB" + attribution)
        if current['growth_bytes_24h'] >= self.c['daily_growth_gib'] * GIB:
            alerts.append(f"Nárůst {current['growth_bytes_24h']/GIB:.1f} GiB za posledních {current['growth_window_seconds']/3600:.1f} h" + attribution)
        for message in alerts:
            self.notify('disk' if message.startswith('Disk') else 'growth', message)
        self.publish(inventory.get('sessions', []), current)
        return current

    def publish(self, sessions, disk):
        for row in sessions:
            control = row.get('control')
            if not control or not beneath(control, '/var/lib/devd'):
                continue
            global_block = disk['percent'] >= self.c['disk_block_percent'] or disk['available_bytes'] < self.c['reserve_gib'] * GIB
            limits=self.c.get('session_limits',{}).get(row['name'],{})
            block_gib=limits.get('block_gib',self.c['session_block_gib'])
            blocked = global_block or row['bytes'] >= block_gib * GIB
            value = dict(measured_at=row['measured_at'], blocked=blocked,
                         reason=('Global disk emergency threshold reached.' if global_block else
                                 f'Session storage budget exceeded ({block_gib} GiB; workspace + writable layer + nested Docker).' if blocked else 'Within current storage budget.'),
                         budget_gib=block_gib,
                         reserve_bytes=self.c['reserve_gib'] * GIB, bytes=row['bytes'])
            atomic(Path(control) / 'storage-state.json', value, 0o644)

    def inventory(self):
        ids = run([DOCKER, 'ps', '-aq']).decode().split()
        containers = json.loads(run([DOCKER, 'inspect', '--size', *ids], timeout=900)) if ids else []
        old = read(self.state / 'inventory.json', {})
        rows = []
        for c in containers:
            name = c['Name'].lstrip('/')
            if not name.startswith('dev-'):
                continue
            mounts = {m['Destination']:m for m in c['Mounts']}
            workspace = mounts.get('/workspace', {}).get('Source')
            control = mounts.get('/run/devd', {}).get('Source')
            paths = [workspace] if workspace else []
            dind = next((d for d in containers if d['Name'] == '/dind-' + name), None)
            if dind:
                paths += [m['Source'] for m in dind['Mounts'] if m['Destination'] == '/var/lib/docker']
            parts = {'writable_layer': c.get('SizeRw', 0)}
            for p in set(paths):
                if Path(p).exists():
                    parts[p] = du(p)
            row = dict(name=name, running=c['State']['Running'], workspace=workspace,
                       control=control, bytes=sum(parts.values()), parts=parts, measured_at=time.time())
            prev = next((r for r in old.get('sessions', []) if r['name'] == name), None)
            row['growth_since_last_bytes'] = row['bytes'] - prev['bytes'] if prev else 0
            rows.append(row)
            try:
                self.install_client(c, row)
            except RuntimeError:
                # A container can stop/disappear while the inventory traverses
                # another session. This expected race must not discard all rows.
                current=subprocess.run([DOCKER,'inspect','-f','{{.State.Running}}',name],capture_output=True)
                if current.returncode==0 and current.stdout.strip()==b'true':
                    raise
                row['running']=False
                self.audit('session-stopped-during-inventory',name=name)
            limits=self.c.get('session_limits',{}).get(name,{})
            warn=limits.get('warn_gib',self.c['session_warn_gib'])
            block=limits.get('block_gib',self.c['session_block_gib'])
            crossed=prev and prev['bytes']<warn*GIB<=row['bytes']
            grew=prev and row['bytes']-prev['bytes']>=10*GIB
            if row['bytes']>=warn*GIB and (crossed or grew):
                self.notify('session-' + name, f"{name}: {row['bytes']/GIB:.1f} GiB. Uložená data přibývají; běžící práce pokračuje. Ochranná mez pro další kopie/buildy je {block} GiB.")
        data = dict(time=time.time(), sessions=rows)
        atomic(self.state / 'inventory.json', data)
        atomic(self.state / 'containers.json', [{k:c[k] for k in ('Id','Name','Mounts','State')} for c in containers])
        self.collect_events(rows)
        self.discover(rows)
        self.publish(rows, self.disk())
        self.audit('inventory', session_count=len(rows))
        return data

    def install_client(self, c, row):
        if not c['State']['Running']:
            return
        client = Path(__file__).resolve().with_name('client.py')
        # Compare content: don't touch files repeatedly or overwrite custom wrappers.
        sha = hashlib.sha256(client.read_bytes()).hexdigest()
        check = subprocess.run([DOCKER,'exec','-u','0',row['name'],'sha256sum','/usr/local/lib/devbox-storage/client.py'], capture_output=True)
        if not check.stdout.decode().startswith(sha):
            run([DOCKER,'exec','-u','0',row['name'],'mkdir','-p','/usr/local/lib/devbox-storage'])
            run([DOCKER,'cp',str(client),row['name']+':/usr/local/lib/devbox-storage/client.py'])
            run([DOCKER,'exec','-u','0',row['name'],'chmod','755','/usr/local/lib/devbox-storage/client.py'])
            for tool in ('git','docker','devbox-scratch'):
                # -s without -f: an unrelated existing wrapper is never overwritten.
                r = subprocess.run([DOCKER,'exec','-u','0',row['name'],'ln','-s','/usr/local/lib/devbox-storage/client.py','/usr/local/bin/'+tool], capture_output=True)
                if r.returncode:
                    self.audit('client-link-existing', session=row['name'], tool=tool)
            # Reuse the existing shared profile mount; no new mount/restart needed.
            cache=Path('/var/lib/docker/volumes/claude-home/_data/.cache/npm')
            cache.mkdir(parents=True,exist_ok=True)
            os.chown(cache,1000,1000)
            os.chown(cache.parent,1000,1000)
            # npm writes its own config without exposing any credentials in output.
            r=subprocess.run([DOCKER,'exec','-u','1000',row['name'],'/usr/bin/npm',
                              'config','set','cache','/home/dev/.claude/.cache/npm','--location=user'],capture_output=True)
            if r.returncode:
                self.audit('shared-cache-config-failed',session=row['name'])
        # Limit existing processes and their children without restarting any session.
        proc = subprocess.run([DOCKER,'top',row['name'],'-eo','pid'],capture_output=True)
        for pid in proc.stdout.decode().splitlines()[1:]:
            if pid.strip().isdigit():
                subprocess.run(['prlimit','--pid',pid.strip(),'--core=0:0'],capture_output=True)

    def collect_events(self, rows):
        registry = read(self.state / 'registry.json', {})
        for r in rows:
            if not r.get('control'):
                continue
            root = Path(r['control']) / 'storage-events'
            if not beneath(root, '/var/lib/devd') or root.is_symlink():
                continue
            for p in list(root.glob('*.json'))[:10000]:
                try:
                    if p.is_symlink() or p.stat().st_size > 16384:
                        continue
                    e = read(p)
                    if e.get('session') != r['name'] or not isinstance(e.get('path'), str):
                        continue
                    # Records contain data, never executable shell commands.
                    key = r['name'] + ':' + e['path']
                    original=e['path']
                    host_path=original
                    if r.get('workspace') and (original=='/workspace' or original.startswith('/workspace/')):
                        host_path=str(Path(r['workspace'])/original.removeprefix('/workspace').lstrip('/'))
                    key=r['name']+':'+host_path
                    entry = registry.setdefault(key, dict(session=r['name'], path=host_path, container_path=original, first_seen=e['time']))
                    entry.update(last_seen=e['time'], kind=e['kind'])
                    if e['kind']=='created':
                        entry['created_by_guard']=True
                        entry['purpose']=str(e.get('purpose','auxiliary worktree'))[:300]
                    if e['kind'] == 'release':
                        entry['released_at'] = e['time']
                    atomic(self.state / 'registry.json', registry)
                    p.unlink()
                except (OSError, ValueError, KeyError):
                    continue

    def discover(self, rows):
        registry=read(self.state/'registry.json',{})
        owners={r['workspace']:r['name'] for r in rows if r.get('workspace')}
        bases=[]
        sessions=self.root/'_sessions'
        if sessions.exists():
            for p in sessions.iterdir():
                if p.is_dir() and not p.is_symlink():
                    if str(p) not in owners:
                        key='unassigned:'+str(p)
                        registry.setdefault(key,dict(session=None,path=str(p),first_seen=time.time(),
                                                     kind='orphan-primary-review',purpose='No local container owner; check native/remote history before removal'))
                    for rel in ('.worktrees','.claude/worktrees','.tmp'):
                        if (p/rel).is_dir():bases.append((p/rel,owners.get(str(p))))
        # Agent worktrees inside bare clones, e.g. ["games/*/.claude/worktrees"] (config).
        for pattern in self.c.get('bare_repo_worktree_globs',[]):
            for p in self.root.glob(pattern):
                bases.append((p,None))
        for base,owner in bases:
            for p in base.iterdir():
                if p.is_symlink() or not p.is_dir():continue
                key=(owner or 'unassigned')+':'+str(p)
                registry.setdefault(key,dict(session=owner,path=str(p),first_seen=time.time(),
                                             kind='discovered-review',purpose='Existing auxiliary data; not authorized for automatic removal'))
        atomic(self.state/'registry.json',registry)

    def managed_paths(self, c):
        owned, shared = self.managed_sources(c)
        return owned + shared

    def managed_sources(self, c):
        """(owned, shared): data removed with the session vs. the Git common store."""
        paths = []
        for m in c['Mounts']:
            src = Path(m['Source'])
            if m['Destination'] == '/workspace' and beneath(src, self.root):
                paths.append(src)
        extra = self.root / '_claude-projects' / c['Name'].lstrip('/')
        if extra.exists():
            paths.append(extra)
        # Git worktrees contain pointers, not their object database. Preserve it too.
        commons=set()
        for m in c['Mounts']:
            src=Path(m['Source'])
            if beneath(src,self.root) and src.name.endswith('.git'):
                commons.add(src.resolve())
        for src in list(paths):
            if (src / '.git').exists():
                try:
                    common = Path(run(['/usr/bin/git','-c','safe.directory=*','-C',src,'rev-parse','--path-format=absolute','--git-common-dir']).decode().strip())
                except RuntimeError:
                    # Legacy workspaces can already have a missing registration.
                    # Never guess HEAD/index or rewrite their files. Preserve all
                    # available raw Git objects/refs from the exact mounted common
                    # store, alongside the complete workspace, before explicit End.
                    pointer=src/'.git'
                    text=pointer.read_text().strip() if pointer.is_file() else ''
                    target=Path(text[8:]).resolve() if text.startswith('gitdir: ') else None
                    known=next((p for p in commons if target and target.parent==p/'worktrees'),None)
                    if known is None:raise
                    self.audit('legacy-git-registration-preserved',workspace=str(src),common=str(known))
                    continue
                if not beneath(common, self.root):
                    raise RuntimeError('Git common directory outside managed root; deletion blocked')
                if not any(p in common.parents for p in paths):
                    commons.add(common)
        shared = []
        for common in commons:
            shared.extend(self.git_storage(common))
        return paths, list(dict.fromkeys(shared))

    def git_storage(self, common):
        # A bare repo can also contain .claude/worktrees. Archive its Git data,
        # not other agents' multi-GiB auxiliary working directories.
        names=('objects','refs','logs','info','hooks','branches','worktrees','rr-cache',
               'HEAD','config','packed-refs','shallow','description')
        out=[common/n for n in names if (common/n).exists()]
        seen=set()
        def alternates(objects):
            objects=objects.resolve()
            if objects in seen:return
            seen.add(objects)
            f=objects/'info'/'alternates'
            if f.exists():
                for line in f.read_text().splitlines():
                    alternate=(objects/line).resolve()
                    if not beneath(alternate,self.root) or not alternate.is_dir():
                        raise RuntimeError('Unknown Git alternate object store; removal denied')
                    out.append(alternate)
                    alternates(alternate)
        if (common/'objects').is_dir():alternates(common/'objects')
        return list(dict.fromkeys(out))

    def prepare_end(self, name):
        if not name.startswith('dev-') or '/' in name:
            raise RuntimeError('Only named devbox session containers can be prepared')
        raw = subprocess.run([DOCKER,'inspect',name],capture_output=True)
        if raw.returncode:
            raise RuntimeError('Cannot inspect target; removal denied')
        c = json.loads(raw.stdout)[0]
        destfile = self.state / 'prepared' / (c['Id'] + '.json')
        if destfile.exists() and self.end_ready(c):
            # Fresh full check: the Docker wrapper may trust it briefly (end_ready fresh=).
            result = read(destfile)
            result['checked_at'] = time.time()
            atomic(destfile, result)
            return result
        destfile.unlink(missing_ok=True)
        # This command only runs following an explicit rm/end request.
        # Stop both writers before preserving the layer and nested databases.
        run([DOCKER,'stop','--time','30',name],timeout=90)
        side = subprocess.run([DOCKER,'inspect','dind-'+name],capture_output=True)
        sidecar = json.loads(side.stdout)[0] if side.returncode == 0 else None
        if sidecar:
            run([DOCKER,'stop','--time','30','dind-'+name],timeout=90)
        paths, shared = self.managed_sources(c)
        if sidecar:
            paths += [Path(m['Source']) for m in sidecar['Mounts'] if m['Destination'] == '/var/lib/docker']
        path_archive, source_signatures = self.archive(paths, 'end-data', shared)
        # Export streams directly to encrypted offsite Borg, never to the local disk.
        name_archive = 'storage-guard-end-rootfs-' + time.strftime('%Y%m%dT%H%M%S') + '-' + c['Id'][:12]
        dest = self.c['borg_repo'] + '::' + name_archive
        with tempfile.TemporaryFile() as err:
            export = subprocess.Popen([DOCKER,'export',name],stdout=subprocess.PIPE,stderr=err)
            try:
                p = subprocess.run(['borg','--lock-wait','30','create','--compression','zstd,3',
                                    '--stdin-name','rootfs.tar',dest,'-'],stdin=export.stdout,
                                   capture_output=True,env=self.borg_env(),timeout=7200)
                export.stdout.close()
                rc = export.wait(timeout=60)
                if p.returncode or rc:
                    raise RuntimeError('Rootfs export/archive failed; session remains stopped and preserved')
            finally:
                if export.poll() is None:
                    export.kill()
                    export.wait()
        self.borg(['extract','--dry-run',dest])
        # Verify actual tar decoding, in addition to Borg chunk integrity.
        with tempfile.TemporaryFile() as err:
            extract = subprocess.Popen(['borg','--lock-wait','30','extract','--stdout',dest,'rootfs.tar'],
                                       stdout=subprocess.PIPE,stderr=err,env=self.borg_env())
            try:
                tar = subprocess.run(['tar','-tf','-'],stdin=extract.stdout,stdout=subprocess.DEVNULL,
                                     stderr=subprocess.PIPE,timeout=7200)
                extract.stdout.close()
                rc = extract.wait(timeout=60)
                if tar.returncode or rc:
                    raise RuntimeError('Rootfs restoration stream failed validation')
            finally:
                if extract.poll() is None:
                    extract.kill()
                    extract.wait()
        if source_signatures != {str(p):signature(p) for p in paths}:
            raise RuntimeError('Mounted data changed; removal denied')
        result = dict(container_id=c['Id'], name=name, verified_at=time.time(), data_archive=path_archive,
                      rootfs_archive=name_archive, signatures=source_signatures,
                      sidecar_id=sidecar['Id'] if sidecar else None, repository=self.c['borg_repo'])
        atomic(destfile,result)
        self.audit('end-preserved',name=name,data_archive=path_archive,rootfs_archive=name_archive)
        return result

    def end_ready(self, c, fresh=0):
        """fresh=N: accept a full check done within N seconds without walking again.
        A walk of ~0.5M files under backup I/O took minutes, past the wrapper's 40 s
        and devd's 60 s rm budget; devd now runs prepare-end (which checks) right
        before rm, so the wrapper only needs that recent result."""
        p = read(self.state / 'prepared' / (c['Id']+'.json'))
        if (not p or c['State']['Running'] or p['container_id'] != c['Id'] or
            p.get('repository')!=self.c['borg_repo'] or time.time()-p.get('verified_at',0)>3600):
            return False
        if fresh and time.time()-p.get('checked_at',p.get('verified_at',0)) < fresh:
            return True
        # Content was hashed twice during prepare_end (before and after the archive) with
        # both writers stopped. Re-hashing tens of GiB here ran past devd's 60 s lifecycle
        # timeout, so End could never finish. Any later write changes ctime/size/inode.
        for path,saved in p['signatures'].items():
            meta = [tuple(x[:7]) + (None if stat.S_ISREG(x[1]) else x[7],) for x in saved]
            if signature(path, hash_content=False) != meta:
                return False
        if p.get('sidecar_id'):
            r=subprocess.run([DOCKER,'inspect',p['sidecar_id']],capture_output=True)
            if r.returncode==0 and json.loads(r.stdout)[0]['State']['Running']:
                return False
        return True

    def offload_histories(self, paths):
        # One bounded archive/extraction batch, not one SSH session per tiny file.
        budget=0
        selected=[]
        held=held_files(paths)
        for p in sorted(paths,key=lambda p:p.stat().st_mtime):
            s=p.stat()
            if len(selected)>=2048:break
            if budget+s.st_size>512*2**20 and selected:
                continue
            if p in held:
                continue
            selected.append(p)
            budget+=s.st_size
        if selected:
            archive,before=self.archive(selected,'history')
            dest=self.c['borg_repo']+'::'+archive
            # Extract into a new private temporary directory, then compare hashes
            # of EVERY file. Temporary use is normally <=512 MiB; one larger file
            # may form its own batch so oversized histories are not skipped forever.
            if self.disk()['available_bytes']<budget+self.c['reserve_gib']*GIB:
                raise RuntimeError('Insufficient staging reserve; source histories retained')
            with tempfile.TemporaryDirectory(prefix='storage-guard-history-',dir='/var/tmp') as stage:
                run(['borg','--lock-wait','30','extract',dest],env=self.borg_env(),cwd=stage,timeout=7200)
                for p in selected:
                    restored=Path(stage)/str(p.resolve()).lstrip('/')
                    sha=before[str(p.resolve())][0][-1]
                    if not restored.is_file() or digest(restored)!=sha:
                        raise RuntimeError('History restoration hash mismatch; source histories retained')
                held=held_files(selected)
                for p in selected:
                    if p in held or signature(p)!=before[str(p.resolve())]:continue
                    size=p.stat().st_size
                    sha=before[str(p.resolve())][0][-1]
                    p.unlink()
                    self.audit('history-offloaded',path=str(p),bytes=size,sha256=sha,archive=archive)
            self.audit('history-batch-restore-tested',archive=archive,file_count=len(selected),bytes=budget)

    def retention(self):
        # Only pre-defined archived-conversation locations. No active sessions dirs.
        names = run([DOCKER,'volume','ls','--format','{{.Name}}']).decode().splitlines()
        paths=[]
        for n in names:
            if n == 'codex-home' or n.startswith('codex-acct-'):
                base=Path('/var/lib/docker/volumes')/n/'_data'/'archived_sessions'
                if base.is_dir() and not base.is_symlink():
                    for p in base.rglob('*.jsonl'):
                        if p.is_file() and not p.is_symlink() and beneath(p,base) and p.stat().st_mtime < time.time()-self.c['history_local_days']*86400:
                            paths.append(p)
        self.offload_histories(paths)
        # Existing recovery set is offloaded now; kept locally for 30 days.
        recovery=self.root/'_cleanup-recovery'
        marker=self.state/'recovery-offsite.json'
        if recovery.exists() and not marker.exists():
            archive,sigs=self.archive([recovery],'recovery')
            atomic(marker,dict(archive=archive,verified_at=time.time(),signatures=sigs))
        # Automatic local recovery deletion is intentionally only for immutable,
        # verified sets after the retention interval, never merely by mtime.
        saved=read(marker)
        if saved and recovery.exists() and time.time()-saved['verified_at']>self.c['recovery_local_days']*86400:
            expected={k:[tuple(x) for x in v] for k,v in saved['signatures'].items()}
            if expected=={str(recovery):signature(recovery)} and not referenced(recovery):
                self.borg(['extract','--dry-run',self.c['borg_repo']+'::'+saved['archive']])
                shutil.rmtree(recovery)
                self.audit('recovery-local-offloaded',archive=saved['archive'])
        # Independent namespace; never prune regular devbox-* backups here.
        self.borg(['prune','--glob-archives','storage-guard-*','--keep-within',str(self.c['offsite_keep_days'])+'d','--keep-monthly','12',self.c['borg_repo']])
        self.borg(['compact',self.c['borg_repo']])

    def sweep(self):
        registry=read(self.state/'registry.json',{})
        inventory=read(self.state/'inventory.json',{})
        live={r['name'] for r in inventory.get('sessions',[])}
        if time.time()-inventory.get('time',0)>self.c['inventory_max_age_seconds']:
            raise RuntimeError('Stale inventory; no automatic cleanup')
        report=[dict(path=e['path'],owner=e.get('session'),reason=e.get('purpose','Ownership/release review needed'))
                for e in registry.values() if not e.get('released_at') and not e.get('removed_at')]
        for key,e in registry.items():
            if not e.get('released_at') or (e['session'] in live and time.time()-e['released_at']<86400):
                continue
            # Only explicitly released host worktrees. Container-only paths need
            # end preservation and are not traversed through stale /proc roots.
            p=Path(e['path'])
            owner=self.root/'_sessions'/e['session']
            bare_roots=[self.root/g.split('/')[0] for g in self.c.get('bare_repo_worktree_globs',[])]
            bare_helper=(e.get('created_by_guard') and '.git/.claude/worktrees/' in str(p)
                         and any(beneath(p,r) for r in bare_roots))
            if not (beneath(p,owner) or bare_helper) or not p.exists() or p.is_symlink() or referenced(p):
                continue
            if any(m['Source']==str(p) or beneath(m['Source'],p)
                   for c in read(self.state/'containers.json',[] ) for m in c['Mounts']):
                continue
            gitfile=p/'.git'
            if not gitfile.is_file():
                report.append(dict(path=str(p),reason='Not a linked worktree; requires review'))
                continue
            common=Path(run(['/usr/bin/git','-c','safe.directory=*','-C',p,'rev-parse','--path-format=absolute','--git-common-dir']).decode().strip())
            if not beneath(common,self.root):
                continue
            archive,sigs=self.archive([p],'worktree',self.git_storage(common))
            if referenced(p) or sigs!={str(x):signature(x) for x in [p]}:
                continue
            # Git manages its registration. No rm -rf fallback for broken metadata.
            run(['/usr/bin/git','-c','safe.directory=*','-C',p,'worktree','remove','--force',str(p)])
            e['removed_at']=time.time()
            e['archive']=archive
            self.audit('released-worktree-offloaded',path=str(p),archive=archive)
            atomic(self.state/'registry.json',registry)
        atomic(self.state/'review.json',dict(time=time.time(),candidates=report))

    def cache_maintenance(self):
        # Content-addressed npm download blobs only. Never remove _npx executables,
        # node_modules, browsers, environments or user files from arbitrary caches.
        base=Path('/var/lib/docker/volumes/claude-home/_data/.cache/npm/_cacache/content-v2')
        if not base.is_dir() or base.is_symlink():return
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit():continue
            try:
                args=(proc/'cmdline').read_bytes().replace(b'\0',b' ').lower()
                if (b'npm' in args or b'pnpm' in args) and any(b' '+w+b' ' in args for w in (b'install',b'ci',b'add',b'exec',b'dlx')):
                    self.audit('npm-cache-maintenance-deferred',reason='Package installation/execution active')
                    return
            except FileNotFoundError:pass
        blobs=[p for p in base.rglob('*') if p.is_file() and not p.is_symlink() and beneath(p,base)]
        total=sum(p.stat().st_size for p in blobs)
        removed=0
        for p in sorted(blobs,key=lambda p:max(p.stat().st_atime,p.stat().st_mtime)):
            if total<=5*GIB:break
            s=p.stat()
            if max(s.st_atime,s.st_mtime)>time.time()-7*86400 or referenced(p):continue
            p.unlink()
            total-=s.st_size;removed+=s.st_size
        self.audit('npm-download-cache-evicted',bytes=removed,remaining_bytes=total)

    def docker_maintenance(self):
        # Explicitly disposable images only. Never prune unknown images/volumes.
        ids=run([DOCKER,'ps','--format','{{.Names}}']).decode().splitlines()
        for name in [None]+[n for n in ids if n.startswith('dind-dev-')]:
            prefix=[DOCKER] if name is None else [DOCKER,'exec',name,'docker']
            run(prefix+['image','prune','--all','--force','--filter','label=devbox.disposable=true','--filter','until=168h'],timeout=600)
            run(prefix+['builder','prune','--force','--filter','until=168h','--keep-storage','2GB'],timeout=600)
        self.audit('disposable-docker-maintenance')


def main():
    a=argparse.ArgumentParser()
    a.add_argument('--config',type=Path,default=DEFAULT_CONFIG)
    a.add_argument('command',choices=['sample','inventory','sweep','retention','prepare-end','docker-maintenance','cache-maintenance','status'])
    a.add_argument('name',nargs='?')
    args=a.parse_args()
    g=Guard(read(args.config))
    if args.command=='status':
        print(json.dumps(dict(disk=read(g.state/'disk.json'),inventory=read(g.state/'inventory.json'),
                              review=read(g.state/'review.json')),indent=2))
        return
    # Separate locks: sampling must continue while a large offsite archive runs.
    lock_name='archive' if args.command in ('retention','sweep','prepare-end') else args.command
    with (g.state/(lock_name+'.lock')).open('w') as lock:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX if lock_name=='archive' else fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another '+lock_name+' job is still running; retry later')
        if args.command=='prepare-end':
            result=g.prepare_end(args.name or '')
        else:
            result=getattr(g,args.command.replace('-','_'))()
        if result is not None:
            if args.command=='prepare-end':
                result={k:v for k,v in result.items() if k!='signatures'}
            print(json.dumps(result,indent=2))


if __name__=='__main__':
    try:
        main()
    except Exception as e:
        print('devbox-storage: '+str(e),file=sys.stderr)
        sys.exit(1)
