import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { setModelSpecsOverride } from "../src/compat/model-specs.js";
import { buildOpenAIModelCatalog } from "../src/compat.js";
import { webAppContextWindow } from "../src/providers/web-app/context.js";

afterEach(() => setModelSpecsOverride(null));

it("distinguishes the smaller Qwen Omni window from the million-token models", () => {
  assert.equal(webAppContextWindow("qwen-app-qwen3.5-omni-plus"), 262_144);
  assert.equal(webAppContextWindow("qwen-app-qwen3.8-omni-flash"), 1_000_000);
  assert.equal(webAppContextWindow("deepseek-app-current"), 1_000_000);
});

it("does not infer a window for auto or unrecognized future models", () => {
  assert.equal(webAppContextWindow("claude-app-auto"), null);
  assert.equal(webAppContextWindow("qwen-app-future"), null);
});

it("allows operator caps while ignoring invalid context overrides", () => {
  setModelSpecsOverride({ "deepseek-app-current": { contextWindow: 64_000 } });
  assert.equal(webAppContextWindow("deepseek-app-current"), 64_000);
  for (const contextWindow of [0, -1, Infinity, 1.5]) {
    setModelSpecsOverride({ "deepseek-app-current": { contextWindow } });
    assert.equal(webAppContextWindow("deepseek-app-current"), 1_000_000);
  }
});

it("publishes web windows through the client-facing catalog for every Argon effort", () => {
  const oldChat = process.env.LYOD_CHATGPT_APP_MODELS;
  const oldClaude = process.env.LYOD_CLAUDE_APP_MODELS;
  try {
    process.env.LYOD_CHATGPT_APP_MODELS = "gpt-6,gpt-5-6-mini";
    process.env.LYOD_CLAUDE_APP_MODELS = "sonnet-5-5,auto";
    const catalog = buildOpenAIModelCatalog({ hasActiveProvider: () => true, getConfig: () => ({}) } as never);
    for (const effort of ["low", "medium", "high"]) {
      const model = catalog.find((entry) => entry.id === `gemini-4-argon-web-${effort}`);
      assert.equal(model?.context_window, 1_000_000);
      assert.equal(model?.meta.max_prompt_bytes, 16 * 1024 * 1024);
    }
    assert.equal(catalog.find((model) => model.id === "claude-app-sonnet-5-5")?.context_window, 200_000);
    assert.equal(catalog.find((model) => model.id === "chatgpt-app-gpt-6")?.context_window, 32_768);
  } finally {
    if (oldChat === undefined) delete process.env.LYOD_CHATGPT_APP_MODELS;
    else process.env.LYOD_CHATGPT_APP_MODELS = oldChat;
    if (oldClaude === undefined) delete process.env.LYOD_CLAUDE_APP_MODELS;
    else process.env.LYOD_CLAUDE_APP_MODELS = oldClaude;
  }
});
