import type { AccountRuntime } from "../../types.js";
import { getSessionFile as chatSessionFile, readBridgeSessionSync as readChatSession, upstreamModel as chatModel } from "../chatgpt-app/credentials.js";
import { getSessionFile as claudeSessionFile, modelAvailabilityError, readBridgeSessionSync as readClaudeSession, upstreamModel as claudeModel } from "../claude-app/credentials.js";

export const APP_ROUTE_PROVIDERS: Record<string, true> = {
  "chatgpt-app": true, "claude-app": true, "qwen-app": true, "deepseek-app": true,
};

/** Extra concrete-model checks for adapters whose routing state uses a shared pool.
 * Qwen/DeepSeek use their adapter's existing canServeModel predicate instead.
 * This is local evidence, not a bridge connectivity/entitlement probe.
 */
export function appRouteAvailabilityError(account: AccountRuntime, providerId: string, modelId: string): string | null {
  try {
    if (providerId === "chatgpt-app") {
      chatModel(modelId);
      const session = readChatSession(chatSessionFile(account.config));
      return session.email.toLowerCase() === account.config.email.toLowerCase() ? null : "bridge identity does not match account";
    }
    if (providerId === "claude-app") {
      const model = claudeModel(modelId);
      const session = readClaudeSession(claudeSessionFile(account.config));
      if (session.email.toLowerCase() !== account.config.email.toLowerCase()) return "bridge identity does not match account";
      const error = modelAvailabilityError(session, model);
      if (error) return error;
      if (["claude-sonnet-5-5", "claude-haiku-5-5"].includes(model) &&
        !session.availableModels?.find((entry) => entry.id === model)?.efforts.includes("medium"))
        return "default model effort is unavailable for this account";
    }
    return null;
  } catch { return "local bridge session is missing or invalid"; }
}
