"""Offline Qwen refresh regressions, including rotation and failure preservation."""
import asyncio
import base64
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/providers/web-app'))
from qwen_auth import QwenAuth, save_config


def token(exp):
    return 'fixture.' + base64.urlsafe_b64encode(json.dumps({'exp': exp}).encode()).decode().rstrip('=') + '.fixture'


class RefreshTests(unittest.IsolatedAsyncioTestCase):
    async def test_refresh_is_single_flight_and_persists_rotated_credentials(self):
        calls = []
        async def respond(request):
            calls.append(request)
            self.assertEqual(str(request.url), 'https://auth.qwen.ai/api/v2/auths/refresh')
            self.assertNotIn('authorization', request.headers)
            self.assertEqual(request.headers['x-request-origin'], 'https://chat.qwen.ai')
            self.assertIn('refresh_token=old-refresh', request.headers['cookie'])
            self.assertTrue(request.headers['Timezone'])
            await asyncio.sleep(0)
            return httpx.Response(200, json={'success': True, 'data': {'access_token': token(2000), 'refresh_token': 'new-refresh'}}, headers={'set-cookie': 'auth-session=new-session; Domain=auth.qwen.ai; Path=/'})
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'private.json'
            config = dict(token=token(900), refreshToken='old-refresh', frontendVersion='0.3.20')
            save_config(path, config)
            manager = QwenAuth(config, path, clock=lambda: 1000)
            async with httpx.AsyncClient(headers={'User-Agent': 'fixture'}) as http:
                client = SimpleNamespace(http=http, token=config['token'])
                def factory(**_kwargs):
                    return httpx.AsyncClient(transport=httpx.MockTransport(respond))
                with patch('curl_cffi.requests.AsyncSession', factory):
                    await asyncio.gather(*(manager.ensure(client) for _ in range(4)))
                self.assertEqual(len(calls), 1)
                self.assertEqual(json.loads(path.read_text())['refreshToken'], 'new-refresh')
                self.assertEqual(config['authSession'], 'new-session')
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(client.token, token(2000))
                self.assertEqual(http.headers['Authorization'], 'Bearer ' + token(2000))

    async def test_rejection_or_waf_does_not_destroy_saved_session(self):
        for response in [httpx.Response(401), httpx.Response(200, text='<html>challenge</html>'), httpx.Response(200, json={'success': False, 'data': {'access_token': token(2000)}})]:
            with self.subTest(status=response.status_code), tempfile.TemporaryDirectory() as root:
                path = Path(root) / 'private.json'
                config = dict(token=token(900), refreshToken='old-refresh', frontendVersion='0.3.20')
                save_config(path, config)
                before = path.read_bytes()
                async with httpx.AsyncClient(headers={'User-Agent': 'fixture'}) as http:
                    manager = QwenAuth(config, path, clock=lambda: 1000)
                    with patch('curl_cffi.requests.AsyncSession', lambda **_kw: httpx.AsyncClient(transport=httpx.MockTransport(lambda _r: response))):
                        with self.assertRaises(ValueError):
                            await manager.ensure(SimpleNamespace(http=http))
                self.assertEqual(path.read_bytes(), before)
                self.assertEqual(config['refreshToken'], 'old-refresh')

    async def test_valid_access_token_does_not_refresh(self):
        config = dict(token=token(2000))
        async with httpx.AsyncClient() as http:
            client = SimpleNamespace(http=http)
            with patch('curl_cffi.requests.AsyncSession', side_effect=AssertionError('unnecessary refresh')):
                await QwenAuth(config, clock=lambda: 1000).ensure(client)
            self.assertEqual(client.token, token(2000))


if __name__ == '__main__':
    unittest.main()
