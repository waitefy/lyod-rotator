"""Bitwarden state follows login profiles without transferring website sessions."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).parents[1] / "src/providers"))
import firefox_extensions as extension


class ExtensionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.home_patch = patch.object(extension.Path, "home", return_value=self.home)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)
        self.root = self.home / ".config/lyod-rotator"
        self.package = self.root / "browser-extensions/bitwarden.xpi"
        self.package.parent.mkdir(parents=True)
        with zipfile.ZipFile(self.package, "w") as archive:
            archive.writestr("manifest.json", json.dumps({"browser_specific_settings": {"gecko": {"id": extension.BITWARDEN_ID}}}))
        self.uuid = "12345678-1234-1234-1234-123456789abc"

    def profile(self, name):
        profile = self.root / name / "firefox-profiles/test"
        profile.mkdir(parents=True)
        prefs = {extension.UUID_PREF: json.dumps({extension.BITWARDEN_ID: self.uuid}),
                 extension.TOOLBAR_PREF: json.dumps({"placements": {"nav-bar": ["urlbar-container", extension.WIDGET, "other-button"]}})}
        (profile / "prefs.js").write_text("".join("user_pref(" + json.dumps(k) + ", " + json.dumps(v) + ");\n" for k, v in prefs.items()))
        for suffix in ("", "^userContextId=4294967295"):
            directory = profile / "storage/default" / ("moz-extension+++" + self.uuid + suffix) / "idb"
            directory.mkdir(parents=True)
            (directory / "fixture.sqlite").write_bytes(b"encrypted-extension-fixture")
        (profile / "cookies.sqlite").write_bytes(b"private-provider-cookies")
        site = profile / "storage/default/https+++accounts.google.com"
        site.mkdir()
        (site / "private.txt").write_text("private-google-session")
        return profile

    def test_new_profile_gets_extension_state_and_pin_but_no_provider_data(self):
        source = self.profile("chatgpt-app")
        target = self.home / "fresh"
        self.assertTrue(extension.install_bitwarden(target))
        preferences = extension._preferences(target)
        self.assertEqual(json.loads(preferences[extension.UUID_PREF])[extension.BITWARDEN_ID], self.uuid)
        self.assertIn(extension.WIDGET, json.loads(preferences[extension.TOOLBAR_PREF])["placements"]["nav-bar"])
        self.assertIn("urlbar-container", json.loads(preferences[extension.TOOLBAR_PREF])["placements"]["nav-bar"])
        for suffix in ("", "^userContextId=4294967295"):
            path = Path("storage/default") / ("moz-extension+++" + self.uuid + suffix) / "idb/fixture.sqlite"
            self.assertEqual((target / path).read_bytes(), (source / path).read_bytes())
            self.assertEqual((target / path).stat().st_mode & 0o777, 0o600)
        self.assertFalse((target / "cookies.sqlite").exists())
        self.assertFalse((target / "storage/default/https+++accounts.google.com").exists())
        self.assertEqual((self.package.parent / "bitwarden-state.zip").stat().st_mode & 0o777, 0o600)

    def test_close_saves_latest_state_without_overwriting_other_extension_or_cookies(self):
        source = self.profile("chatgpt-app")
        extension.install_bitwarden(source)
        path = Path("storage/default") / ("moz-extension+++" + self.uuid) / "idb/fixture.sqlite"
        (source / path).write_bytes(b"new-encrypted-state")
        # Firefox prefs.js must win over the startup defaults in user.js.
        prefs = (source / "prefs.js").read_text().replace("nav-bar", "TabsToolbar")
        (source / "prefs.js").write_text(prefs)
        self.assertTrue(extension.save_bitwarden(source))
        target = self.profile("qwen-app")
        (target / path.parent / "obsolete.sqlite-wal").write_bytes(b"stale")
        unrelated = target / "storage/default/moz-extension+++other"
        unrelated.mkdir()
        (unrelated / "keep").write_text("keep")
        extension.install_bitwarden(target)
        self.assertEqual((target / path).read_bytes(), b"new-encrypted-state")
        self.assertFalse((target / path.parent / "obsolete.sqlite-wal").exists())
        self.assertEqual((target / "cookies.sqlite").read_bytes(), b"private-provider-cookies")
        self.assertTrue((unrelated / "keep").exists())
        # The restore is applied on next Firefox start via user.js.
        self.assertIn("TabsToolbar", (target / "user.js").read_text())

    def test_busy_profile_is_not_copied(self):
        source = self.profile("chatgpt-app")
        code = "import fcntl,sys; f=open(sys.argv[1], 'a'); fcntl.lockf(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()"
        process = subprocess.Popen([sys.executable, "-c", code, str(source / ".parentlock")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "locked")
            target = self.home / "fresh"
            extension.install_bitwarden(target)
            self.assertFalse((self.package.parent / "bitwarden-state.zip").exists())
            with self.assertRaises(BlockingIOError):
                extension.save_bitwarden(source)
        finally:
            process.communicate("")

    def test_missing_package_is_optional(self):
        self.package.unlink()
        self.assertFalse(extension.install_bitwarden(self.home / "fresh"))


if __name__ == "__main__":
    unittest.main()
