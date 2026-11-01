#!/usr/bin/env python3
"""Host lifecycle interlock. Does not change remote Docker contexts or /usr/bin/docker."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

REAL='/usr/bin/docker'
LIB=Path('/usr/local/lib/devbox-storage')


def load():
    spec=importlib.util.spec_from_file_location('storage_guard',LIB/'guard.py')
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.Guard(mod.read(mod.DEFAULT_CONFIG))


def inspect(name):
    p=subprocess.run([REAL,'inspect',name],capture_output=True)
    return json.loads(p.stdout)[0] if p.returncode==0 else None


def gate(g,name=None):
    disk=g.disk()
    if disk['percent']>=g.c['disk_block_percent'] or disk['available_bytes']<g.c['reserve_gib']*2**30:
        raise RuntimeError('Disk emergency threshold reached: new sessions/builds are paused. Running sessions are preserved.')
    inventory=json.loads((g.state/'inventory.json').read_text())
    if time.time()-inventory['time']>g.c['inventory_max_age_seconds']:
        raise RuntimeError('Storage inventory is stale; run systemctl start devbox-storage-inventory.service')
    for row in inventory['sessions']:
        block=g.c.get('session_limits',{}).get(row['name'],{}).get('block_gib',g.c['session_block_gib'])
        if row['name']==name and row['bytes']>=block*2**30:
            raise RuntimeError('Session storage budget exceeded; clean or release temporary copies before adding data.')


def preserve(g,c):
    # prepare-end (run by devd just before rm) has just verified the sources.
    if g.end_ready(c, fresh=300):
        return
    unit='devbox-storage-end-'+c['Id'][:12]
    active=subprocess.run(['systemctl','is-active','--quiet',unit],capture_output=True).returncode==0
    if not active:
        p=subprocess.run(['systemd-run','--quiet','--collect','--unit',unit,
                          '--property=Type=oneshot','--property=Nice=15',
                          '--property=TimeoutStartSec=4h','/usr/local/bin/devbox-storage',
                          'prepare-end',c['Name'].lstrip('/')],capture_output=True)
        if p.returncode:
            raise RuntimeError('Cannot start offsite preservation; session removal denied')
    # devd lifecycle timeout is 60 s. Leave time to return an actionable error.
    deadline=time.time()+40
    while time.time()<deadline:
        fresh=inspect(c['Id'])
        if fresh and g.end_ready(fresh):
            return
        if subprocess.run(['systemctl','is-active','--quiet',unit],capture_output=True).returncode:
            raise RuntimeError('Offsite preservation failed; data retained. Inspect journalctl -u '+unit)
        time.sleep(1)
    raise RuntimeError('Session removal is waiting for verified offsite preservation ('+unit+'). No data has been removed; existing work is retained.')


def main():
    args=sys.argv[1:]
    # Non-local daemons belong to separate hosts. They must not be governed by
    # local disk measurements. Global options are passed through conservatively.
    if not args or args[0].startswith('-') or os.environ.get('DOCKER_HOST'):
        os.execv(REAL,['docker',*args])
    cmd=args[0]
    created_session=None
    if cmd in ('rm','run','start','build','pull','buildx') or args[:2]==['container','rm']:
        g=load()
        if cmd in ('build','pull') or args[:2]==['buildx','build']:
            gate(g)
        if cmd=='run':
            name=None
            for i,a in enumerate(args):
                if a=='--name' and i+1<len(args): name=args[i+1]
                elif a.startswith('--name='): name=a[7:]
            if name and (name.startswith('dev-') or name.startswith('dind-dev-')):
                gate(g,name.removeprefix('dind-'))
                args[1:1]=['--ulimit','core=0:0']
                if name.startswith('dev-'):
                    args[1:1]=['--env','npm_config_cache=/home/dev/.claude/.cache/npm']
                    created_session=name
        if cmd=='start':
            for name in [a for a in args[1:] if not a.startswith('-')]:
                c=inspect(name)
                if c and c['Name'].startswith('/dev-'):
                    # Resuming existing work is allowed even over budget.
                    (g.state/'prepared'/(c['Id']+'.json')).unlink(missing_ok=True)
        if cmd=='rm' or args[:2]==['container','rm']:
            values=args[2:] if cmd=='container' else args[1:]
            for name in [a for a in values if not a.startswith('-')]:
                c=inspect(name)
                if c and c['Name'].startswith('/dev-'):
                    preserve(g,c)
    if created_session:
        p=subprocess.run([REAL,*args])
        if p.returncode==0:
            try:
                c=inspect(created_session)
                if c and c['State']['Running']:
                    mounts={m['Destination']:m for m in c['Mounts']}
                    row=dict(name=created_session,control=mounts.get('/run/devd',{}).get('Source'),
                             bytes=0,measured_at=time.time())
                    g.publish([row],g.disk())
                    g.install_client(c,row)
            except Exception as e:
                # Docker already created the session. A post-install error must
                # not make devd roll back its DB row and orphan that container.
                g.audit('new-session-client-install-failed',name=created_session,reason=str(e))
                g.notify('client-'+created_session,'Nepodařilo se doplnit ochranu nové session '+created_session+'. Inventura instalaci zopakuje.')
            subprocess.run(['systemctl','start','--no-block','devbox-storage-inventory.service'],capture_output=True)
        return p.returncode
    os.execv(REAL,['docker',*args])


if __name__=='__main__':
    try:
        sys.exit(main())
    except Exception as e:
        print('devbox storage: '+str(e),file=sys.stderr)
        sys.exit(75)
