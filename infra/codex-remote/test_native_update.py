import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("native_update", Path(__file__).with_name("native-update.py"))
nu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nu)


class NativeUpdateTest(unittest.TestCase):
    def test_versions_compare_numerically(self):
        self.assertTrue(nu.is_newer("0.160.0", "0.153.4"))
        self.assertTrue(nu.is_newer("0.10.0", "0.9.9"))
        self.assertFalse(nu.is_newer("0.153.4", "0.153.4"))
        self.assertFalse(nu.is_newer("0.153.3", "0.153.4"))
        with self.assertRaises(ValueError):
            nu.parse_version("0.160.0-alpha.1")

    def test_window_upper_bound_is_exclusive(self):
        self.assertTrue(nu.in_window(2, (2, 6)))
        self.assertTrue(nu.in_window(5, (2, 6)))
        self.assertFalse(nu.in_window(6, (2, 6)))
        self.assertTrue(nu.in_window(23, (22, 4)))
        self.assertTrue(nu.in_window(1, (22, 4)))
        self.assertFalse(nu.in_window(12, (22, 4)))

    def test_patch_base_comes_from_header(self):
        text = "# base: rust-v0.160.0\n# another comment\ndiff --git a/x b/x\n# base: rust-v9.9.9\n"
        self.assertEqual(nu.patch_base(text), "rust-v0.160.0")
        with self.assertRaises(ValueError):
            nu.patch_base("diff --git a/x b/x\n")

    def test_only_active_threads_block_restart(self):
        statuses = [("a", "idle"), ("b", "active"), ("c", "systemError"), ("d", "notLoaded")]
        self.assertEqual(nu.busy_threads(statuses), ["b"])

    def test_failed_attempt_blocks_only_same_version_and_patch(self):
        failed = {"state": "conflict", "version": "0.161.0", "patch": "abc"}
        self.assertTrue(nu.blocked_attempt(failed, "0.161.0", "abc"))
        self.assertFalse(nu.blocked_attempt(failed, "0.161.0", "def"))   # patch fixed
        self.assertFalse(nu.blocked_attempt(failed, "0.162.0", "abc"))   # new version
        self.assertFalse(nu.blocked_attempt({**failed, "state": "staged"}, "0.161.0", "abc"))


if __name__ == "__main__":
    unittest.main()
