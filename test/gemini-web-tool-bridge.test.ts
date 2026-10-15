import assert from "node:assert/strict";
import { it } from "node:test";
import { createToolBridge } from "../src/providers/gemini-web/tool-bridge.js";

it("enforces enum restrictions on nullable tool arguments", () => {
  for (const nullableType of [{ type: ["string", "null"] }, { type: "string", nullable: true }]) {
    for (const allowNull of [false, true]) {
      const bridge = createToolBridge([{
        name: "grep",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            mode: { ...nullableType, enum: allowNull ? ["literal", null] : ["literal"] },
          },
          required: ["pattern", "mode"],
        },
      }]);
      const marker = bridge.instruction.match(/ROTATOR_TOOL_[a-f0-9-]+/)![0];
      const parse = (mode: string | null) => bridge.parse(marker + JSON.stringify({
        name: "grep", arguments: { pattern: "needle", mode },
      }));
      assert.doesNotThrow(() => parse("literal"));
      assert.throws(() => parse("unknown"), /Invalid tool arguments/);
      if (allowNull) {
        assert.doesNotThrow(() => parse(null));
      } else {
        assert.throws(() => parse(null), /Invalid tool arguments/);
      }
    }
  }
});
