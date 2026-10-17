import assert from "node:assert/strict";
import { test } from "node:test";
import { workerTelemetry } from "../src/providers/gemini-web/telemetry.js";

test("worker telemetry copies only fixed metrics, enums and bounded integers", () => {
  assert.deepEqual(workerTelemetry({
    type: "diagnostic", timingsMs: { init: 12, googleRequest: 40, secret: "cookie", quota: -1, persist: 1.5 },
    attempts: 2, googleRequests: 3, sessionMs: 60, googleCode: 1100,
    errorKind: "GoogleStreamError", failedStage: "googleRequest", prompt: "private", cookies: "private",
  }), { timingsMs: { init: 12, googleRequest: 40 }, attempts: 2, googleRequests: 3, sessionMs: 60,
    googleCode: 1100, errorKind: "GoogleStreamError", failedStage: "googleRequest" });
});

test("worker telemetry drops arbitrary strings, fractional, oversized and nonfinite metrics", () => {
  assert.deepEqual(workerTelemetry({ timingsMs: { init: Infinity, generation: NaN, imageDownload: 3600001 },
    errorKind: "SecretToken", failedStage: "https://signed-url", googleCode: "1100", attempts: 101,
    sessionMs: -1, googleRequests: true }), { timingsMs: {} });
  for (const value of [null, [], "cookie"]) assert.deepEqual(workerTelemetry(value), {});
});
