"""Browser login contracts; no real browser, account or Docker operations."""
import importlib.util
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("chatgpt_browser_login", Path(__file__).parents[1] / "src/providers/chatgpt-app/browser_login.py")
login = importlib.util.module_from_spec(spec)
spec.loader.exec_module(login)


class BrowserLoginTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.original = {"chatgpts": [{"email": "user@example.com", "access_token": "old-secret"}],
                         "auth": {"access_tokens": ["bridge-key"]}, "port": 3040}
        login.save_private(self.root / "app.prod.yaml", self.original)
        login.save_private(self.root / "session.json", {"email": "user@example.com", "baseUrl": "http://127.0.0.1:3040/v1", "apiKey": "bridge-key"})
        self.settings = {"configDir": str(self.root), "origin": "https://rotator.example", "project": "fixture", "composeFiles": []}

    def test_scheme_cannot_select_a_different_origin_or_command(self):
        self.assertEqual(login.parse_link("lyod-chatgpt://login?origin=https://rotator.example&account=User%40example.com",
                                         self.settings["origin"]), "user@example.com")
        for url in ["lyod-chatgpt://login?origin=https://evil.example",
                    "lyod-chatgpt://login?origin=https://rotator.example&proxy=https://evil.example",
                    "lyod-chatgpt://login?origin=https://rotator.example&origin=https://evil.example",
                    "lyod-chatgpt://login?origin=https://rotator.example&account=user%0A@example.com",
                    "https://rotator.example/login", "lyod-chatgpt://login?origin=https://rotator.example#secret"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                login.parse_link(url, self.settings["origin"])
        with self.assertRaises(ValueError):
            login.origin("http://rotator.example")

    def test_cookie_extraction_preserves_chunks_and_excludes_other_domains_and_expired_cookies(self):
        profile = self.root / "profile"
        profile.mkdir()
        with sqlite3.connect(profile / "cookies.sqlite") as db:
            db.execute("CREATE TABLE moz_cookies(host,path,name,value,originAttributes,expiry,isSecure)")
            rows = [('.chatgpt.com', '/', '__Secure-next-auth.session-token.0', 'part0', '', int(time.time()) + 3600, 1),
                    ('.chatgpt.com', '/', '__Secure-next-auth.session-token.1', 'part1', '', int(time.time()) + 3600, 1),
                    ('.evil.example', '/', 'secret', 'evil', '', 0, 1),
                    ('.chatgpt.com', '/', 'expired', 'old', '', 1, 1),
                    ('.chatgpt.com', '/', 'container', 'other', 'userContextId=1', 0, 1)]
            db.executemany("INSERT INTO moz_cookies VALUES (?,?,?,?,?,?,?)", rows)
        db.close()
        self.assertEqual([row[3] for row in login.read_cookies(profile)], ['part0', 'part1'])

    def test_fresh_signin_clears_only_openai_cookies_and_preserves_bitwarden(self):
        profile = self.root / 'profile'
        profile.mkdir()
        extension = profile / 'bitwarden-storage-fixture'
        extension.write_text('vault-fixture')
        with closing(sqlite3.connect(profile / 'cookies.sqlite')) as db, db:
            db.execute('CREATE TABLE moz_cookies(host, name, value)')
            db.executemany('INSERT INTO moz_cookies VALUES (?,?,?)', [
                ('.chatgpt.com', 'session', 'private'), ('auth.openai.com', 'session', 'private'),
                ('vault.bitwarden.com', 'vault', 'keep'), ('accounts.google.com', 'google', 'keep'),
                ('evilchatgpt.com', 'other', 'keep')])
        login.clear_browser_signin(profile)
        with closing(sqlite3.connect(profile / 'cookies.sqlite')) as db, db:
            self.assertEqual({row[0] for row in db.execute('SELECT host FROM moz_cookies')},
                             {'vault.bitwarden.com', 'accounts.google.com', 'evilchatgpt.com'})
        self.assertEqual(extension.read_text(), 'vault-fixture')
        self.assertEqual(login.read_private(self.root / 'app.prod.yaml'), self.original)

    def test_running_firefox_profile_cannot_be_cleared(self):
        profile = self.root / 'profile'
        profile.mkdir()
        script = "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.lockf(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()"
        process = subprocess.Popen([sys.executable, '-c', script, str(profile / '.parentlock')],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), 'locked')
            with self.assertRaisesRegex(login.LoginError, 'Сначала закройте'):
                login.clear_browser_signin(profile)
        finally:
            process.communicate('', timeout=5)

    def test_general_login_uses_fresh_signin_but_explicit_refresh_preserves_it(self):
        with patch.object(login, 'firefox_login') as browser, patch.object(login, 'read_cookies', return_value=[]), \
             patch.object(login, 'fetch_session', return_value={"email": "user@example.com", "accessToken": "new-secret"}), \
             patch.object(login, 'restart_bridge'), patch.object(login, 'check_bridge'):
            login.connect(self.settings)
            self.assertTrue(browser.call_args.kwargs['fresh'])
            login.connect(self.settings, expected='user@example.com')
            self.assertFalse(browser.call_args.kwargs['fresh'])

    def test_fetch_checks_session_and_authenticated_catalog_without_redirects(self):
        client = Mock()
        client.get.side_effect = [Mock(status_code=200, json=lambda: {"user": {"email": "user@example.com"}, "accessToken": "new-secret"}),
                                  Mock(status_code=200, json=lambda: {"models": [{"slug": "gpt-6"}]})]
        client.__enter__ = Mock(return_value=client)
        client.__exit__ = Mock(return_value=False)
        with patch('curl_cffi.requests.Session', return_value=client):
            self.assertEqual(login.fetch_session([('.chatgpt.com', '/', 'cookie', 'private')]),
                             {"email": "user@example.com", "accessToken": "new-secret"})
        self.assertEqual([call.args[0] for call in client.get.call_args_list],
                         ['https://chatgpt.com/api/auth/session', 'https://chatgpt.com/backend-api/models'])
        self.assertTrue(all(call.kwargs['allow_redirects'] is False for call in client.get.call_args_list))
        self.assertEqual(client.get.call_args_list[1].kwargs['headers']['Authorization'], 'Bearer new-secret')

    def test_upstream_error_does_not_expose_response_or_cookie(self):
        client = Mock()
        client.__enter__ = Mock(return_value=client)
        client.__exit__ = Mock(return_value=False)
        client.get.return_value = Mock(status_code=403, text='secret-token')
        with patch('curl_cffi.requests.Session', return_value=client), self.assertRaises(login.LoginError) as caught:
            login.fetch_session([])
        self.assertNotIn('secret-token', str(caught.exception))
        self.assertEqual(client.get.call_count, 1)

    def run_connect(self, email='user@example.com', restart=None, expected=None):
        with patch.object(login, 'firefox_login') as browser, patch.object(login, 'read_cookies', return_value=[]), \
             patch.object(login, 'fetch_session', return_value={"email": email, "accessToken": "new-secret"}), \
             patch.object(login, 'restart_bridge', side_effect=restart) as docker, patch.object(login, 'check_bridge'):
            result = login.connect(self.settings, expected)
            return result, browser.call_args.args[0], docker.call_count

    def test_success_updates_only_token_and_reuses_profile(self):
        result, profile, restarts = self.run_connect()
        self.assertEqual(result, 'user@example.com')
        updated = login.read_private(self.root / 'app.prod.yaml')
        self.assertEqual(updated, dict(self.original, chatgpts=[{"email": "user@example.com", "access_token": "new-secret"}]))
        self.assertEqual(restarts, 1)
        self.assertEqual(self.run_connect()[1], profile)
        status = login.read_private(self.root / 'login-status.json')
        self.assertTrue(status['ok'])
        self.assertNotIn('new-secret', json.dumps(status))

    def test_explicit_refresh_rejects_a_different_account(self):
        with patch.object(login, 'restart_bridge') as restart:
            with self.assertRaisesRegex(login.LoginError, 'выбрали обновление'):
                self.run_connect('other@example.com', expected='user@example.com')
        restart.assert_not_called()
        self.assertEqual(login.read_private(self.root / 'app.prod.yaml'), self.original)
        self.assertFalse((self.root / 'login-status.json').exists())

    def provision(self):
        resolved = {"services": {
            "chatgpt-app": {"image": "fixture-app", "ports": [{"published": "3040"}]},
            "chatgpt-app-transport": {"image": "fixture-transport"}}}
        return patch.object(login.subprocess, 'run', return_value=Mock(stdout=json.dumps(resolved)))

    def test_new_account_has_its_own_bridge_and_original_is_untouched(self):
        _, old_profile, _ = self.run_connect()
        with self.provision():
            result, profile, restarts = self.run_connect('other@example.com')
        self.assertEqual(result, 'other@example.com')
        self.assertEqual(profile, old_profile)  # Keeps Bitwarden and the existing browser profile.
        self.assertEqual(restarts, 1)
        status = login.read_private(self.root / 'login-status.json')
        self.assertTrue(status['created'])
        connection = login.read_private(status['sessionFile'])
        target = Path(status['sessionFile']).parent
        config = login.read_private(target / 'app.prod.yaml')
        self.assertEqual(config['chatgpts'], [{'email': 'other@example.com', 'access_token': 'new-secret'}])
        self.assertEqual(config['bind'], '127.0.0.1')
        self.assertNotEqual(connection['baseUrl'], 'http://127.0.0.1:3040/v1')
        self.assertNotEqual(connection['apiKey'], 'bridge-key')
        self.assertEqual(login.read_private(self.root / 'session.json')['email'], 'user@example.com')
        self.assertEqual(login.read_private(self.root / 'app.prod.yaml')['chatgpts'][0]['email'], 'user@example.com')
        self.assertNotIn('new-secret', json.dumps(status))
        compose = login.read_private(target / 'compose.json')
        self.assertNotIn('ports', compose['services']['chatgpt-app'])
        self.assertEqual(compose['services']['chatgpt-app-transport']['environment']['CHATGPT_TRANSPORT_BIND'],
                         config['chatgpt_base_url'].split('//')[1].split(':')[0])
        before = login.read_private(target / 'session.json')
        with patch.object(login.subprocess, 'run') as provision:
            self.run_connect('OTHER@example.com')
        provision.assert_not_called()
        self.assertFalse(login.read_private(self.root / 'login-status.json')['created'])
        self.assertEqual(login.read_private(target / 'session.json'), before)

    def test_stopped_accounts_keep_their_address_and_port(self):
        with self.provision():
            self.run_connect('first@example.com')
            first_status = login.read_private(self.root / 'login-status.json')
            first = login.read_private(first_status['sessionFile'])
            self.run_connect('second@example.com')
        second_status = login.read_private(self.root / 'login-status.json')
        second = login.read_private(second_status['sessionFile'])
        self.assertNotEqual(first['baseUrl'], second['baseUrl'])
        first_config = login.read_private(Path(first_status['sessionFile']).parent / 'app.prod.yaml')
        second_config = login.read_private(Path(second_status['sessionFile']).parent / 'app.prod.yaml')
        self.assertNotEqual(first_config['chatgpt_base_url'], second_config['chatgpt_base_url'])

    def test_failed_new_account_start_leaves_original_unchanged(self):
        with self.provision():
            with self.assertRaisesRegex(login.LoginError, 'Прежние аккаунты не изменены'):
                self.run_connect('other@example.com', restart=RuntimeError('Failed'))
        self.assertEqual(login.read_private(self.root / 'app.prod.yaml'), self.original)
        self.assertEqual(list((self.root / 'accounts').iterdir()), [])
        self.assertFalse((self.root / 'login-status.json').exists())

    def test_restart_failure_rolls_back_configuration_and_restarts_old_bridge(self):
        with patch.object(login, 'firefox_login'), patch.object(login, 'read_cookies', return_value=[]), \
             patch.object(login, 'fetch_session', return_value={"email": "user@example.com", "accessToken": "new-secret"}), \
             patch.object(login, 'restart_bridge', side_effect=[RuntimeError('private-upstream'), None]) as restart:
            with self.assertRaisesRegex(login.LoginError, 'Прежнее подключение восстановлено'):
                login.connect(self.settings)
            self.assertEqual(restart.call_count, 2)
        self.assertEqual(login.read_private(self.root / 'app.prod.yaml'), self.original)

    def test_failed_verification_leaves_existing_configuration_unchanged(self):
        with patch.object(login, 'firefox_login'), patch.object(login, 'read_cookies', return_value=[]), \
             patch.object(login, 'fetch_session', side_effect=login.LoginError('Rejected')), \
             patch.object(login, 'restart_bridge') as restart:
            with self.assertRaises(login.LoginError):
                login.connect(self.settings)
            restart.assert_not_called()
        self.assertEqual(login.read_private(self.root / 'app.prod.yaml'), self.original)

    def test_bridge_readiness_failure_restores_old_token(self):
        with patch.object(login, 'firefox_login'), patch.object(login, 'read_cookies', return_value=[]), \
             patch.object(login, 'fetch_session', return_value={"email": "user@example.com", "accessToken": "new-secret"}), \
             patch.object(login, 'restart_bridge') as restart, \
             patch.object(login, 'check_bridge', side_effect=login.LoginError('Not ready')):
            with self.assertRaisesRegex(login.LoginError, 'Прежнее подключение восстановлено'):
                login.connect(self.settings)
            self.assertEqual(restart.call_count, 2)
        self.assertEqual(login.read_private(self.root / 'app.prod.yaml'), self.original)

    def test_concurrent_configuration_change_is_not_overwritten(self):
        changed = dict(self.original, port=3049)
        def browser(_profile, **_kwargs):
            login.save_private(self.root / 'app.prod.yaml', changed)
        with patch.object(login, 'firefox_login', side_effect=browser), patch.object(login, 'read_cookies', return_value=[]), \
             patch.object(login, 'fetch_session', return_value={"email": "user@example.com", "accessToken": "new-secret"}), \
             patch.object(login, 'restart_bridge') as restart:
            with self.assertRaisesRegex(login.LoginError, 'изменилась во время входа'):
                login.connect(self.settings)
            restart.assert_not_called()
        self.assertEqual(login.read_private(self.root / 'app.prod.yaml'), changed)

    def test_parallel_login_is_rejected_before_opening_second_browser(self):
        def nested(_profile, **_kwargs):
            with self.assertRaisesRegex(login.LoginError, 'Вход уже открыт'):
                login.connect(self.settings)
            raise login.LoginError('Stop fixture')
        with patch.object(login, 'firefox_login', side_effect=nested):
            with self.assertRaisesRegex(login.LoginError, 'Stop fixture'):
                login.connect(self.settings)

    def test_install_registers_handler_and_private_settings(self):
        apps = self.root / 'apps'
        with patch.object(login.subprocess, 'run') as run:
            login.install(self.settings, self.root, apps)
        run.assert_called_once_with(['xdg-mime', 'default', login.DESKTOP_ID, 'x-scheme-handler/lyod-chatgpt'], check=True, timeout=15)
        self.assertIn('--open %u', (apps / login.DESKTOP_ID).read_text())
        self.assertEqual((self.root / 'browser-login.json').stat().st_mode & 0o777, 0o600)
        self.assertNotIn('bridge-key', (apps / login.DESKTOP_ID).read_text())


if __name__ == '__main__':
    unittest.main()
