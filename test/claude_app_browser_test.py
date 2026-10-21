"""Local Claude login contracts; no real credentials, browser or upstream requests."""
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import tomllib
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("claude_browser_test", Path(__file__).parents[1] / "src/providers/claude-app/browser_login.py")
login = importlib.util.module_from_spec(spec)
spec.loader.exec_module(login)


class ClaudeLoginTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings = {"configDir": str(self.root), "origin": "https://rotator.example"}
        self.session = {"email": "one@example.com", "modelSelection": "default-only"}

    def test_scheme_restricts_origin_and_parameters(self):
        self.assertEqual(login.ui.parse_link("lyod-claude://login?origin=https://rotator.example&account=ONE%40example.com", self.settings["origin"]), "one@example.com")
        for url in ["lyod-claude://login?origin=https://evil.example", "lyod-claude://login?origin=https://rotator.example&proxy=https://evil.example", "lyod-chatgpt://login?origin=https://rotator.example"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                login.ui.parse_link(url, self.settings["origin"])

    def test_free_and_paid_identity_use_actual_model_catalog(self):
        from curl_cffi import requests
        for capabilities in (["chat"], ["chat", "claude_pro"]):
            response = Mock(status_code=200)
            response.json.return_value = {"account": {"email_address": "one@example.com", "memberships": [{"organization": {"uuid": "fixture", "capabilities": capabilities}}]}}
            catalog = Mock(status_code=200)
            catalog.json.return_value = {"model_selector_config": [{"id": "chat", "models": [
                {"id": "claude-sonnet-5-5", "thinking": {"effort_options": [{"id": effort} for effort in ("low", "medium", "high", "xhigh", "max")]}},
                {"id": "claude-opus-5-5", "disabled": True},
                {"id": "claude-fable-5", "disabled_reason": {"type": "upgrade_required"}},
            ]}]}
            client = Mock()
            client.get.side_effect = [response, catalog]
            with patch.object(requests, "Session") as factory:
                factory.return_value.__enter__.return_value = client
                identity = login.identity([(".claude.ai", "/", "sessionKey", "private-fixture")])
                self.assertEqual(identity["modelSelection"], "explicit")
                self.assertEqual(identity["availableModels"], [{"id": "claude-sonnet-5-5", "efforts": ["low", "medium", "high", "xhigh", "max"]}])
                self.assertEqual(client.get.call_args.args[0], "https://claude.ai/api/organizations/fixture/model_selector/chat")
                self.assertFalse(client.get.call_args.kwargs["allow_redirects"])

    def test_catalog_excludes_disabled_efforts_and_other_surfaces(self):
        catalog = {"model_selector_config": [
            {"id": "other", "models": [{"id": "claude-opus-5-5"}]},
            {"id": "chat", "models": [{"id": "claude-sonnet-5-5", "thinking": {"effort_options": [
                {"id": "low"}, {"id": "high", "disabled": True},
                {"id": "max", "disabled_reason": "upgrade_required"}, {"id": "unknown"}]}}]}]}
        self.assertEqual(login.available_models(catalog), [{"id": "claude-sonnet-5-5", "efforts": ["low"]}])

    def test_config_disables_secret_logs_and_retries_and_pins_web_endpoint(self):
        connection = {**self.session, "baseUrl": "http://127.0.0.1:3140/v1", "apiKey": "key", "adminApiKey": "admin-key"}
        data = tomllib.loads(login.config_text(connection, 'cookie"\\fixture'))
        self.assertTrue(data["no_fs"])
        self.assertFalse(data["log_to_file"])
        self.assertEqual(data["admin_password"], "admin-key")
        self.assertEqual(data["rproxy"], "https://claude.ai/")
        self.assertEqual(data["max_retries"], 0)
        self.assertFalse(data["skip_non_pro"])
        self.assertFalse(data["use_real_roles"])
        self.assertNotIn("custom_prompt", data)
        self.assertEqual(data["cookie_array"], [{"cookie": 'cookie"\\fixture'}])

    def test_cookie_extraction_excludes_other_sites_containers_and_expired_entries(self):
        profile = self.root / "profile"
        profile.mkdir()
        with closing(sqlite3.connect(profile / "cookies.sqlite")) as db, db:
            db.execute("CREATE TABLE moz_cookies(host,path,name,value,originAttributes,expiry,isSecure)")
            db.executemany("INSERT INTO moz_cookies VALUES (?,?,?,?,?,?,?)", [
                (".claude.ai", "/", "sessionKey", "fixture", "", 0, 1),
                (".google.com", "/", "private", "excluded", "", 0, 1),
                (".claude.ai", "/", "expired", "excluded", "", 1, 1),
                (".claude.ai", "/", "container", "excluded", "userContextId=1", 0, 1)])
        self.assertEqual(login.read_cookies(profile), [(".claude.ai", "/", "sessionKey", "fixture")])

    def test_mismatched_refresh_never_allocates_or_writes_account(self):
        with patch.object(login, "BINARY", Path(__file__)), patch.object(login, "firefox_login"), patch.object(login, "read_cookies", return_value=[]), patch.object(login, "identity", return_value=self.session), patch.object(login, "allocate") as allocate:
            with self.assertRaisesRegex(login.LoginError, "Ожидался"):
                login.connect(self.settings, "another@example.com")
            allocate.assert_not_called()

    def test_failed_refresh_restores_exact_previous_configuration(self):
        directory, connection = login.allocate(self.root, self.session["email"])
        directory.mkdir(parents=True)
        connection.update(modelSelection="default-only")
        login.ui.save_private(directory / "session.json", connection)
        login.write_text_private(directory / "clewdr.toml", "old-config\n")
        previous = (directory / "session.json").read_bytes()
        sibling = self.root / "accounts" / "sibling.json"
        sibling.write_text("untouched")
        with patch.object(login, "BINARY", Path(__file__)), patch.object(login, "firefox_login"), patch.object(login, "read_cookies", return_value=[(".claude.ai", "/", "sessionKey", "fixture")]), patch.object(login, "identity", return_value=self.session), patch.object(login, "start_bridge") as start, patch.object(login.ui, "check_bridge", side_effect=RuntimeError("secret-upstream")):
            with self.assertRaisesRegex(login.LoginError, "восстановлено"):
                login.connect(self.settings, self.session["email"])
            self.assertEqual(start.call_count, 2)
        self.assertEqual((directory / "session.json").read_bytes(), previous)
        self.assertEqual((directory / "clewdr.toml").read_text(), "old-config\n")
        self.assertEqual(sibling.read_text(), "untouched")
        self.assertFalse((self.root / "login-status.json").exists())

    def test_success_keeps_profile_and_reuses_it_for_targeted_refresh(self):
        profiles = []
        def browser(profile, fresh):
            profiles.append((profile, fresh))
            profile.mkdir(parents=True, exist_ok=True)
            (profile / "extension-fixture").write_text("preserved")
        with patch.object(login, "BINARY", Path(__file__)), patch.object(login, "firefox_login", side_effect=browser), patch.object(login, "read_cookies", return_value=[(".claude.ai", "/", "sessionKey", "fixture")]), patch.object(login, "identity", return_value=self.session), patch.object(login, "start_bridge"), patch.object(login.ui, "check_bridge"):
            login.connect(self.settings)
            status = login.ui.read_private(self.root / "login-status.json")
            saved = login.ui.read_private(Path(status["sessionFile"]).parent / "browser-profile.json")
            self.assertEqual((Path(saved["path"]) / "extension-fixture").read_text(), "preserved")
            login.connect(self.settings, self.session["email"])
            self.assertEqual(profiles[-1], (Path(saved["path"]), False))
            self.assertEqual(Path(status["sessionFile"]).stat().st_mode & 0o777, 0o600)

    def test_reserved_account_ports_are_not_reassigned_when_bridge_is_stopped(self):
        directory, first = login.allocate(self.root, "one@example.com")
        directory.mkdir(parents=True)
        login.ui.save_private(directory / "session.json", first)
        _, second = login.allocate(self.root, "two@example.com")
        self.assertNotEqual(first["baseUrl"], second["baseUrl"])
        self.assertNotEqual(first["apiKey"], second["apiKey"])

    def test_service_runs_private_transport_with_current_interpreter(self):
        directory = self.root / "accounts" / "fixture-account"
        with patch.object(login.Path, "home", return_value=self.root), patch.object(login.subprocess, "run"):
            service = login.start_bridge(directory)
        text = (self.root / ".config/systemd/user" / service).read_text()
        self.assertIn(f'ExecStart="{login.sys.executable}"', text)
        self.assertIn('transport.py" --binary "', text)
        self.assertIn(str(login.BINARY), text)
        self.assertIn("StandardError=null", text)
        self.assertNotIn("sessionKey", text)


if __name__ == "__main__":
    unittest.main()
