"""Offline boundary checks; no provider credentials or paid/live requests."""
import asyncio
import hashlib
from contextlib import asynccontextmanager
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch
import unittest
import tempfile
import os

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/providers/web-app"))
import transport
import browser_login
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from pydantic import BaseModel


class Request(BaseModel):
    model: str
    messages: list
    stream: bool = False
    thinking: bool = False
    search: bool = False


class BoundaryTests(unittest.TestCase):
    def test_deepseek_manual_email_still_requires_server_account_id(self):
        async def identity(*_args, **_kwargs):
            return SimpleNamespace(status_code=200, json=lambda: {
                "code": 0, "data": {"biz_data": {"id": "account-1", "email": "a***@example.test"}}})
        config = dict(provider="deepseek-app", accountId="account-1", email="a@example.test", apiKey="test-key")
        with patch.object(self, "identity", identity):
            with TestClient(transport.create_app(config, self.upstream("deepseek-app"))):
                pass
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                with TestClient(transport.create_app({**config, "accountId": "other"}, self.upstream("deepseek-app"))):
                    pass

    def test_deepseek_refresh_accepts_label_only_for_same_verified_account(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            settings = dict(provider="deepseek-app", configDir=tmp)
            email = "a@example.test"
            directory = root / "accounts" / hashlib.sha256(email.encode()).hexdigest()[:24]
            browser_login.ui.save_private(directory / "session.json", dict(provider="deepseek-app", email=email,
                accountId="account-1", baseUrl="http://127.0.0.1:3340/v1", apiKey="test-key"))
            async def identity(*_args):
                return "account-1", "opaque@deepseek-app.local"
            fake = SimpleNamespace(DeepSeekClient=lambda **_kwargs: SimpleNamespace(aclose=self.close_client))
            with patch.dict(sys.modules, {"freetokenapi.deepseek.client": fake}), \
                 patch.object(browser_login, "firefox_login"), patch.object(browser_login, "extract_token", return_value="test-token"), \
                 patch.object(browser_login, "verify_identity", identity), patch.object(browser_login, "start_bridge"), \
                 patch.object(browser_login, "check_bridge", return_value=[]), patch.object(browser_login, "register"):
                self.assertEqual(browser_login.connect(settings, expected=email), email)
                async def wrong_identity(*_args):
                    return "other", "opaque@deepseek-app.local"
                with patch.object(browser_login, "verify_identity", wrong_identity), self.assertRaises(browser_login.LoginError):
                    browser_login.connect(settings, expected=email)

    async def close_client(self):
        pass

    def test_missing_email_requires_input_instead_of_creating_phantom(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(browser_login.LoginError, "укажите email"):
                browser_login.account_email(root, "deepseek-app", "one", "opaque@deepseek-app.local")
            self.assertEqual(browser_login.account_email(root, "deepseek-app", "one", "opaque@deepseek-app.local",
                request_email=lambda: " User@Example.com "), "user@example.com")
            with self.assertRaises(browser_login.LoginError):
                browser_login.account_email(root, "deepseek-app", "one", "opaque@deepseek-app.local",
                    request_email=lambda: "opaque@deepseek-app.local")
            self.assertEqual(browser_login.account_email(root, "qwen-app", "one", "user@example.com",
                request_email=lambda: self.fail("Known email must not prompt")), "user@example.com")
            self.assertFalse((root / "accounts").exists())
            legacy = root / "accounts/legacy/session.json"
            browser_login.ui.save_private(legacy, dict(provider="deepseek-app", accountId="one",
                                                       email="opaque@deepseek-app.local"))
            self.assertEqual(browser_login.account_email(root, "deepseek-app", "one", "opaque@deepseek-app.local",
                expected="opaque@deepseek-app.local"), "opaque@deepseek-app.local")
            self.assertEqual(browser_login.account_email(root, "deepseek-app", "one", "opaque@deepseek-app.local",
                request_email=lambda: "real@example.com"), "real@example.com")

    def test_deepseek_page_has_no_chatgpt_branding(self):
        ui = browser_login.ui
        page, connect, scheme = ui.PAGE, ui.connect, ui.SCHEME
        try:
            with patch.object(sys, "argv", ["login", "--provider", "deepseek-app"]), \
                 patch.object(ui, "read_private", return_value={}), patch.object(ui, "run_login", return_value=0) as run:
                self.assertEqual(browser_login.main(), 0)
                self.assertIn("LYOD ROTATOR · DEEPSEEK APP", ui.PAGE)
                self.assertNotIn("chatgpt", ui.PAGE.lower())
                self.assertTrue(run.call_args.kwargs["collect_email"])
        finally:
            ui.PAGE, ui.connect, ui.SCHEME = page, connect, scheme

    def upstream(self, provider):
        client = SimpleNamespace(http=SimpleNamespace(get=self.identity), fetch_models=self.fetch_models)
        account = SimpleNamespace(client=client)
        pool = SimpleNamespace(accounts=[account], healthy=[account])
        app = SimpleNamespace(state=SimpleNamespace(qwen_pool=pool, pool=pool))
        @asynccontextmanager
        async def lifespan(_):
            yield
        self.calls = []
        async def handler(req):
            self.calls.append(req)
            if req.messages[0].get("content") == "error":
                raise HTTPException(429, "SECRET token and private conversation")
            if req.stream:
                async def chunks():
                    yield 'data: {"choices":[{"delta":{"content":"FIRST"}}]}\n\n'
                    yield 'data: {"error":{"message":"SECRET"}}\n\n'
                return StreamingResponse(chunks(), media_type="text/event-stream")
            return {"choices": [{"message": {"content": "OK"}}]}
        async def configs(_pool):
            return {0: SimpleNamespace(thinking=True, search=True)}, []
        return SimpleNamespace(app=app, lifespan=lifespan, ChatCompletionRequest=Request,
                               _chat_completions_qwen=handler, _chat_completions_deepseek=handler,
                               _deepseek_model_configs=configs)

    async def identity(self, *_args, **_kwargs):
        return SimpleNamespace(status_code=200, json=lambda: {"id": "account-1", "email": "a@example.test"})

    async def fetch_models(self):
        return [{"id": "qwen-fixture", "name": "Fixture", "info": {"meta": {
            "chat_type": ["t2t"], "capabilities": {"thinking": True, "search": True}}}}]

    def client(self):
        config = dict(provider="qwen-app", accountId="account-1", email="a@example.test", apiKey="private-test-key")
        return TestClient(transport.create_app(config, self.upstream("qwen-app")))

    def test_private_routes_only(self):
        with self.client() as client:
            self.assertEqual(client.get("/v1/models").status_code, 401)
            self.assertEqual(client.get("/api/tokens", headers={"Authorization": "Bearer private-test-key"}).status_code, 404)
            self.assertEqual(client.get("/v1/models", headers={"Authorization": "Bearer private-test-key"}).json()["accountId"], "account-1")

    def test_exact_model_and_boolean_thinking(self):
        with self.client() as client:
            headers = {"Authorization": "Bearer private-test-key"}
            req = dict(model="qwen-fixture", messages=[{"role": "user", "content": "OK"}])
            self.assertEqual(client.post("/v1/chat/completions", headers=headers, json={**req, "model": "qwen-guessed"}).status_code, 404)
            self.assertFalse(self.calls)
            self.assertEqual(client.post("/v1/chat/completions", headers=headers, json=req).status_code, 200)
            self.assertFalse(self.calls[0].thinking)
            self.assertEqual(client.post("/v1/chat/completions", headers=headers, json={**req, "thinking": "high"}).status_code, 400)

    def test_error_redaction_and_stream(self):
        with self.client() as client:
            headers = {"Authorization": "Bearer private-test-key"}
            req = dict(model="qwen-fixture", messages=[{"role": "user", "content": "error"}])
            response = client.post("/v1/chat/completions", headers=headers, json=req)
            self.assertEqual(response.status_code, 429)
            self.assertNotIn("SECRET", response.text)
            response = client.post("/v1/chat/completions", headers=headers, json={**req, "messages": [{"role": "user", "content": "OK"}], "stream": True})
            self.assertIn("FIRST", response.text)
            self.assertIn("Web upstream stream failed", response.text)
            self.assertNotIn("SECRET", response.text)

    def test_catalog_has_no_default_fallback(self):
        with self.assertRaises(ValueError):
            transport.qwen_models([])
        entries = transport.qwen_models([
            {"id": "image-real", "info": {"meta": {"chat_type": ["t2i"]}}},
            {"id": "disabled", "disabled": True},
            {"id": "unknown-real"}])
        self.assertEqual([m["id"] for m in entries], ["image-real", "unknown-real"])
        self.assertTrue(all(not m["chat"] for m in entries))

    def test_firefox_storage_encodings(self):
        import cramjam
        for conversion, raw in [(0, 'токен'.encode('utf-16-le')), (1, 'токен'.encode())]:
            self.assertEqual(browser_login.decode_storage(raw, conversion, 0), 'токен')
            packed = bytes(cramjam.snappy.compress_raw(raw))
            self.assertEqual(browser_login.decode_storage(packed, conversion, 1), 'токен')

    def test_qwen_version_comes_from_latest_cached_bundle(self):
        with tempfile.TemporaryDirectory() as root:
            profile = Path(root)
            with self.assertRaises(browser_login.LoginError):
                browser_login.frontend_version(profile)
            cache = profile / "cache2/entries"
            cache.mkdir(parents=True)
            old = cache / "old"
            old.write_bytes(b"https://cdn.example/qwen-chat-fe/0.2.83/js/main.js")
            os.utime(old, (1, 1))
            (cache / "new").write_bytes(b"https://cdn.example/qwen-chat-fe/0.3.20/js/main.js")
            (cache / "unrelated").write_bytes(b"unrelated 99.0.0 SECRET")
            self.assertEqual(browser_login.frontend_version(profile), "0.3.20")

    def test_identity_requires_stable_id(self):
        with self.assertRaises(ValueError):
            transport.identity_payload("qwen-app", {"token": "SECRET"})
        self.assertEqual(transport.identity_payload("qwen-app", {"id": "stable", "email": "A@example.test"}), ("stable", "a@example.test"))
        first = transport.identity_payload("deepseek-app", {"code": 0, "data": {"biz_data": {"id": "one", "email": "a***@example.test"}}})
        second = transport.identity_payload("deepseek-app", {"code": 0, "data": {"biz_data": {"id": "two", "email": "a***@example.test"}}})
        self.assertNotEqual(first[1], second[1])
        self.assertTrue(first[1].endswith("@deepseek-app.local"))
        with self.assertRaises(ValueError):
            transport.identity_payload("deepseek-app", {"code": 0, "data": {"biz_code": 401, "biz_data": {"id": "x"}}})


if __name__ == "__main__":
    unittest.main()
