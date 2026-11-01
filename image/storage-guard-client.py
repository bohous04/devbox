#!/usr/bin/env python3
"""Non-privileged command guard. The real commands are never replaced in /usr/bin."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
from urllib.parse import urlsplit

STATE = Path(os.environ.get('DEVBOX_STORAGE_STATE', '/run/devd/storage-state.json'))


def clone_destination(args, cwd):
    values=[]
    takes_value={'-b','--branch','-o','--origin','--depth','--filter','--reference',
                 '--reference-if-able','--separate-git-dir','--template','-c',
                 '--config','--upload-pack','-u','--server-option','-j','--jobs','--revision'}
    it=iter(args[1:])
    for arg in it:
        if arg in takes_value:
            next(it,None)
        elif arg=='--':
            values.extend(it);break
        elif not arg.startswith('-'):
            values.append(arg)
    if not values:return None
    source=values[0]
    if len(values)>1:dest=values[1]
    else:
        source=urlsplit(source).path if '://' in source else source
        dest=source.rstrip('/').rsplit('/',1)[-1]
        if '--bare' not in args:dest=dest.removesuffix('.git')
    return (Path(cwd)/dest).resolve()


def expanding(tool, args):
    if tool == 'git':
        # Ignore global options: e.g. git -C repo worktree add --detach path HEAD.
        a = list(args)
        while a and a[0].startswith('-'):
            flag = a.pop(0)
            if flag in ('-C', '-c', '--git-dir', '--work-tree') and a:
                a.pop(0)
        return bool(a and (a[0] == 'clone' or a[:2] == ['worktree', 'add']))
    if tool == 'docker':
        return bool(args and (args[0] in ('build', 'pull') or args[:2] == ['buildx', 'build'] or
                              (args[0] == 'compose' and any(a in ('build', 'pull', 'up', 'run') for a in args[1:]))))
    return False


def guard_enabled():
    # devd sets DEVBOX_STORAGE_GUARD=1 for sessions on hosts with the storage guard installed.
    # Without it (and without published state) this wrapper only passes commands through,
    # so devbox hosts that don't run the guard are never blocked.
    return os.environ.get('DEVBOX_STORAGE_GUARD') == '1' or STATE.exists()


def preflight(state, now=None):
    now = now or time.time()
    if not guard_enabled():
        return None
    if not state and os.environ.get('DEVD_SESSION_ID'):
        return 'Session storage inventory is unavailable; refresh the storage inventory before adding copies/builds.'
    # Filesystem pressure can be checked even if the inventory is stale.
    v = os.statvfs('/workspace' if Path('/workspace').exists() else '/')
    available = v.f_bavail * v.f_frsize
    if available < state.get('reserve_bytes', 100 * 2**30):
        return 'Less than the emergency reserve is available; new copies/builds are paused.'
    if state.get('blocked'):
        return state.get('reason', 'Storage budget exceeded; new copies/builds are paused.')
    if state and now - state.get('measured_at', 0) > 3 * 3600:
        return 'Storage inventory is older than 3 hours. Refresh devbox-storage-inventory before adding data.'
    return None


def event(kind, **values):
    # Each record is separate, so concurrent agents never interleave JSON writes.
    root = Path('/run/devd/storage-events')
    try:
        root.mkdir(exist_ok=True)
        record = dict(kind=kind, time=time.time(), session=os.environ.get('DEVD_SESSION_ID'),
                      cwd=os.getcwd(), **values)
        target = root / (str(uuid.uuid4()) + '.json')
        target.write_text(json.dumps(record) + '\n')
    except OSError:
        pass  # A Git command must not fail after succeeding because telemetry failed.


def scratch(args):
    if len(args) < 2 or args[0] not in ('create', 'release'):
        print('Usage: devbox-scratch create PATH [REF] | release PATH', file=sys.stderr)
        return 2
    path = Path(args[1]).resolve()
    if args[0] == 'release':
        event('release', path=str(path))
        print('Release recorded. Cleanup still requires an inactive owner and verified backup.')
        return 0
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    reason = preflight(state)
    if reason:
        print(reason, file=sys.stderr)
        return 75
    # Linked worktrees share Git objects. They do not copy dependencies or build output.
    r = subprocess.run(['/usr/bin/git', 'worktree', 'add', '--detach', str(path), *(args[2:] or ['HEAD'])])
    if r.returncode == 0:
        event('created', path=str(path), purpose=os.environ.get('DEVBOX_SCRATCH_PURPOSE', 'auxiliary worktree'))
    return r.returncode


def main():
    name = Path(sys.argv[0]).name
    if name == 'devbox-scratch':
        return scratch(sys.argv[1:])
    tool = name if name in ('git', 'docker') else sys.argv[1]
    args = sys.argv[1:] if name in ('git', 'docker') else sys.argv[2:]
    if expanding(tool, args):
        try:
            state = json.loads(STATE.read_text())
        except (OSError, ValueError):
            state = {}
        reason = preflight(state)
        if reason:
            print('devbox storage: ' + reason, file=sys.stderr)
            return 75
        before = set()
        prefix = []
        rest = list(args)
        if tool == 'git':
            base=Path.cwd()
            while rest and rest[0].startswith('-'):
                flag = rest.pop(0)
                prefix.append(flag)
                if flag in ('-C', '-c', '--git-dir', '--work-tree') and rest:
                    value=rest.pop(0)
                    prefix.append(value)
                    if flag=='-C':base=(base/value).resolve()
            query = ['/usr/bin/git', *prefix, 'worktree', 'list', '--porcelain']
            r = subprocess.run(query, capture_output=True, text=True)
            before = {l[9:] for l in r.stdout.splitlines() if l.startswith('worktree ')}
        if tool == 'docker' and (args[0] == 'build' or args[:2] == ['buildx', 'build']):
            offset = 2 if args[0] == 'buildx' else 1
            args[offset:offset] = ['--label', 'devbox.disposable=true', '--label',
                                  'devbox.session=' + os.environ.get('DEVD_SESSION_ID', 'unknown')]
        result = subprocess.run(['/usr/bin/' + tool, *args])
        if result.returncode == 0 and tool == 'git':
            if rest and rest[0]=='clone':
                dest=clone_destination(rest,base)
                if dest and dest.is_dir():
                    event('created',path=str(dest),purpose=os.environ.get('DEVBOX_SCRATCH_PURPOSE','git clone'))
            # Do not store clone URLs/argv: they can contain credentials.
            r = subprocess.run(query,
                               capture_output=True, text=True)
            for line in r.stdout.splitlines():
                if line.startswith('worktree ') and line[9:] not in before:
                    event('created', path=line[9:], purpose=os.environ.get('DEVBOX_SCRATCH_PURPOSE', 'git worktree'))
        return result.returncode
    os.execv('/usr/bin/' + tool, [tool, *args])


if __name__ == '__main__':
    sys.exit(main())
