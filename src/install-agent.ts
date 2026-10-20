import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENCODE_PLUGIN_SOURCE_PATH = resolve(__dirname, "../plugins/opencode-discovery.js");

export type SupportedAgent = "opencode" | "hermes" | "pi" | "codex";

export interface AgentInstallOptions {
  targets?: Array<SupportedAgent | "auto" | "all">;
  host?: string;
  user?: string;
  port?: number;
  sshKey?: string;
  rotatorUrl?: string;
  providerId?: string;
  providerName?: string;
  apiKey?: string;
  dryRun?: boolean;
}

/**
 * Builds the composite shell script that detects and configures all requested agents.
 */
export function buildCompositeInstallerScript(
  opencodePluginContent: string,
  options: {
    targets: Array<SupportedAgent | "auto" | "all">;
    rotatorUrl: string;
    providerId: string;
    providerName: string;
    apiKey?: string;
  }
): string {
  const pluginBase64 = Buffer.from(opencodePluginContent, "utf8").toString("base64");
  const rotatorUrl = options.rotatorUrl.replace(/\/+$/, "");
  const providerId = options.providerId || "tuxevil-rotator";
  const providerName = options.providerName || "Lyod Rotator";
  const apiKey = options.apiKey || "no-key";
  const targets = options.targets && options.targets.length > 0 ? options.targets : ["auto"];
  const shouldAuto = targets.includes("auto") || targets.includes("all");

  return `#!/usr/bin/env bash
set -e

ROTATOR_URL="${rotatorUrl}"
PROVIDER_ID="${providerId}"
PROVIDER_NAME="${providerName}"
API_KEY="${apiKey}"

echo "=========================================================="
echo "==> Lyod Rotator Agent Installer"
echo "==> Rotator URL:   $ROTATOR_URL"
echo "==> Provider ID:   $PROVIDER_ID"
echo "=========================================================="

# Helper to check if agent should be installed
should_install() {
  local agent="$1"
  local check_dir="$2"
  if [ "${targets.includes("all") ? "1" : "0"}" = "1" ]; then
    return 0
  fi
  if [ "${shouldAuto ? "1" : "0"}" = "1" ]; then
    if [ -d "$check_dir" ]; then
      return 0
    else
      return 1
    fi
  fi
  case ",${targets.join(",")}," in
    *,$agent,*) return 0 ;;
    *) return 1 ;;
  esac
}

# -------------------------------------------------------------
# 1. OpenCode Configuration
# -------------------------------------------------------------
OPENCODE_DIR="$HOME/.config/opencode"
if should_install "opencode" "$OPENCODE_DIR"; then
  echo ""
  echo "==> [OpenCode] Configuring in $OPENCODE_DIR..."
  mkdir -p "$OPENCODE_DIR/plugins"
  echo "${pluginBase64}" | base64 -d > "$OPENCODE_DIR/plugins/opencode-discovery.js"

  node -e '
  const fs = require("fs");
  const path = require("path");

  const configFile = path.join(process.env.HOME, ".config/opencode/opencode.json");
  const pluginPath = path.join(process.env.HOME, ".config/opencode/plugins/opencode-discovery.js");
  const providerID = process.argv[1];
  const providerName = process.argv[2];
  const baseURL = process.argv[3];
  const apiKey = process.argv[4];

  let config = {};
  if (fs.existsSync(configFile)) {
    try {
      config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    } catch (e) {
      console.warn("Warning: Backing up invalid opencode.json");
      fs.copyFileSync(configFile, configFile + ".bak." + Date.now());
      config = {};
    }
  }

  config.$schema = config.$schema || "https://opencode.ai/config.json";
  config.plugin = Array.isArray(config.plugin) ? config.plugin : [];

  // Remove existing discovery plugin
  config.plugin = config.plugin.filter(p => {
    if (typeof p === "string") return !p.includes("opencode-discovery.js");
    if (Array.isArray(p)) return !p[0].includes("opencode-discovery.js");
    return true;
  });

  config.plugin.push([
    pluginPath,
    { baseURL, providerID, providerName }
  ]);

  config.provider = config.provider || {};
  config.provider[providerID] = config.provider[providerID] || {
    npm: "@ai-sdk/openai-compatible",
    name: providerName,
    options: { baseURL }
  };
  config.provider[providerID].npm = "@ai-sdk/openai-compatible";
  config.provider[providerID].name = providerName;
  config.provider[providerID].options = config.provider[providerID].options || {};
  config.provider[providerID].options.baseURL = baseURL;

  if (apiKey && apiKey !== "no-key") {
    config.provider[providerID].options.apiKey = apiKey;
  }

  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\\n", "utf8");
  console.log("==> [OpenCode] Configured successfully.");
  ' "$PROVIDER_ID" "$PROVIDER_NAME" "$ROTATOR_URL" "$API_KEY"
else
  echo "==> [OpenCode] Skipped (not selected or directory not found)."
fi

# -------------------------------------------------------------
# 2. Hermes Configuration
# -------------------------------------------------------------
HERMES_DIR="$HOME/.hermes"
if should_install "hermes" "$HERMES_DIR"; then
  echo ""
  echo "==> [Hermes] Configuring in $HERMES_DIR..."
  mkdir -p "$HERMES_DIR"

  python3 -c '
import os, sys

config_file = os.path.expanduser("~/.hermes/config.yaml")
provider_id = sys.argv[1]
rotator_url = sys.argv[2]
api_key = sys.argv[3]

try:
    import yaml
    has_yaml = True
except ImportError:
    has_yaml = False

if has_yaml:
    data = {}
    if os.path.exists(config_file):
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
        except Exception as e:
            print(f"Warning: could not parse {config_file}, preserving existing content")
            data = {}

    custom_providers = data.get("custom_providers", [])
    if not isinstance(custom_providers, list):
        custom_providers = []

    updated = False
    for p in custom_providers:
        if isinstance(p, dict) and p.get("name") in (provider_id, "tuxevil-rotator", "antigravity"):
            p["name"] = provider_id
            p["base_url"] = rotator_url
            p["api_key"] = api_key
            p["discover_models"] = True
            updated = True
            break

    if not updated:
        custom_providers.append({
            "name": provider_id,
            "base_url": rotator_url,
            "api_key": api_key,
            "discover_models": True
        })

    data["custom_providers"] = custom_providers
    with open(config_file, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, sort_keys=False)
    print("==> [Hermes] Updated custom_providers with discover_models=True via PyYAML.")
else:
    # Minimal fallback block update if yaml library is not present
    entry = f"""
custom_providers:
  - name: {provider_id}
    base_url: {rotator_url}
    api_key: {api_key}
    discover_models: true
"""
    if os.path.exists(config_file):
        with open(config_file, "r", encoding="utf-8") as f:
            content = f.read()
        if "discover_models" not in content and provider_id not in content:
            with open(config_file, "a", encoding="utf-8") as f:
                f.write(entry)
            print("==> [Hermes] Appended custom_providers entry.")
        else:
            print("==> [Hermes] Entry already present in config.yaml.")
    else:
        with open(config_file, "w", encoding="utf-8") as f:
            f.write(entry)
        print("==> [Hermes] Created config.yaml with custom_providers.")
' "$PROVIDER_ID" "$ROTATOR_URL" "$API_KEY"
else
  echo "==> [Hermes] Skipped (not selected or directory not found)."
fi

# -------------------------------------------------------------
# 3. Pi Agent Configuration
# -------------------------------------------------------------
PI_DIR="$HOME/.pi/agent"
if should_install "pi" "$PI_DIR"; then
  echo ""
  echo "==> [Pi Agent] Configuring in $PI_DIR..."
  mkdir -p "$PI_DIR"

  node -e '
  const fs = require("fs");
  const path = require("path");
  const http = require("http");
  const https = require("https");

  const modelsFile = path.join(process.env.HOME, ".pi/agent/models.json");
  const providerID = process.argv[1];
  const baseURL = process.argv[2];
  const apiKey = process.argv[3];

  async function fetchModels(url) {
    return new Promise((resolve) => {
      try {
        const parsed = new URL(url.replace(/\\/+$/, "") + "/models");
        const client = parsed.protocol === "https:" ? https : http;
        const req = client.get(parsed, { timeout: 3000 }, (res) => {
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              resolve(Array.isArray(json?.data) ? json.data : []);
            } catch {
              resolve([]);
            }
          });
        });
        req.on("error", () => resolve([]));
        req.on("timeout", () => { req.destroy(); resolve([]); });
      } catch {
        resolve([]);
      }
    });
  }

  async function main() {
    let modelsData = { providers: {} };
    if (fs.existsSync(modelsFile)) {
      try {
        modelsData = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
      } catch (e) {
        console.warn("Warning: Backing up corrupted models.json");
        fs.copyFileSync(modelsFile, modelsFile + ".bak." + Date.now());
        modelsData = { providers: {} };
      }
    }
    modelsData.providers = modelsData.providers || {};

    const rawModels = await fetchModels(baseURL);
    let mappedModels = [];

    if (rawModels.length > 0) {
      mappedModels = rawModels.map(m => ({
        id: m.id,
        name: m.name || m.id,
        reasoning: m.meta?.thinking ?? m.meta?.reasoning ?? false,
        input: m.meta?.multimodal ? ["text", "image"] : ["text"],
        contextWindow: m.meta?.context_length || m.context_window || 128000,
        maxTokens: m.meta?.max_output_tokens || 8192
      }));
      console.log("==> [Pi Agent] Discovered " + mappedModels.length + " live models from rotator.");
    } else {
      // Fallback baseline if rotator is not immediately reachable
      mappedModels = [
        { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High", input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536, reasoning: true },
        { id: "gemini-3-flash", name: "Gemini 3 Flash", input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536, reasoning: true },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", input: ["text", "image"], contextWindow: 1000000, maxTokens: 64000 }
      ];
      console.log("==> [Pi Agent] Rotator unreachable during install; populated standard baseline models.");
    }

    modelsData.providers[providerID] = {
      baseUrl: baseURL,
      api: "openai-completions",
      apiKey: apiKey,
      models: mappedModels
    };

    fs.writeFileSync(modelsFile, JSON.stringify(modelsData, null, 2) + "\\n", "utf8");
    console.log("==> [Pi Agent] Configured successfully in " + modelsFile);
  }

  main();
  ' "$PROVIDER_ID" "$ROTATOR_URL" "$API_KEY"
else
  echo "==> [Pi Agent] Skipped (not selected or directory not found)."
fi

# -------------------------------------------------------------
# 4. Codex CLI Configuration
# -------------------------------------------------------------
CODEX_DIR="$HOME/.codex"
if should_install "codex" "$CODEX_DIR"; then
  echo ""
  echo "==> [Codex CLI] Configuring in $CODEX_DIR..."
  mkdir -p "$CODEX_DIR"

  python3 -c '
import os, sys, re

config_file = os.path.expanduser("~/.codex/config.toml")
provider_id = sys.argv[1]
provider_name = sys.argv[2]
rotator_url = sys.argv[3]

content = ""
if os.path.exists(config_file):
    with open(config_file, "r", encoding="utf-8") as f:
        content = f.read()

section_header = f"[model_providers.{provider_id}]"
block = f"""
[model_providers.{provider_id}]
name = "{provider_name}"
base_url = "{rotator_url}"
wire_api = "responses"
"""

if section_header in content:
    pattern = rf"\\[model_providers\\.{re.escape(provider_id)}\\][^\\[]*"
    content = re.sub(pattern, block.strip() + "\\n\\n", content, flags=re.DOTALL)
    print(f"==> [Codex CLI] Updated existing {section_header} in config.toml.")
else:
    content = content.rstrip() + "\\n" + block
    print(f"==> [Codex CLI] Added {section_header} to config.toml.")

with open(config_file, "w", encoding="utf-8") as f:
    f.write(content)
' "$PROVIDER_ID" "$PROVIDER_NAME" "$ROTATOR_URL"
else
  echo "==> [Codex CLI] Skipped (not selected or directory not found)."
fi

echo ""
echo "==> All target agents processed successfully!"
`;
}

/**
 * Installs configuration for one or more agents locally or over SSH.
 */
export async function installAgents(options: AgentInstallOptions): Promise<void> {
  if (!existsSync(OPENCODE_PLUGIN_SOURCE_PATH)) {
    throw new Error(`OpenCode plugin file not found at ${OPENCODE_PLUGIN_SOURCE_PATH}`);
  }

  const opencodePluginContent = readFileSync(OPENCODE_PLUGIN_SOURCE_PATH, "utf8");
  const rotatorUrl = (
    options.rotatorUrl ||
    process.env.TUXEVIL_ROTATOR_BASE_URL ||
    process.env.ROTATOR_URL ||
    "http://127.0.0.1:51200/v1"
  ).replace(/\/+$/, "");

  const providerId = options.providerId || "tuxevil-rotator";
  const providerName = options.providerName || "Lyod Rotator";
  const targets: Array<SupportedAgent | "auto" | "all"> = options.targets && options.targets.length > 0 ? options.targets : ["auto"];

  const script = buildCompositeInstallerScript(opencodePluginContent, {
    targets,
    rotatorUrl,
    providerId,
    providerName,
    apiKey: options.apiKey,
  });

  if (options.dryRun) {
    console.log("=== Dry Run Mode: Composite Script that would be executed ===");
    console.log(script);
    return;
  }

  // Local installation
  if (!options.host || options.host === "localhost" || options.host === "127.0.0.1") {
    console.log(`==> Installing agent configuration locally for rotator: ${rotatorUrl}...`);
    execSync("bash -s", {
      input: script,
      stdio: ["pipe", "inherit", "inherit"],
    });
    return;
  }

  // Remote installation via SSH
  const sshTarget = options.user ? `${options.user}@${options.host}` : options.host;
  const sshArgs: string[] = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
  ];

  if (options.port) {
    sshArgs.push("-p", String(options.port));
  }
  if (options.sshKey) {
    sshArgs.push("-i", options.sshKey);
  }

  const sshCmd = `ssh ${sshArgs.join(" ")} ${sshTarget} "bash -s"`;

  console.log(`==> Installing agent configuration remotely on ${sshTarget} (Rotator: ${rotatorUrl})...`);
  try {
    execSync(sshCmd, {
      input: script,
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`SSH installation failed on ${sshTarget}: ${errorMsg}`, { cause: err });
  }
}
