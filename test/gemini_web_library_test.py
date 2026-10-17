"""Offline contract checks against the pinned gemini-webapi implementation."""
import asyncio
import contextlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).parents[1] / "src/providers/gemini-web"))
import worker

try:
    from gemini_webapi import GeminiClient
    from gemini_webapi.types import AvailableModel
except ImportError:
    GeminiClient = None


@unittest.skipIf(GeminiClient is None, "requires the pinned gemini-webapi environment")
class LibraryTest(unittest.IsolatedAsyncioTestCase):
    async def test_guard_errors_bypass_library_retries(self):
        selected = AvailableModel(model_id="fixture-argon", model_name="argon",
                                  display_name="Argon", description="", capacity=1)
        for code in (1100, 1037, 1013):
            with self.subTest(code=code):
                envelope = json.dumps([["wrb.fr", None, None, None, None,
                                        [None, None, [[None, [code]]]]]])
                raw = (")]}'\n" + str(len(envelope) + 2) + "\n" + envelope + "\n").encode()
                calls = []

                @contextlib.asynccontextmanager
                async def stream(*args, **kwargs):
                    calls.append(1)

                    async def content():
                        yield raw

                    yield SimpleNamespace(status_code=200, aiter_content=content)

                client = GeminiClient()
                transport = SimpleNamespace(stream=stream)

                async def init(**kwargs):
                    client.client, client._running = transport, True

                async def close():
                    client._running = False

                await init()
                guard = worker.ModelGuard(selected.model_id)
                # Patch lifecycle only; exercise the real request builder,
                # parser exception handling and @running(retry=5) decorator.
                with patch.object(GeminiClient, "init", side_effect=init), \
                     patch.object(GeminiClient, "close", side_effect=close), \
                     patch("gemini_webapi.utils.decorators.asyncio.sleep", new_callable=AsyncMock) as sleep:
                    with guard.transport(client), self.assertRaises(Exception) as caught:
                        async for _ in client._generate("fixture", model=selected, temporary=True):
                            self.fail("A rejected response must not produce output")
                    self.assertEqual(calls, [1])
                    sleep.assert_not_awaited()
                    self.assertIsInstance(caught.exception, worker.GoogleStreamError)
                    self.assertEqual(caught.exception.google_code, code)


if __name__ == "__main__":
    unittest.main()
