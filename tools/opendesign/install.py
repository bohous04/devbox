#!/usr/bin/env python3
"""Install an existing Mac OpenDesign registration into the shared devbox homes.

Run on the devbox host. No keys, account data, or unrelated settings are printed.
The supplied known_hosts file must contain the Mac host key verified out of band.
"""
import argparse
import copy
import datetime
import json
import math
import os
from pathlib import Path
import re
import shutil
import tempfile
import tomllib

RUNTIME = '/home/dev/.codex/integrations/open-design'
CODEX = {
    'command': f'{RUNTIME}/bridge.py',
    'args': [f'{RUNTIME}/registration.json'],
    'env_vars': ['DEVD_SESSION_ID', 'DEVD_URL'],
    'startup_timeout_sec': 10,
    # First use includes the SSH approval and optional Mac app startup.
    'tool_timeout_sec': 300,
    'enabled': True,
}
CLAUDE = {k: CODEX[k] for k in ('command', 'args')}
GROK = {k: v for k, v in CODEX.items() if k != 'env_vars'}


def toml_value(value):
    if isinstance(value, (str, bool, int)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, float) and math.isfinite(value):
        return repr(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, list):
        return '[' + ', '.join(toml_value(item) for item in value) + ']'
    if isinstance(value, dict):
        return '{ ' + ', '.join(json.dumps(k) + ' = ' + toml_value(v) for k, v in value.items()) + ' }'
    raise ValueError('Unsupported configuration value.')


def merge_toml(original, definition):
    before = tomllib.loads(original)
    expected = copy.deepcopy(before)
    expected.setdefault('mcp_servers', {})['open-design'] = definition
    # Account seeding serializes entire top-level maps as single inline tables.
    for line in original.splitlines(keepends=True):
        if re.match(r'^(?:mcp_servers|"mcp_servers"|\'mcp_servers\')\s*=\s*\{', line):
            if tomllib.loads(line).get('mcp_servers') != before.get('mcp_servers'):
                raise ValueError('Unsupported inline MCP configuration.')
            updated = original.replace(line, '"mcp_servers" = ' + toml_value(expected['mcp_servers']) + '\n', 1)
            if tomllib.loads(updated) != expected:
                raise ValueError('Inline TOML merge would change unrelated settings.')
            return updated
    # Remove only this server's tables, retaining all unrelated text/comments.
    kept, skip = [], False
    for line in original.splitlines(keepends=True):
        if re.match(r'^\s*\[', line):
            skip = bool(re.match(
                r'^\s*\[mcp_servers\.(?:open-design|"open-design"|\'open-design\')'
                r'(?:\.[^\]\n]+)?\]\s*(?:#.*)?$', line))
        if not skip:
            kept.append(line)
    block = ['[mcp_servers.open-design]']
    for key, value in definition.items():
        block.append(f'{key} = {json.dumps(value, ensure_ascii=False)}')
    updated = ''.join(kept).rstrip() + '\n\n' + '\n'.join(block) + '\n'
    after = tomllib.loads(updated)
    if after != expected:
        raise ValueError('TOML merge would change unrelated settings; no files written.')
    return updated


def merge_json(original, definition):
    data = json.loads(original)
    data.setdefault('mcpServers', {})['open-design'] = definition
    return json.dumps(data, ensure_ascii=False, indent=2) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registration', type=Path, required=True)
    parser.add_argument('--known-hosts', type=Path, required=True)
    parser.add_argument('--catalog', type=Path, help='Discovery metadata captured on the Mac; defaults to the already installed catalog.')
    parser.add_argument('--volumes-root', type=Path, default=Path('/var/lib/docker/volumes'))
    parser.add_argument('--mcp-local', type=Path, default=Path('/etc/devd/mcp-local.json'))
    parser.add_argument('--backup-root', type=Path, default=Path('/var/backups/devbox-open-design'))
    args = parser.parse_args()
    registration = json.loads(args.registration.read_text())
    host = registration['target'].split('@', 1)[1]
    # Exact host binding, not a wildcard or trust-on-first-use scan.
    pins = args.known_hosts.read_text()
    if not any(len(parts := line.split()) >= 3 and parts[0] == host
               and parts[1] == 'ssh-ed25519' for line in pins.splitlines()):
        raise ValueError('known_hosts must pin the exact Mac hostname with its verified Ed25519 key.')
    home = args.volumes_root / 'codex-home/_data'
    if not (home / 'config.toml').is_file():
        raise ValueError('Shared Codex home does not exist.')
    owner = home.stat()
    pending = []

    def stage(path, content, mode=None):
        old = path.read_bytes() if path.exists() else None
        new = content.encode()
        if new != old or (mode is not None and path.exists() and path.stat().st_mode & 0o777 != mode):
            pending.append((path, old, new, mode))

    integration = home / 'integrations/open-design'
    catalog = (args.catalog or integration / 'catalog.json').read_text()
    parsed_catalog = json.loads(catalog)
    if not isinstance(parsed_catalog.get('tools', {}).get('tools'), list) or 'initialize' not in parsed_catalog:
        raise ValueError('Invalid OpenDesign discovery catalog.')
    # Install the dependencies before switching the launcher on existing sessions.
    stage(integration / 'catalog.json', catalog, 0o600)
    stage(integration / 'ssh_transport.py', Path(__file__).with_name('ssh_transport.py').read_text(), 0o700)
    stage(integration / 'registration.json', json.dumps(registration, indent=2) + '\n', 0o600)
    stage(integration / 'known_hosts', pins, 0o600)
    stage(integration / 'bridge.py', Path(__file__).with_name('bridge.py').read_text(), 0o700)
    for path in [home / 'config.toml', *sorted(args.volumes_root.glob('codex-acct-*/_data/config.toml'))]:
        stage(path, merge_toml(path.read_text(), CODEX))
    for path in [args.volumes_root / 'claude-home/_data/.claude.json',
                 *sorted(args.volumes_root.glob('claude-acct-*/_data/.claude.json'))]:
        if path.exists():
            stage(path, merge_json(path.read_text(), CLAUDE))
    grok = args.volumes_root / 'grok-home/_data/config.toml'
    if grok.exists():
        stage(grok, merge_toml(grok.read_text(), GROK))
    stage(args.mcp_local, merge_json(args.mcp_local.read_text() if args.mcp_local.exists() else '{}', CODEX), 0o600)

    if not pending:
        print('OpenDesign shared installation is already current.')
        return
    backup = args.backup_root / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup.mkdir(parents=True, mode=0o700)
    manifest = []
    for i, (path, old, new, mode) in enumerate(pending):
        current = path.read_bytes() if path.exists() else None
        if current != old:
            raise RuntimeError(f'Configuration changed concurrently: {path}; rerun the installer.')
        stat = path.stat() if path.exists() else (path.parent.stat() if path == args.mcp_local else owner)
        if old is not None:
            shutil.copy2(path, backup / str(i))
            (backup / str(i)).chmod(0o600)
        manifest.append({'path': str(path), 'backup': str(i) if old is not None else None})
        (backup / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.parent == integration:
            for directory in [integration.parent, integration]:
                os.chown(directory, owner.st_uid, owner.st_gid)
                directory.chmod(0o700)
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.open-design-')
        try:
            os.fchown(fd, stat.st_uid, stat.st_gid)
            os.fchmod(fd, mode if mode is not None else stat.st_mode & 0o777)
            with os.fdopen(fd, 'wb') as output:
                output.write(new)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        print(f'Updated {path}')
    print(f'Backup: {backup}')


if __name__ == '__main__':
    main()
