#!/usr/bin/python3
"""Registration of one mac MCP server for mac-mcp-bridge.

Origin: generalized from the Open Design integration (`~/.codex/integrations/open-design/`),
where `command`, the env variable allowlist and timeouts were hard-coded. Here
everything domain-specific comes from a JSON file, so one bridge serves several integrations.
"""
import json
import pathlib
import re
from dataclasses import dataclass, field

TARGET_RE = re.compile(r'[A-Za-z0-9_.-]+@[A-Za-z0-9][A-Za-z0-9.-]*')


@dataclass
class Registration:
    command: str
    args: list
    env: dict
    target: str
    key_title: str
    why: str
    label: str
    known_hosts: pathlib.Path
    preflight: list = field(default_factory=list)
    call_timeout: int = 120
    connect_timeout: int = 150


def _str_list(value, what):
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ValueError(f'{what} must be a list of strings.')
    return value


def load_registration(path: pathlib.Path) -> Registration:
    path = pathlib.Path(path)
    if not path.is_absolute():
        raise ValueError('The registration path must be absolute.')
    cfg = json.loads(path.read_text())

    command = cfg.get('command')
    # A relative command would be looked up in the remote shell's PATH — it must be unambiguous.
    if not isinstance(command, str) or not command.startswith('/'):
        raise ValueError('`command` must be an absolute path on the mac.')

    target = cfg.get('target')
    if not isinstance(target, str) or not TARGET_RE.fullmatch(target):
        raise ValueError('`target` must be an explicit user@hostname.')

    # The allowlist is per registration: Open Design needs OD_*, xcode nothing or DEVELOPER_DIR.
    env = cfg.get('env', {}) or {}
    allow = set(_str_list(cfg.get('envAllow', []) or [], '`envAllow`'))
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        raise ValueError('`env` must be a string→string map.')
    unexpected = set(env) - allow
    if unexpected:
        raise ValueError(f'`env` contains keys outside `envAllow`: {sorted(unexpected)}')

    preflight = cfg.get('preflight', []) or []
    if not isinstance(preflight, list):
        raise ValueError('`preflight` must be a list of argv lists.')
    for cmd in preflight:
        _str_list(cmd, '`preflight` item')

    known_hosts = path.with_name('known_hosts')
    if not known_hosts.is_file():
        raise ValueError('Missing a verified SSH host key (`known_hosts` next to the registration).')

    for key in ('keyTitle', 'why', 'label'):
        if not isinstance(cfg.get(key), str) or not cfg[key].strip():
            raise ValueError(f'`{key}` is required.')

    return Registration(
        command=command, args=_str_list(cfg.get('args', []) or [], '`args`'), env=env,
        target=target, key_title=cfg['keyTitle'], why=cfg['why'], label=cfg['label'],
        known_hosts=known_hosts, preflight=preflight,
        call_timeout=int(cfg.get('callTimeout', 120)),
        connect_timeout=int(cfg.get('connectTimeout', 150)),
    )
