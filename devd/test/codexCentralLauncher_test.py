import importlib.machinery
import importlib.util
from pathlib import Path
import unittest

source = Path(__file__).resolve().parents[2] / 'image/codex-remote'
loader = importlib.machinery.SourceFileLoader('central_launcher', str(source))
spec = importlib.util.spec_from_loader(loader.name, loader)
launcher = importlib.util.module_from_spec(spec)
loader.exec_module(launcher)

class LauncherTest(unittest.TestCase):
    route = {'cwd':'/srv/dev/projects/one', 'container':'dev-one'}
    def test_workspace_subdirectories(self):
        self.assertEqual(launcher.canonical_cwd(self.route,'/workspace/src'),'/srv/dev/projects/one/src')
        self.assertEqual(launcher.canonical_cwd(self.route,'/srv/dev/projects/one/src'),'/srv/dev/projects/one/src')
    def test_other_project_and_path_traversal_rejected(self):
        for path in ['/workspace-other','/workspace/../etc','/srv/dev/projects/two']:
            with self.assertRaises(launcher.ConfigurationError):
                launcher.canonical_cwd(self.route,path)
    def test_explicit_cd_translated(self):
        for args in [['--cd','src'],['--cd=src'],['-Csrc']]:
            self.assertEqual(launcher.remote_args(args,self.route,'/workspace'),['-C','/srv/dev/projects/one/src'])
    def test_resume_and_prompt_preserved(self):
        self.assertEqual(launcher.remote_args(['resume','id'],self.route,'/workspace'),['-C','/srv/dev/projects/one','resume','id'])
        self.assertEqual(launcher.remote_args(['--','-Cfoo'],self.route,'/workspace')[-2:],['--','-Cfoo'])
    def test_explicit_endpoint_and_noninteractive_passthrough(self):
        for args in [['--version'],['--remote','unix:///tmp/x'],['--remote=unix:///tmp/x'],['exec','task'],['-m','model','login']]:
            self.assertTrue(launcher.direct_invocation(args))
        for args in [[],['resume'],['-m','model','task'],['--','exec']]:
            self.assertFalse(launcher.direct_invocation(args))
    def test_remote_resume_preserves_saved_permissions(self):
        for args in [['resume','id'],['-m','gpt-5.6-terra','resume','id'],
                     ['-c','model="resume"','resume','id','-C','/workspace']]:
            self.assertNotIn('--dangerously-bypass-approvals-and-sandbox', launcher.remote_launch_flags(args))
            self.assertIn('--dangerously-bypass-hook-trust', launcher.remote_launch_flags(args))
    def test_fresh_prompt_named_resume_does_not_change_permission_defaults(self):
        for args in [[],['--','resume'],['-m','resume','build this feature']]:
            self.assertIn('--dangerously-bypass-approvals-and-sandbox', launcher.remote_launch_flags(args))

if __name__ == '__main__': unittest.main()
