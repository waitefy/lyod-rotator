"""Offline boundary checks; no provider credentials or paid/live requests."""
import asyncio
from contextlib import asynccontextmanager
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
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
        with self.assertRaises(ValueError):
            transport.identity_payload("deepseek-app", {"code": 0, "data": {"biz_code": 401, "biz_data": {"id": "x"}}})


if __name__ == "__main__":
    unittest.main()
