import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

try:
    import tomllib
except ModuleNotFoundError:  # install.py runs on the devbox host (Ubuntu 24.04, Python 3.12)
    raise unittest.SkipTest('requires Python 3.11+ (tomllib)')

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('od_install', ROOT / 'tools/opendesign/install.py')
install = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(install)


class OpenDesignInstallTest(unittest.TestCase):
    def test_account_inline_tables_are_supported_without_rewriting_account_settings(self):
        original = '''"model" = "account-model"
"mcp_servers" = { "other" = { "command" = "other", "env" = { "TOKEN" = "test-only" } }, "open-design" = { "command" = "/old" } }
"cli_auth_credentials_store" = "file"
"sqlite_home" = "/account"
'''
        updated = install.merge_toml(original, install.CODEX)
        self.assertTrue(updated.startswith('"model" = "account-model"\n'))
        self.assertTrue(updated.endswith('"sqlite_home" = "/account"\n'))
        self.assertEqual(tomllib.loads(updated)['mcp_servers']['open-design'], install.CODEX)
        self.assertEqual(install.merge_toml(updated, install.CODEX), updated)

    def test_merges_existing_server_subtables_and_preserves_unrelated_config(self):
        original = '''# retained comment
model = "example"
[mcp_servers."open-design"]
command = "/container-only/bridge"
[mcp_servers."open-design".env]
OLD = "obsolete"
[mcp_servers.other]
command = "other"
[mcp_servers.other.env]
TOKEN = "test-only"
[tui]
status_line = ["model"]
'''
        result = install.merge_toml(original, install.CODEX)
        self.assertIn('# retained comment', result)
        parsed = tomllib.loads(result)
        self.assertEqual(parsed['mcp_servers']['open-design'], install.CODEX)
        self.assertEqual(parsed['mcp_servers']['other']['env']['TOKEN'], 'test-only')
        self.assertEqual(install.merge_toml(result, install.CODEX), result)

    def test_all_homes_account_profiles_backups_and_idempotence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            volumes = root / 'volumes'
            codex_paths = [volumes / p / '_data/config.toml' for p in ('codex-home', 'codex-acct-test')]
            claude_paths = [volumes / p / '_data/.claude.json' for p in ('claude-home', 'claude-acct-test')]
            grok = volumes / 'grok-home/_data/config.toml'
            for path in [*codex_paths, grok]:
                path.parent.mkdir(parents=True)
                path.write_text('[mcp_servers.other]\ncommand = "existing"\n')
                path.chmod(0o600)
            for path in claude_paths:
                path.parent.mkdir(parents=True)
                path.write_text('{"oauthAccount":{"test":true},"mcpServers":{"other":{"command":"existing"}}}')
            registration = root / 'registration.json'
            registration.write_text(json.dumps({'target': 'user@100.64.0.1', 'command': '/Applications/App', 'args': []}))
            pins = root / 'known_hosts'
            pins.write_text('100.64.0.1 ssh-ed25519 test-public-key\n')
            catalog = root / 'catalog.json'
            catalog.write_text(json.dumps({'initialize': {'serverInfo': {'name': 'open-design'}, 'capabilities': {'tools': {}}},
                                           'tools': {'tools': []}, 'resources': {'resources': []},
                                           'resource_templates': {'resourceTemplates': []}}))
            local = root / 'mcp-local.json'
            local.write_text('{"mcpServers":{"local-other":{"command":"preserved"}}}')
            argv = [sys.executable, str(SPEC.origin), '--registration', str(registration),
                    '--catalog', str(catalog),
                    '--known-hosts', str(pins), '--volumes-root', str(volumes),
                    '--mcp-local', str(local), '--backup-root', str(root / 'backups')]
            subprocess.run(argv, check=True, capture_output=True)
            for path in codex_paths:
                self.assertEqual(tomllib.loads(path.read_text())['mcp_servers']['open-design'], install.CODEX)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(tomllib.loads(grok.read_text())['mcp_servers']['open-design'], install.GROK)
            for path in claude_paths:
                data = json.loads(path.read_text())
                self.assertEqual(data['oauthAccount'], {'test': True})
                self.assertEqual(data['mcpServers']['open-design'], install.CLAUDE)
            self.assertIn('local-other', json.loads(local.read_text())['mcpServers'])
            helper = volumes / 'codex-home/_data/integrations/open-design/bridge.py'
            self.assertEqual(helper.stat().st_mode & 0o777, 0o700)
            files = {p: p.read_bytes() for p in root.rglob('*') if p.is_file()}
            result = subprocess.run(argv, check=True, capture_output=True, text=True)
            self.assertIn('already current', result.stdout)
            self.assertEqual(files, {p: p.read_bytes() for p in root.rglob('*') if p.is_file()})


if __name__ == '__main__':
    unittest.main()
