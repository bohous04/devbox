import json, pathlib, tempfile, unittest
from registration import load_registration

def write(tmp, reg, known_hosts=True):
    d = pathlib.Path(tmp)
    (d / 'registration.json').write_text(json.dumps(reg))
    if known_hosts:
        (d / 'known_hosts').write_text('100.64.0.30 ssh-ed25519 AAAA\n')
    return d / 'registration.json'

BASE = {
    'command': '/opt/homebrew/bin/xcodebuildmcp', 'args': ['mcp'],
    'target': 'ai@100.64.0.30', 'keyTitle': 'SSH Key - Mac mini',
    'why': 'iOS build z devbox session', 'label': 'Xcode',
}

class LoadRegistration(unittest.TestCase):
    def test_defaults_when_optional_fields_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = load_registration(write(tmp, BASE))
            self.assertEqual(r.call_timeout, 120)      # open-design's default preserved
            self.assertEqual(r.connect_timeout, 150)
            self.assertEqual(r.preflight, [])
            self.assertEqual(r.env, {})

    def test_call_timeout_is_read_from_registration(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = load_registration(write(tmp, {**BASE, 'callTimeout': 1800}))
            self.assertEqual(r.call_timeout, 1800)

    def test_env_outside_allowlist_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = write(tmp, {**BASE, 'env': {'EVIL': 'x'}, 'envAllow': ['DEVELOPER_DIR']})
            with self.assertRaises(ValueError):
                load_registration(p)

    def test_env_inside_allowlist_is_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = write(tmp, {**BASE, 'env': {'DEVELOPER_DIR': '/Applications/Xcode.app'},
                            'envAllow': ['DEVELOPER_DIR']})
            self.assertEqual(load_registration(p).env, {'DEVELOPER_DIR': '/Applications/Xcode.app'})

    def test_relative_command_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                load_registration(write(tmp, {**BASE, 'command': 'xcodebuildmcp'}))

    def test_malformed_target_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                load_registration(write(tmp, {**BASE, 'target': 'ai@mini; rm -rf /'}))

    def test_missing_known_hosts_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                load_registration(write(tmp, BASE, known_hosts=False))

    def test_preflight_must_be_list_of_argv_lists(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                load_registration(write(tmp, {**BASE, 'preflight': ['rsync -a x y']}))

if __name__ == '__main__':
    unittest.main()
