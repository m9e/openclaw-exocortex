import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/dev/lima/turnkey-kamiwaza-openclaw.sh";
const PAT_SECRET = "pat-secret-value-for-test";
const PASSWORD_SECRET = "password-secret-value-for-test";
const ACCESS_TOKEN_SECRET = "access-token-secret-value-for-test";

const DEPLOYMENTS = JSON.stringify([
  {
    m_name: "Kimi-K2.6",
    status: "DEPLOYED",
    access_path: "/runtime/models/aaaa-bbbb",
  },
  {
    m_name: "Qwen3.5-122B",
    status: "STOPPED",
    access_path: "/runtime/models/cccc-dddd",
  },
  {
    m_name: "SecondModel",
    status: "DEPLOYED",
    access_path: "/runtime/models/eeee-ffff",
  },
]);

function makeFakeCurl(root: string, opts: { validApiKeys: string[]; deployments?: string }) {
  const fakeCurl = join(root, "fake-curl");
  const deployments = opts.deployments ?? DEPLOYMENTS;
  writeFileSync(
    fakeCurl,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'url=""',
      'out="/dev/null"',
      'auth=""',
      'args=("$@")',
      "for ((i = 0; i < ${#args[@]}; i++)); do",
      '  case "${args[$i]}" in',
      "    -o)",
      '      out="${args[$((i + 1))]}"',
      "      ;;",
      "    -H)",
      '      case "${args[$((i + 1))]}" in',
      '        "Authorization: Bearer "*)',
      '          auth="${args[$((i + 1))]#Authorization: Bearer }"',
      "          ;;",
      "      esac",
      "      ;;",
      "    http*://*)",
      '      url="${args[$i]}"',
      "      ;;",
      "  esac",
      "done",
      "is_valid_token() {",
      '  local candidate="$1"',
      `  for valid in ${opts.validApiKeys.map((k) => `'${k}'`).join(" ")} '${PAT_SECRET}'; do`,
      '    [[ "$candidate" == "$valid" ]] && return 0',
      "  done",
      "  return 1",
      "}",
      'case "$url" in',
      "  */auth/health*)",
      "    printf '{}' >\"$out\"",
      "    printf '200'",
      "    ;;",
      "  */auth/users/me*)",
      '    if is_valid_token "$auth"; then',
      `      printf '{"username":"admin"}' >"$out"`,
      "      printf '200'",
      "    else",
      `      printf '{"detail":"Not authenticated"}' >"$out"`,
      "      printf '401'",
      "    fi",
      "    ;;",
      "  */auth/token*)",
      `    printf '{"access_token":"${ACCESS_TOKEN_SECRET}"}' >"$out"`,
      "    printf '200'",
      "    ;;",
      "  */auth/pats*)",
      `    if [[ "$auth" == "${ACCESS_TOKEN_SECRET}" ]]; then`,
      `      printf '{"token":"${PAT_SECRET}","pat":{"name":"test"}}' >"$out"`,
      "      printf '200'",
      "    else",
      `      printf '{"detail":"Not authenticated"}' >"$out"`,
      "      printf '401'",
      "    fi",
      "    ;;",
      "  */serving/deployments*)",
      `    printf '%s' '${deployments}' >"$out"`,
      "    printf '200'",
      "    ;;",
      "  */runtime/models/*/v1/models*)",
      '    if is_valid_token "$auth"; then',
      `      printf '{"object":"list","data":[]}' >"$out"`,
      "      printf '200'",
      "    else",
      "      printf '401'",
      "    fi",
      "    ;;",
      "  *)",
      "    printf '404'",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(fakeCurl, 0o755);
  return fakeCurl;
}

function makeStubBootstrap(root: string) {
  const stub = join(root, "stub-bootstrap.sh");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf 'stub bootstrap invoked\\n'",
      "printf 'stub OPENCLAW_KAMIWAZA_BASE_URL=%s\\n' \"${OPENCLAW_KAMIWAZA_BASE_URL:-unset}\"",
      "printf 'stub OPENCLAW_KAMIWAZA_MODEL_ID=%s\\n' \"${OPENCLAW_KAMIWAZA_MODEL_ID:-unset}\"",
      "printf 'stub KAMIWAZA_PAT_STORE_SOURCE=%s\\n' \"${KAMIWAZA_PAT_STORE_SOURCE:-unset}\"",
      "printf 'stub model key present=%s\\n' \"${OPENCLAW_KAMIWAZA_MODEL_API_KEY:+yes}\"",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return stub;
}

function runScript(args: string[], env: NodeJS.ProcessEnv, root: string) {
  return spawnSync("bash", [SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_RUNTIME_DIR: join(root, "runtime"),
      OPENCLAW_TURNKEY_SKIP_HOST_CHECK: "1",
      KAMIWAZA_API_URL: "https://kamiwaza.local.test/api",
      ...env,
    },
  });
}

describe("turnkey-kamiwaza-openclaw.sh", () => {
  it("uses a valid KAMIWAZA_API_KEY, selects the first deployed model, and hands off", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-turnkey-key-"));
    try {
      const fakeCurl = makeFakeCurl(root, { validApiKeys: ["env-api-key-value"] });
      const stub = makeStubBootstrap(root);

      const result = runScript(
        [],
        {
          KAMIWAZA_API_KEY: "env-api-key-value",
          OPENCLAW_TURNKEY_BOOTSTRAP_SCRIPT: stub,
          OPENCLAW_TURNKEY_CURL: fakeCurl,
        },
        root,
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Kamiwaza access validated as admin");
      expect(result.stdout).toContain("selected model: Kimi-K2.6");
      expect(result.stdout).toContain(
        "stub OPENCLAW_KAMIWAZA_BASE_URL=https://host.lima.internal/runtime/models/aaaa-bbbb/v1",
      );
      expect(result.stdout).toContain("stub OPENCLAW_KAMIWAZA_MODEL_ID=Kimi-K2.6");
      expect(result.stdout).toContain("stub model key present=yes");
      expect(result.stdout).toContain("Kamiwaza credential source: env-api-key");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("falls back to username/password, mints a PAT, and never prints secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-turnkey-pat-"));
    try {
      const fakeCurl = makeFakeCurl(root, { validApiKeys: [] });
      const stub = makeStubBootstrap(root);

      const result = runScript(
        [],
        {
          KAMIWAZA_PASSWORD: PASSWORD_SECRET,
          KAMIWAZA_USERNAME: "admin",
          OPENCLAW_TURNKEY_BOOTSTRAP_SCRIPT: stub,
          OPENCLAW_TURNKEY_CURL: fakeCurl,
        },
        root,
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("generating a PAT for OpenClaw");
      expect(result.stdout).toContain("Kamiwaza credential source: generated-pat");
      expect(result.stdout).toContain("stub model key present=yes");
      for (const secret of [PAT_SECRET, PASSWORD_SECRET, ACCESS_TOKEN_SECRET]) {
        expect(result.stdout).not.toContain(secret);
        expect(result.stderr).not.toContain(secret);
      }

      const storePath = join(root, "runtime", "metadata", "kamiwaza-pat-store-source.json");
      expect(existsSync(storePath)).toBe(true);
      const store = JSON.parse(readFileSync(storePath, "utf8"));
      expect(store.format).toBe("pdash-pat-store-v1");
      expect(store.active_tokens[0].token).toBe(PAT_SECRET);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("selects the requested model by name", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-turnkey-model-"));
    try {
      const fakeCurl = makeFakeCurl(root, { validApiKeys: ["env-api-key-value"] });
      const stub = makeStubBootstrap(root);

      const result = runScript(
        ["--model", "SecondModel"],
        {
          KAMIWAZA_API_KEY: "env-api-key-value",
          OPENCLAW_TURNKEY_BOOTSTRAP_SCRIPT: stub,
          OPENCLAW_TURNKEY_CURL: fakeCurl,
        },
        root,
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("selected model: SecondModel");
      expect(result.stdout).toContain(
        "stub OPENCLAW_KAMIWAZA_BASE_URL=https://host.lima.internal/runtime/models/eeee-ffff/v1",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("advises deploying a model and stops without an explicit bypass", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-turnkey-nomodel-"));
    try {
      const fakeCurl = makeFakeCurl(root, {
        validApiKeys: ["env-api-key-value"],
        deployments: "[]",
      });
      const stub = makeStubBootstrap(root);

      const result = runScript(
        [],
        {
          KAMIWAZA_API_KEY: "env-api-key-value",
          OPENCLAW_TURNKEY_BOOTSTRAP_SCRIPT: stub,
          OPENCLAW_TURNKEY_CURL: fakeCurl,
        },
        root,
      );

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("deploy a model first through the Kamiwaza UI");
      expect(result.stdout).not.toContain("stub bootstrap invoked");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("continues without a model when the bypass is set", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-turnkey-bypass-"));
    try {
      const fakeCurl = makeFakeCurl(root, {
        validApiKeys: ["env-api-key-value"],
        deployments: "[]",
      });
      const stub = makeStubBootstrap(root);

      const result = runScript(
        [],
        {
          KAMIWAZA_API_KEY: "env-api-key-value",
          OPENCLAW_KAMIWAZA_ALLOW_NO_MODEL: "1",
          OPENCLAW_TURNKEY_BOOTSTRAP_SCRIPT: stub,
          OPENCLAW_TURNKEY_CURL: fakeCurl,
        },
        root,
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("continuing without a model endpoint");
      expect(result.stdout).toContain("stub bootstrap invoked");
      expect(result.stdout).toContain("stub OPENCLAW_KAMIWAZA_BASE_URL=unset");
      expect(result.stdout).toContain("agent model: none configured");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
