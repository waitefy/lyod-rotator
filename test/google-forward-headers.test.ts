import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import { forwardRequest } from "../src/providers/google-antigravity/forward.js";
import { closeProxyDispatchers } from "../src/providers/proxy-dispatcher.js";
import type { AccountRuntime } from "../src/types.js";
import type { RequestBody } from "../src/proxy.js";

const nativeFetch = globalThis.fetch;
const account = {
  config: { email: "test@example.com", credentials: [{ provider: "google-antigravity", projectId: "test", refreshToken: "test" }] },
  accessToken: "test",
} as AccountRuntime;
const body = (): RequestBody => ({ model: "gemini-3.8-flash-high", project: "", request: { contents: [] } });

afterEach(async () => {
  globalThis.fetch = nativeFetch;
  mock.timers.reset();
  await closeProxyDispatchers();
});

it("accepts delayed generation headers after the old two-minute deadline", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal;
  let resolveFetch!: (response: Response) => void;
  globalThis.fetch = async (_input, init) => {
    signal = init!.signal!;
    return new Promise<Response>(resolve => { resolveFetch = resolve; });
  };
  const pending = forwardRequest(account, body(), {});
  mock.timers.tick(138_500);
  assert.equal(signal!.aborted, false);
  resolveFetch(new Response("ok"));
  assert.equal((await pending).response.status, 200);
});

it("still aborts an unresponsive generation at ten minutes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const rejected = assert.rejects(forwardRequest(account, body(), {}), /headers timeout after 600000ms/);
  mock.timers.tick(600_000);
  await rejected;
});

it("preserves client cancellation while waiting for generation headers", async () => {
  const controller = new AbortController();
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const rejected = assert.rejects(forwardRequest(account, body(), {}, controller.signal), { name: "AbortError" });
  controller.abort();
  await rejected;
});
