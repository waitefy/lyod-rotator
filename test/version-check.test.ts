import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getUpdateInfo,
  performSelfUpdate,
  startVersionChecker,
  stopVersionChecker,
} from "../src/version-check.js";

describe("fork update safety", () => {
  it("rejects npm self-update without changing the fork version", () => {
    // A regression must never execute the real npm installer during this test.
    const dir = mkdtempSync(join(tmpdir(), "lyod-update-test-"));
    const originalPath = process.env.PATH;
    writeFileSync(join(dir, "npm"), '#!/bin/sh\nprintf invoked > "$0.invoked"\nexit 99\n', { mode: 0o755 });
    process.env.PATH = dir;
    try {
      const current = getUpdateInfo().currentVersion;
      const result = performSelfUpdate();
      assert.equal(result.ok, false);
      assert.equal(result.from, current);
      assert.equal(result.to, current);
      assert.match(result.message, /npm self-update is disabled/);
      assert.equal(existsSync(join(dir, "npm.invoked")), false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not poll npm for upstream releases", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const fetchMock = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("Fork update checks must not contact npm");
    });
    try {
      startVersionChecker();
      t.mock.timers.tick(31 * 60 * 1000);
      await Promise.resolve();
      assert.equal(fetchMock.mock.callCount(), 0);
      assert.equal(getUpdateInfo().updateAvailable, false);
    } finally {
      stopVersionChecker();
    }
  });
});
