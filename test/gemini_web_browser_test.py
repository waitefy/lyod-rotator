"""Dedicated Firefox extraction and SSH receiver rollback, using synthetic cookies."""
import argparse
import contextlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "src/providers/gemini-web"))
import browser_login


class BrowserTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_only_extracts_secure_unexpired_google_cookies_from_normal_profile(self):
        with sqlite3.connect(self.root / "cookies.sqlite") as connection:
            connection.execute("CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, path TEXT, isSecure INTEGER, originAttributes TEXT, expiry INTEGER)")
            rows = [("__Secure-1PSID", "fixture", ".google.com", "/", 1, "", time.time() + 3600),
                    ("__Secure-1PSIDTS", "expired", ".google.com", "/", 1, "", 1),
                    ("__Secure-1PSID", "other-domain", ".example.com", "/", 1, "", time.time() + 3600),
                    ("__Secure-1PSID", "container", ".google.com", "/", 1, "^userContextId=2", time.time() + 3600),
                    ("__Secure-1PSID", "insecure", ".google.com", "/", 0, "", time.time() + 3600)]
            connection.executemany("INSERT INTO moz_cookies VALUES (?,?,?,?,?,?,?)", rows)
        self.assertEqual(browser_login.read_cookies(self.root), {"__Secure-1PSID": "fixture"})
        destination = self.root / "session.json"
        browser_login.save_private(destination, browser_login.read_cookies(self.root))
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

    def test_ssh_sends_cookies_only_over_stdin(self):
        path = self.root / "cookies.json"
        path.write_text(json.dumps({"__Secure-1PSID": "private-test-value"}))
        args = argparse.Namespace(cookies_file=str(path), remote_cookie_file="/sessions/c.json", server_cookie_file="/sessions/c.json",
                                  remote_state_dir="/state", email="web@local", server="root@example.test")
        def run(command, *, input, **kwargs):
            self.assertNotIn("private-test-value", repr(command))
            self.assertEqual(json.loads(input)["cookies"]["__Secure-1PSID"], "private-test-value")
            return subprocess.CompletedProcess(command, 0, b'{"email":"web@local","isNew":false}', b"")
        with patch.object(browser_login.subprocess, "run", run), contextlib.redirect_stdout(io.StringIO()) as output:
            browser_login.install_remote(args)
        self.assertNotIn("private-test-value", output.getvalue())

    def test_preserves_additional_google_session_cookies(self):
        with sqlite3.connect(self.root / "cookies.sqlite") as connection:
            connection.execute("CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, path TEXT, isSecure INTEGER, originAttributes TEXT, expiry INTEGER)")
            rows = [(name, "fixture-" + name, ".google.com", "/", secure, "", time.time() + 3600)
                    for name, secure in (("__Secure-1PSID", 1), ("SAPISID", 1), ("SID", 0), ("HSID", 0),
                                         ("APISID", 0), ("SIDCC", 0), ("SOCS", 0), ("GOOGLE_ABUSE_EXEMPTION", 0))]
            connection.executemany("INSERT INTO moz_cookies VALUES (?,?,?,?,?,?,?)", rows)
        self.assertEqual(set(browser_login.read_cookies(self.root)), {row[0] for row in rows})

    def test_server_rejection_preserves_http_status_without_exposing_response_or_blame(self):
        path = self.root / "cookies.json"
        path.write_text(json.dumps({"__Secure-1PSID": "private-session"}))
        args = argparse.Namespace(cookies_file=str(path), remote_cookie_file="/sessions/c.json", server_cookie_file="/sessions/c.json",
                                  remote_state_dir="/state", email="web@local", server="root@example.test")
        for status in (401, 403, 404, 429, 502, None):
            result = subprocess.CompletedProcess([], 1, json.dumps({"error": "server-login-rejected", "status": status}).encode(), b"private-upstream-response")
            with self.subTest(status=status), patch.object(browser_login.subprocess, "run", return_value=result):
                with self.assertRaises(browser_login.LoginError) as caught:
                    browser_login.install_remote(args)
                message = str(caught.exception)
                self.assertNotIn("private", message)
                if status:
                    self.assertIn(str(status), message)
                if status in (401, 403):
                    self.assertIn("IP сервера", message)
                    self.assertNotIn("Проверьте доступность Argon", message)

    def test_identity_request_uses_complete_cookie_jar_and_reports_google_challenge(self):
        cookies = {"__Secure-1PSID": "private-session", "SOCS": "private-consent"}
        def open_request(opener, request, *args, **kwargs):
            self.assertIn("SOCS=private-consent", request.get_header("Cookie"))
            raise urllib.error.HTTPError(request.full_url, 302, "private-error", {"Location": "https://www.google.com/sorry/index?secret=private-token"}, None)
        with patch.object(browser_login.urllib.request.OpenerDirector, "open", open_request):
            with self.assertRaisesRegex(ValueError, "Google.*провер") as caught:
                browser_login.identify_account(cookies)
        self.assertNotIn("private", str(caught.exception))

    def test_failed_identity_keeps_private_session_for_retry(self):
        args = argparse.Namespace(cookies_file=str(self.root / "unused.json"), upload_only=False, profile=None, firefox="firefox", email=None)
        def login(profile, destination, firefox):
            browser_login.save_private(destination, {"__Secure-1PSID": "private-session"})
        with patch.object(browser_login, "browser_login", login), \
             patch.object(browser_login, "identify_account", side_effect=ValueError("fixture failure")):
            with self.assertRaises(ValueError):
                browser_login.automatic_login(args, self.root)
        saved = list(self.root.glob("pending-*/cookies.json"))
        self.assertEqual(len(saved), 1)
        self.assertEqual(json.loads(saved[0].read_text()), {"__Secure-1PSID": "private-session"})
        self.assertEqual(saved[0].stat().st_mode & 0o777, 0o600)

    def test_identity_requires_the_authenticated_bootstrap_and_is_stable_across_cookies(self):
        identity = {"oPEP7c": "User@example.test", "S06Grb": "1234567890", "SNlM0e": "fixture-token"}
        page = '<script>window.WIZ_global_data = ' + json.dumps(identity) + ';</script>'
        self.assertEqual(browser_login.parse_identity(page), {"email": "user@example.test", "id": "1234567890"})
        for invalid in ({}, {**identity, "SNlM0e": ""}, {**identity, "S06Grb": "../other"},
                        {**identity, "oPEP7c": "invalid"}, []):
            with self.assertRaises(ValueError):
                browser_login.parse_identity("WIZ_global_data=" + json.dumps(invalid))
        with self.assertRaises(ValueError):
            browser_login.parse_identity("<p>Some unrelated email: user@example.test</p>")

    def test_automatic_login_isolates_browser_profiles_and_derives_files_from_account_id(self):
        args = argparse.Namespace(cookies_file=str(self.root / "unused.json"), upload_only=False, profile=None, firefox="firefox", email=None)
        profiles, sessions = [], []
        def login(profile, destination, firefox):
            profiles.append(profile)
            browser_login.save_private(destination, {"__Secure-1PSID": "fixture-new"})
        def install(args):
            sessions.append((args.cookies_file, args.identity))
            self.assertEqual(Path(args.cookies_file).stat().st_mode & 0o777, 0o600)
        with patch.object(browser_login, "browser_login", login), \
             patch.object(browser_login, "identify_account", return_value={"email":"one@example.test", "id":"1234567890"}), \
             patch.object(browser_login, "install_remote", install):
            browser_login.automatic_login(args, self.root)
            browser_login.automatic_login(args, self.root)
        self.assertNotEqual(profiles[0], profiles[1])
        self.assertEqual(sessions[0], sessions[1])
        self.assertFalse(Path(profiles[0]).exists())

    def test_receiver_detects_new_existing_and_legacy_accounts_without_overwriting_other_sessions(self):
        config = {"accounts": [{"email": "legacy@local", "credentials": [{"provider":"gemini-web", "cookiesFile":"/sessions/legacy.json"}]}]}
        (self.root / "legacy.json").write_text(json.dumps({"__Secure-1PSID":"first-cookie"}))
        (self.root / ".admin-token").write_text("fixture-admin-token")
        status = [200]
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append(body)
                existing = next((a for a in config["accounts"] if a["email"] == body["email"]), None)
                is_new = existing is None
                if status[0] == 200:
                    entry = {"email":body["email"], "credentials":[{"provider":"gemini-web", "cookiesFile":body["cookiesFile"]}]}
                    if existing:
                        existing.update(entry)
                    else:
                        config["accounts"].append(entry)
                    (self_root / "accounts.json").write_text(json.dumps(config))
                self.send_response(status[0]); self.end_headers()
                self.wfile.write(json.dumps({"ok":status[0] == 200,"isNew":is_new}).encode())
            def log_message(self, *args): pass
        self_root = self.root
        server = HTTPServer(("127.0.0.1",0), Handler)
        config["proxyPort"] = server.server_port
        (self.root / "accounts.json").write_text(json.dumps(config))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def install(account_id, email, cookie, expected=0):
            payload = {"destination":str(self.root/"default.json"),"stateDir":str(self.root),"apiCookiePath":"/sessions/default.json", "email":None,
                       "cookies":{"__Secure-1PSID":cookie},"identity":{"id":account_id,"email":email}}
            reply = subprocess.run([sys.executable,"-c",browser_login.REMOTE_INSTALL], input=json.dumps(payload).encode(),capture_output=True,timeout=5)
            self.assertEqual(reply.returncode,expected,reply.stderr.decode())
            self.assertNotIn(cookie.encode(),reply.stdout+reply.stderr)
            return json.loads(reply.stdout) if not expected else None
        try:
            first = install("11111111","first@example.test","first-cookie")
            self.assertEqual(first,{"email":"legacy@local","isNew":False})
            self.assertEqual(calls[-1]["cookiesFile"],"/sessions/legacy.json")
            second = install("22222222","second@example.test","second-cookie")
            self.assertTrue(second["isNew"])
            second_path = self.root / Path(calls[-1]["cookiesFile"]).name
            self.assertNotEqual(second_path, self.root/"legacy.json")
            install("11111111","first@example.test","renewed-first-cookie")
            self.assertEqual(calls[-1]["email"],"legacy@local")
            self.assertEqual(json.loads((self.root/"legacy.json").read_text())["__Secure-1PSID"],"renewed-first-cookie")
            self.assertEqual(json.loads(second_path.read_text())["__Secure-1PSID"],"second-cookie")
            install("22222222","second@example.test","renewed-second-cookie")
            self.assertEqual(len(config["accounts"]),2)
            self.assertEqual(calls[-1]["cookiesFile"],"/sessions/"+second_path.name)
            old_index = (self.root/"account-identities.json").read_bytes()
            status[0] = 401
            install("22222222","second@example.test","rejected-cookie",expected=1)
            self.assertEqual((self.root/"account-identities.json").read_bytes(),old_index)
            self.assertEqual(json.loads(second_path.read_text())["__Secure-1PSID"],"renewed-second-cookie")
            install("33333333","third@example.test","rejected-new-cookie",expected=1)
            self.assertEqual(len(config["accounts"]),2)
            self.assertEqual(len(json.loads((self.root/"account-identities.json").read_text())),2)
            self.assertEqual((self.root/"account-identities.json").stat().st_mode & 0o777,0o600)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_receiver_registers_session_and_restores_old_file_on_rejection(self):
        status = [200]
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(status[0])
                self.end_headers()
                self.wfile.write(json.dumps({"ok": status[0] == 200}).encode())
            def log_message(self, *args):
                pass
        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            (self.root / "accounts.json").write_text(json.dumps({"proxyPort": server.server_port}))
            (self.root / ".admin-token").write_text("fixture-admin-token")
            destination = self.root / "cookies.json"
            payload = {"destination": str(destination), "stateDir": str(self.root), "cookies": {"__Secure-1PSID": "private-new"},
                       "apiCookiePath": "/sessions/c.json", "email": "web@local"}
            for code in (200, 401):
                status[0] = code
                destination.write_text("old-cookie-content")
                reply = subprocess.run([sys.executable, "-c", browser_login.REMOTE_INSTALL], input=json.dumps(payload).encode(), capture_output=True, timeout=5)
                self.assertEqual(reply.returncode, 0 if code == 200 else 1)
                self.assertNotIn(b"private-new", reply.stdout + reply.stderr)
                self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
                if code == 200:
                    self.assertEqual(json.loads(destination.read_text()), payload["cookies"])
                else:
                    self.assertEqual(destination.read_text(), "old-cookie-content")
            self.assertEqual(requests[-1], ("/api/cli-login", {"provider": "gemini-web", "email": "web@local", "cookiesFile": "/sessions/c.json"}))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_receiver_remembers_canonical_email_returned_by_server_and_keeps_session_path(self):
        (self.root / "legacy.json").write_text(json.dumps({"__Secure-1PSID":"fixture-cookie"}))
        (self.root / ".admin-token").write_text("fixture-token")
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                calls.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200); self.end_headers()
                self.wfile.write(json.dumps({"ok":True,"email":"owner@example.test","isNew":False}).encode())
            def log_message(self, *args): pass
        server = HTTPServer(("127.0.0.1",0), Handler)
        thread = threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            (self.root / "accounts.json").write_text(json.dumps({"proxyPort":server.server_port,"accounts":[
                {"email":"gemini-web-session@local","credentials":[{"provider":"gemini-web","cookiesFile":"/sessions/legacy.json"}]}]}))
            payload = {"destination":str(self.root/"default.json"),"stateDir":str(self.root),"apiCookiePath":"/sessions/default.json",
                "email":None,"cookies":{"__Secure-1PSID":"fixture-cookie"},"identity":{"id":"1234567890","email":"owner@example.test"}}
            result = subprocess.run([sys.executable,"-c",browser_login.REMOTE_INSTALL],input=json.dumps(payload).encode(),capture_output=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr.decode())
            self.assertEqual(json.loads(result.stdout)["email"],"owner@example.test")
            saved=json.loads((self.root/"account-identities.json").read_text())["1234567890"]
            self.assertEqual(saved["email"],"owner@example.test")
            self.assertEqual(saved["apiCookiePath"],"/sessions/legacy.json")
            self.assertEqual(calls[0]["cookiesFile"],"/sessions/legacy.json")
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
