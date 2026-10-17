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

test("worker telemetry accepts bounded Google milestones and drops malformed values", () => {
  assert.deepEqual(workerTelemetry({ timingsMs: {
    googleHeaders: 125, googleFirstChunk: 375, googleStreamEnd: 1250,
  } }), { timingsMs: { googleHeaders: 125, googleFirstChunk: 375, googleStreamEnd: 1250 } });
  for (const invalid of ["private-header", true, -1, 1.5, Infinity, NaN, 3600001]) {
    assert.deepEqual(workerTelemetry({ timingsMs: {
      googleHeaders: invalid, googleFirstChunk: invalid, googleStreamEnd: invalid,
    } }), { timingsMs: {} });
  }
});

test("worker telemetry preserves content milestones and verification duration without accepting private fields", () => {
  const timings = { firstText: 600, responseStreamEnd: 1200, modelVerification: 50, modelVerified: 1250, firstOutput: 1250 };
  assert.deepEqual(workerTelemetry({ timingsMs: { ...timings, prompt: "private", cookies: "private" } }), { timingsMs: timings });
  for (const invalid of ["private", true, -1, 1.5, Infinity, NaN, 3600001]) {
    assert.deepEqual(workerTelemetry({ timingsMs: Object.fromEntries(Object.keys(timings).map(key => [key, invalid])) }), { timingsMs: {} });
  }
});
