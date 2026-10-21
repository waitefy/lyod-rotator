import { getModelSpecOverride } from "../../compat/model-specs.js";

// Working windows for the deployed web routes; see docs/model-context.md.
// ChatGPT/Claude caps are deliberately distinct from paid/API entitlements.
const CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "chatgpt-app-gpt-6": 32_768,
  "chatgpt-app-gpt-5-6-mini": 32_768,
  "claude-app-sonnet-5-5": 200_000,
  "qwen-app-qwen3.5-plus": 1_000_000,
  "qwen-app-qwen3.5-omni-plus": 262_144,
  "qwen-app-qwen3.6-plus": 1_000_000,
  "qwen-app-qwen3.7-plus": 1_000_000,
  "qwen-app-qwen3.7-max": 1_000_000,
  "qwen-app-qwen3.8-max": 1_000_000,
  "qwen-app-qwen3.8-omni-flash": 1_000_000,
  "deepseek-app-current": 1_000_000,
};

export function webAppContextWindow(model: string): number | null {
  const override = getModelSpecOverride(model)?.contextWindow;
  if (typeof override === "number" && Number.isSafeInteger(override) && override > 0) return override;
  return CONTEXT_WINDOWS[model] ?? null;
}
