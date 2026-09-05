#!/usr/bin/env node
// configure-local-claw.mjs — writes the host ("trusted") claw gateway config.
//
// Policy intent: the agent is trusted (host install, full reach); the
// untrusted-content guard plugin is the load-bearing control and must fail
// closed. So: no allow/deny lists, no workspaceOnly, but the guard plugin is
// pinned to onError=quarantine over the loopback-only guard VM forward.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "../../lib/record-shared.mjs";

const configPath =
  process.env.LOCALCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json");
const guardBaseUrl = process.env.LOCALCLAW_GUARD_BASE_URL || "http://127.0.0.1:18787";
const workspace = process.env.LOCALCLAW_WORKSPACE;
const agentName = process.env.LOCALCLAW_AGENT_NAME || "Local Claw";
if (!workspace) {
  console.error("[configure-local-claw] LOCALCLAW_WORKSPACE is required");
  process.exit(1);
}

const modelBaseUrl = process.env.LOCALCLAW_MODEL_BASE_URL || "";
const modelId = process.env.LOCALCLAW_MODEL_ID || "";
const modelApiKeyEnv = process.env.LOCALCLAW_MODEL_API_KEY_ENV || "";
const envNameOk = (v) => /^[A-Z][A-Z0-9_]{0,127}$/.test(v);

function ensureRecord(parent, key) {
  if (!isRecord(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}
function mergeList(existing, additions) {
  const list = Array.isArray(existing) ? existing.filter((e) => typeof e === "string") : [];
  for (const entry of additions) {
    if (entry && !list.includes(entry)) {
      list.push(entry);
    }
  }
  return list;
}
function upsertAgent(agents, id) {
  const list = Array.isArray(agents.list) ? agents.list : [];
  agents.list = list;
  const found = list.find((entry) => isRecord(entry) && entry.id === id);
  if (found) {
    return found;
  }
  const created = { id };
  list.push(created);
  return created;
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  cfg = {};
}
if (!isRecord(cfg)) {
  cfg = {};
}

// --- untrusted-content guard plugin: the load-bearing control -------------
const plugins = ensureRecord(cfg, "plugins");
const pluginEntries = ensureRecord(plugins, "entries");
const untrustedContent = ensureRecord(pluginEntries, "untrusted-content");
untrustedContent.enabled = true;
const guardConfig = ensureRecord(untrustedContent, "config");
guardConfig.enabled = true;
guardConfig.baseUrl = guardBaseUrl;
// Fail closed: guard VM down or pipeline error => quarantine, never pass.
guardConfig.onError = "quarantine";
guardConfig.timeoutSeconds = 60;
// Wildcards keep future projected tools guarded without config edits.
guardConfig.toolNames = mergeList(guardConfig.toolNames, [
  "web_fetch",
  "web_search",
  "browser",
  "locksmith_*",
]);
// No apiKey: the service has no inbound auth; the host forward is
// loopback-only and the guest binds loopback. Plain HTTP on 127.0.0.1.
delete guardConfig.apiKey;
delete guardConfig.tlsRejectUnauthorized;

// --- model provider (optional, OpenAI-compatible, never local Kamiwaza) ---
if (modelBaseUrl && modelId) {
  const providerId = "localclaw-model";
  const modelRef = `${providerId}/${modelId}`;
  const modelLeaf = modelId.split("/").findLast(Boolean) || modelId;
  const contextWindow = Number.parseInt(process.env.LOCALCLAW_MODEL_CONTEXT_WINDOW || "", 10);
  const maxTokens = Number.parseInt(process.env.LOCALCLAW_MODEL_MAX_TOKENS || "", 10);
  const apiKey = envNameOk(modelApiKeyEnv)
    ? { source: "env", provider: "default", id: modelApiKeyEnv }
    : "localclaw-no-key";

  if (envNameOk(modelApiKeyEnv)) {
    const secrets = ensureRecord(cfg, "secrets");
    const secretProviders = ensureRecord(secrets, "providers");
    const defaultSecretProvider = ensureRecord(secretProviders, "default");
    defaultSecretProvider.source = "env";
    defaultSecretProvider.allowlist = mergeList(defaultSecretProvider.allowlist, [modelApiKeyEnv]);
  }

  const models = ensureRecord(cfg, "models");
  models.mode = "merge";
  const providers = ensureRecord(models, "providers");
  providers[providerId] = {
    baseUrl: modelBaseUrl,
    apiKey,
    api: "openai-completions",
    models: [
      {
        id: modelId,
        name: process.env.LOCALCLAW_MODEL_NAME || `LocalClaw ${modelLeaf}`,
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000,
        maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 8192,
        agentRuntime: { id: "pi" },
      },
    ],
  };

  const agentsDefaults = ensureRecord(ensureRecord(cfg, "agents"), "defaults");
  const defaultsModels = ensureRecord(agentsDefaults, "models");
  defaultsModels[modelRef] = { agentRuntime: { id: "pi" } };
  const existingModel = isRecord(agentsDefaults.model)
    ? agentsDefaults.model
    : typeof agentsDefaults.model === "string"
      ? { primary: agentsDefaults.model }
      : {};
  agentsDefaults.model = { ...existingModel, primary: modelRef };
}

// --- agent identity + workspace (permissive by design) --------------------
const agents = ensureRecord(cfg, "agents");
const defaults = ensureRecord(agents, "defaults");
defaults.workspace = workspace;
const main = upsertAgent(agents, "main");
if (main.default === undefined) {
  main.default = true;
}
main.name = agentName;
main.workspace = workspace;
// Intentionally NO tools.allow/deny, NO fs.workspaceOnly, NO exec lockdown:
// this claw's purview is the host. The guard plugin above is the boundary.

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
console.log(`[configure-local-claw] wrote ${configPath}`);
