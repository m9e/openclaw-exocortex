import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/dev/lima/bootstrap-kamiwaza-mode.sh";
const SECRET = "serper-secret-value-for-test";

function makeExtensionRepo(root: string, repoName: string, type: "tool", name: string) {
  const repo = join(root, repoName);
  const target = join(repo, `${type}s`, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(repo, "Makefile"), "list:\n\t@true\n");
  writeFileSync(join(target, "kamiwaza.json"), JSON.stringify({ name }, null, 2));
  return repo;
}

function makeHelper(root: string) {
  const helper = join(root, "amatt-push-local-extensions.sh");
  writeFileSync(
    helper,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf 'helper workspace=%s\\n' \"$2\"",
      "printf 'helper args=%s\\n' \"$*\"",
      'find -L "$2" -maxdepth 1 -mindepth 1 -type d -print | sort',
      "",
    ].join("\n"),
  );
  chmodSync(helper, 0o755);
  return helper;
}

function runScript(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runScriptWithXtrace(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["-x", SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("bootstrap-kamiwaza-mode.sh", () => {
  it("dry-runs the configured target repos through a temporary selected workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-kamiwaza-mode-"));
    try {
      const serperRepo = makeExtensionRepo(
        root,
        "kamiwaza-extensions-serperdev",
        "tool",
        "tool-serperdev",
      );
      const untrustedRepo = makeExtensionRepo(
        root,
        "kamiwaza-extensions-tool-untrusted",
        "tool",
        "tool-untrusted-content",
      );
      const skippedRepo = makeExtensionRepo(
        root,
        "kamiwaza-extensions-skipped",
        "tool",
        "tool-skipped",
      );
      const helper = makeHelper(root);

      const result = runScript(["--dry-run", "--no-bootstrap"], {
        OPENCLAW_KAMIWAZA_EXTENSION_HELPER: helper,
        OPENCLAW_KAMIWAZA_EXTENSION_TARGETS: `${serperRepo}:tool:tool-serperdev,${untrustedRepo}:tool:tool-untrusted-content`,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("deploying selected Kamiwaza extension repos");
      expect(result.stdout).toContain("kamiwaza-extensions-serperdev");
      expect(result.stdout).toContain("kamiwaza-extensions-tool-untrusted");
      expect(result.stdout).not.toContain(skippedRepo);
      expect(result.stdout).toContain("IMAGE_PREFIX=kamiwazaai");
      expect(result.stdout).toContain("--dry-run");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("loads local api key names without printing secret values", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-kamiwaza-mode-keys-"));
    try {
      const repo = makeExtensionRepo(
        root,
        "kamiwaza-extensions-serperdev",
        "tool",
        "tool-serperdev",
      );
      const helper = makeHelper(root);
      const apiKeys = join(root, "api_keys");
      writeFileSync(apiKeys, `export SERPER_API_KEY=${SECRET}\n`);

      const result = runScript(["--dry-run", "--no-bootstrap"], {
        OPENCLAW_API_KEYS_FILE: apiKeys,
        OPENCLAW_KAMIWAZA_EXTENSION_HELPER: helper,
        OPENCLAW_KAMIWAZA_EXTENSION_TARGETS: `${repo}:tool:tool-serperdev`,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SERPER_API_KEY present");
      expect(result.stdout).toContain("SERPERDEV_API_KEY derived from SERPER_API_KEY");
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stderr).not.toContain(SECRET);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not leak loaded secrets when the script is run with bash xtrace", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-kamiwaza-mode-xtrace-"));
    try {
      const repo = makeExtensionRepo(
        root,
        "kamiwaza-extensions-serperdev",
        "tool",
        "tool-serperdev",
      );
      const helper = makeHelper(root);
      const apiKeys = join(root, "api_keys");
      writeFileSync(apiKeys, `export SERPER_API_KEY=${SECRET}\n`);

      const result = runScriptWithXtrace(["--dry-run", "--no-bootstrap"], {
        OPENCLAW_API_KEYS_FILE: apiKeys,
        OPENCLAW_KAMIWAZA_EXTENSION_HELPER: helper,
        OPENCLAW_KAMIWAZA_EXTENSION_TARGETS: `${repo}:tool:tool-serperdev`,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stderr).not.toContain(SECRET);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("resolves the Kamiwaza password from a login helper without printing it", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-kamiwaza-mode-password-"));
    try {
      const repo = makeExtensionRepo(
        root,
        "kamiwaza-extensions-serperdev",
        "tool",
        "tool-serperdev",
      );
      const helper = makeHelper(root);
      const login = join(root, "kz-login");
      writeFileSync(
        login,
        ["#!/usr/bin/env bash", "set -euo pipefail", `printf '%s\\n' '${SECRET}'`, ""].join("\n"),
      );
      chmodSync(login, 0o755);

      const result = runScript(["--dry-run", "--no-bootstrap"], {
        OPENCLAW_KAMIWAZA_EXTENSION_HELPER: helper,
        OPENCLAW_KAMIWAZA_EXTENSION_TARGETS: `${repo}:tool:tool-serperdev`,
        OPENCLAW_KAMIWAZA_LOGIN_SCRIPT: login,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("KAMIWAZA_PASSWORD resolved");
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stderr).not.toContain(SECRET);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("plans the durable gateway-only workspace mount without changing the untrusted VM", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-kamiwaza-mode-state-"));
    try {
      const state = join(root, "agent-state");
      mkdirSync(state, { recursive: true });
      const helper = makeHelper(root);

      const result = runScript(["--dry-run", "--no-extensions"], {
        OPENCLAW_AGENT_STATE_HOST_DIR: state,
        OPENCLAW_KAMIWAZA_EXTENSION_HELPER: helper,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("agent state host dir");
      expect(result.stdout).toContain(state);
      expect(result.stdout).toContain("OPENCLAW_MAIN_AGENT_WORKSPACE");
      expect(result.stdout).toContain("gateway-only writable Lima mount");
      expect(result.stdout).not.toContain("untrusted writable mount");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("documents Kimi endpoint defaults in dry-run output", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-kamiwaza-mode-kimi-"));
    try {
      const helper = makeHelper(root);

      const result = runScript(["--dry-run", "--no-extensions"], {
        OPENCLAW_KAMIWAZA_EXTENSION_HELPER: helper,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Kimi endpoint note");
      expect(result.stdout).toContain("OPENCLAW_KAMIWAZA_BASE_URL");
      expect(result.stdout).toContain("OPENCLAW_KAMIWAZA_MODEL_ID");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("redacts the configured Kamiwaza model API key in dry-run output", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-kamiwaza-mode-model-key-"));
    try {
      const helper = makeHelper(root);

      const result = runScript(["--dry-run", "--no-extensions"], {
        OPENCLAW_KAMIWAZA_BASE_URL: "https://tokenator.kamiwaza.ai/runtime/models/example/v1",
        OPENCLAW_KAMIWAZA_EXTENSION_HELPER: helper,
        OPENCLAW_KAMIWAZA_MODEL_API_KEY: SECRET,
        OPENCLAW_KAMIWAZA_MODEL_ID: "Kimi-K2.6",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("OPENCLAW_KAMIWAZA_MODEL_API_KEY present");
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stderr).not.toContain(SECRET);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
