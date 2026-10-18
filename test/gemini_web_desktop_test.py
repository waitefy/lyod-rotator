"""Desktop login uses synthetic sessions; no Firefox, SSH or Google requests."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "src/providers/gemini-web"))
import browser_login
import desktop_login


class DesktopLoginTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        browser_login.save_private(self.root / "desktop-login.json", {
            "server": "root@rotator.example", "origin": "https://rotator.example"})

    def test_link_only_selects_account_on_the_installed_server(self):
        self.assertEqual(desktop_login.parse_link(
            "tuxevil-gemini://login?origin=https%3A%2F%2Frotator.example&account=User%40example.com",
            "https://rotator.example"), "user@example.com")
        self.assertIsNone(desktop_login.parse_link(
            "tuxevil-gemini://login?origin=https%3A%2F%2Frotator.example", "https://rotator.example"))
        for url in (
            "tuxevil-gemini://login?origin=https://evil.example",
            "tuxevil-gemini://login?origin=https://rotator.example&server=root@evil.example",
            "tuxevil-gemini://login?origin=https://rotator.example&origin=https://evil.example",
            "tuxevil-gemini://login?origin=https://rotator.example&account=bad%0Auser@example.com",
            "https://rotator.example/login", "tuxevil-gemini://login?origin=https://rotator.example#x",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                desktop_login.parse_link(url, "https://rotator.example")

    def test_installer_registers_an_argument_list_and_private_configuration(self):
        with patch.object(desktop_login.subprocess, "run") as run:
            desktop_login.install("root@rotator.example", "https://rotator.example", self.root, self.root / "apps")
        run.assert_called_once_with(["xdg-mime", "default", desktop_login.DESKTOP_ID,
                                     "x-scheme-handler/tuxevil-gemini"], check=True, timeout=15)
        text = (self.root / "apps" / desktop_login.DESKTOP_ID).read_text()
        self.assertIn("--open %u", text)
        self.assertIn("Terminal=false", text)
        self.assertNotIn("root@rotator.example", text)
        self.assertEqual((self.root / "desktop-login.json").stat().st_mode & 0o777, 0o600)

    def test_same_account_reuses_profile_and_checks_identity_before_upload(self):
        profiles = []
        def login(args, directory, expected_email):
            self.assertEqual(args.server, "root@rotator.example")
            self.assertIsNone(args.email)  # Automatic identity matching, no manual account alias.
            self.assertEqual(expected_email, "user@example.com")
            profiles.append(args.profile)
            args.identity = {"email": expected_email, "id": "fixture-id"}
        url = "tuxevil-gemini://login?origin=https://rotator.example&account=user@example.com"
        with patch.object(browser_login, "automatic_login", login):
            self.assertEqual(desktop_login.connect(url, self.root), "user@example.com")
            desktop_login.connect(url, self.root)
        self.assertEqual(profiles[0], profiles[1])

    def test_failed_login_keeps_profile_for_the_next_click(self):
        profiles = []
        def login(args, directory, expected_email):
            profiles.append(args.profile)
            raise browser_login.LoginError("fixture failure")
        url = "tuxevil-gemini://login?origin=https://rotator.example&account=user@example.com"
        with patch.object(browser_login, "automatic_login", login):
            for _ in range(2):
                with self.assertRaises(ValueError):
                    desktop_login.connect(url, self.root)
        self.assertEqual(profiles[0], profiles[1])

    def test_parallel_click_does_not_open_another_browser(self):
        url = "tuxevil-gemini://login?origin=https://rotator.example&account=user@example.com"
        def login(args, directory, expected_email):
            with self.assertRaisesRegex(browser_login.LoginError, "Вход уже открыт"):
                desktop_login.connect(url, self.root)
            args.identity = {"email": expected_email, "id": "fixture-id"}
        with patch.object(browser_login, "automatic_login", login):
            desktop_login.connect(url, self.root)

    def test_install_rejects_ssh_options_and_non_https_sites(self):
        original = (self.root / "desktop-login.json").read_bytes()
        for server, site in (("root@rotator.example -oProxyCommand=evil", "https://rotator.example"),
                             ("root@rotator.example", "http://rotator.example")):
            with self.subTest(server=server, site=site), self.assertRaises(ValueError):
                desktop_login.install(server, site, self.root, self.root / "apps")
        self.assertEqual((self.root / "desktop-login.json").read_bytes(), original)

    def test_wrong_google_account_never_reaches_upload_or_replaces_saved_cookies(self):
        source = self.root / "cookies.json"
        browser_login.save_private(source, {"__Secure-1PSID": "fixture-session"})
        args = argparse.Namespace(cookies_file=str(source), upload_only=True, profile=None)
        with patch.object(browser_login, "identify_account", return_value={"email": "other@example.com", "id": "other"}), \
                patch.object(browser_login, "install_remote") as upload:
            with self.assertRaisesRegex(browser_login.LoginError, "другой аккаунт"):
                browser_login.automatic_login(args, self.root, expected_email="user@example.com")
        upload.assert_not_called()
        self.assertFalse((self.root / "gemini-web").exists())
        self.assertEqual(json.loads(source.read_text()), {"__Secure-1PSID": "fixture-session"})

    def test_desktop_exec_escapes_field_codes_and_metacharacters(self):
        self.assertEqual(desktop_login.desktop_quote('/tmp/a%f$`"\\'), '"/tmp/a%%f\\$\\`\\"\\\\"')


if __name__ == "__main__":
    unittest.main()
