import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AccountConfig } from "../../types.js";
import { getProviderProxyUrl, hasCredential } from "../credential-helpers.js";
import { GEMINI_WEB_PROVIDER, getCookiesFile, validateCredentials } from "./credentials.js";
import { runWebWorker } from "./forward.js";

export interface GeminiWebCheck {
  code: string;
  severity: "info" | "error";
  account?: string;
  message: string;
  action?: string;
}

export interface GeminiWebDiagnostics {
  mode: "offline" | "probe";
  accountCount: number;
  checks: GeminiWebCheck[];
}

const execute = promisify(execFile);
const workerDirectory = fileURLToPath(new URL("./", import.meta.url));
const protocolFailure = /^(Invalid Gemini Web worker response|Gemini Web worker ended without completing the response|Gemini Web thinking protocol changed; request was not sent)$/;
// No cookie files, client instances or network requests in the runtime check.
const runtimeScript = `import sys
if sys.version_info < (3, 11):
 print("python-version"); sys.exit(0)
sys.path.insert(0, sys.argv[1])
try:
 import worker, session
except Exception:
 print("worker-import-failed"); sys.exit(0)
try:
 from gemini_webapi import GeminiClient
 assert callable(GeminiClient.generate_content_stream)
except Exception:
 print("dependency-unavailable"); sys.exit(0)
print("runtime-ready")`;

export async function checkGeminiWebRuntime(
  python = process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON || "python3",
): Promise<GeminiWebCheck> {
  try {
    const { stdout } = await execute(python, ["-c", runtimeScript, workerDirectory], {
      encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 16384,
    });
    switch (stdout.trim()) {
      case "runtime-ready":
        return { code: "runtime-ready", severity: "info", message: "Python and Gemini Web imports are available." };
      case "python-version":
        return { code: "python-version", severity: "error", message: "Gemini Web requires Python 3.11 or newer.",
          action: "Set TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON to a supported interpreter." };
      case "dependency-unavailable":
        return { code: "dependency-unavailable", severity: "error", message: "The Gemini Web Python dependency is missing or incompatible.",
          action: "Install requirements-gemini-web.txt with the configured Python interpreter." };
      case "worker-import-failed":
        return { code: "worker-import-failed", severity: "error", message: "The Gemini Web worker or session module cannot be imported.",
          action: "Check that the complete Gemini Web installation is present on a supported OS." };
      default:
        return { code: "runtime-protocol-error", severity: "error", message: "Python returned an unexpected diagnostic response.",
          action: "Check the configured Python executable and reinstall the Gemini Web runtime." };
    }
  } catch {
    return { code: "python-unavailable", severity: "error", message: "The configured Python executable failed or did not finish within 5 seconds.",
      action: "Check TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON and executable permissions." };
  }
}

export interface GeminiWebProbeResult {
  status: number;
  protocolError?: boolean;
}

async function probeGeminiWebSession(account: AccountConfig): Promise<GeminiWebProbeResult> {
  const signal = AbortSignal.timeout(90000);
  try {
    const { response } = await runWebWorker({ mode: "probe", cookiesFile: getCookiesFile(account),
      proxy: getProviderProxyUrl(account, GEMINI_WEB_PROVIDER) }, signal);
    // Consume the response: ready alone does not prove that the worker completed.
    const text = await response.text();
    let protocolError = false;
    if (response.status === 502) {
      try {
        const message: unknown = JSON.parse(text)?.error?.message;
        protocolError = typeof message === "string" && protocolFailure.test(message);
      } catch { /* Unrecognised upstream bodies are never included in reports. */ }
    }
    return { status: response.status, protocolError };
  } catch (error) {
    return { status: signal.aborted ? 504 : 502,
      protocolError: error instanceof Error && protocolFailure.test(error.message) };
  }
}

function probeCheck(result: GeminiWebProbeResult): GeminiWebCheck {
  const severity = "error";
  switch (result.status) {
    case 200: return { code: "connected", severity: "info", message: "The web session is authenticated and offers Argon. Generation was not tested." };
    case 401: return { code: "auth-required", severity, message: "The web session expired or was rejected.", action: "Reconnect this account using rotator-gemini-login or login --provider gemini-web." };
    case 403: return { code: "blocked", severity, message: "Gemini Web temporarily blocked this session.", action: "Wait and check access in Gemini App before retrying." };
    case 404: return { code: "argon-unavailable", severity, message: "This session does not offer the selected Argon model; no fallback was used.", action: "Check Argon access in Gemini App for this account." };
    case 409: return { code: "session-busy", severity, message: "The account remained busy while waiting for its session lock.", action: "Let the active request finish, then run the check again." };
    case 429: return { code: "rate-limited", severity, message: "The Gemini Web usage limit was reached.", action: "Wait for the account limit to reset." };
    case 504: return { code: "timeout", severity, message: "The session check timed out.", action: "Check connectivity and account activity, then retry." };
    case 503: return { code: "service-unavailable", severity, message: "The Gemini Web worker or dependency is unavailable.", action: "Check the local runtime findings and the session service." };
    default: return result.protocolError
      ? { code: "protocol-error", severity, message: "The Gemini Web worker or web protocol returned an invalid response.", action: "Check the pinned client and worker compatibility before retrying." }
      : { code: "upstream-error", severity, message: "The session check failed without a recognised authentication or protocol error.", action: "Check connectivity and access in Gemini App; retry before reconnecting." };
  }
}

export async function diagnoseGeminiWeb(
  accounts: AccountConfig[],
  options: {
    probe?: boolean;
    runtimeCheck?: () => Promise<GeminiWebCheck>;
    probeSession?: (account: AccountConfig) => Promise<GeminiWebProbeResult>;
  } = {},
): Promise<GeminiWebDiagnostics> {
  const configured = accounts.filter((account) => hasCredential(account, GEMINI_WEB_PROVIDER));
  const result: GeminiWebDiagnostics = { mode: options.probe ? "probe" : "offline", accountCount: configured.length, checks: [] };
  if (!configured.length) return result;
  const runtime = await (options.runtimeCheck ?? checkGeminiWebRuntime)();
  result.checks.push(runtime);
  // Sequential probes respect the one-request-per-session constraint.
  for (const account of configured) {
    const valid = await validateCredentials(account);
    if (!valid.ok) {
      result.checks.push({ account: account.email, code: "session-file-invalid", severity: "error",
        message: "The cookie file is missing, unreadable or invalid.", action: "Reconnect this account or correct its absolute cookiesFile path." });
    } else if (!options.probe) {
      result.checks.push({ account: account.email, code: "session-file-ready", severity: "info",
        message: "The cookie file is readable and has the expected format. Authentication and Argon access were not checked.",
        action: "Run doctor --gemini-web-probe to check access without generating a response." });
    } else if (runtime.severity !== "error") {
      const check = probeCheck(await (options.probeSession ?? probeGeminiWebSession)(account));
      result.checks.push({ ...check, account: account.email });
    }
  }
  return result;
}
