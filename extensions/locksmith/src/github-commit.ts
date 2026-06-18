import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { callLocksmith, type LocksmithCallResult } from "./client.js";

type CommitFile = {
  path: string;
  content: string;
  encoding: "text" | "base64";
};

type CommitFilesInput = {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  files: CommitFile[];
  deletePaths: string[];
};

type GithubCallStep = {
  step: string;
  method: string;
  path: string;
  ok: boolean;
  status: number;
};

type GithubCallSuccess = {
  result: LocksmithCallResult;
  step: GithubCallStep;
};

type GithubCommitFilesResult = {
  ok: boolean;
  operation: "commit_files";
  owner: string;
  repo: string;
  branch: string;
  mode?: "git-data" | "contents-initialized" | "contents-initialized-then-git-data";
  commitSha?: string;
  initializedCommitSha?: string;
  filesCommitted: string[];
  filesDeleted: string[];
  verification?: {
    ok: boolean;
    status: number;
    commitSha?: string;
  };
  steps: GithubCallStep[];
  error?: {
    step: string;
    status: number;
    message: string;
  };
};

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+$/u;
const BASE64_RE = /^(?:[A-Za-z0-9+/]+={0,2}|\s*)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function normalizeOwnerOrRepo(value: string | undefined, label: string): string {
  if (!value || !OWNER_REPO_RE.test(value)) {
    throw new Error(`locksmith_github commit_files requires a valid ${label}.`);
  }
  return value;
}

function normalizeBranch(value: string | undefined): string {
  const branch = value || "main";
  if (
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("?") ||
    branch.includes("#")
  ) {
    throw new Error("locksmith_github commit_files received an invalid branch name.");
  }
  return branch;
}

function normalizeFilePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`locksmith_github commit_files requires ${label}.`);
  }
  const path = value.trim().replace(/^\/+/u, "");
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`locksmith_github commit_files received an invalid file path: ${value}`);
  }
  return path;
}

function normalizeCommitFile(value: unknown, index: number): CommitFile {
  if (!isRecord(value)) {
    throw new Error(`locksmith_github commit_files files[${index}] must be an object.`);
  }
  const path = normalizeFilePath(value.path, `files[${index}].path`);
  const content = typeof value.content === "string" ? value.content : undefined;
  if (content === undefined) {
    throw new Error(`locksmith_github commit_files requires files[${index}].content.`);
  }
  const encoding = value.encoding === "base64" ? "base64" : "text";
  if (encoding === "base64" && !BASE64_RE.test(content.replace(/\s+/gu, ""))) {
    throw new Error(`locksmith_github commit_files files[${index}].content is not valid base64.`);
  }
  return { path, content, encoding };
}

function normalizeCommitFilesInput(rawParams: Record<string, unknown>): CommitFilesInput {
  const owner = normalizeOwnerOrRepo(readStringField(rawParams, "owner"), "owner");
  const repo = normalizeOwnerOrRepo(readStringField(rawParams, "repo"), "repo");
  const branch = normalizeBranch(readStringField(rawParams, "branch"));
  const message = readStringField(rawParams, "message");
  if (!message) {
    throw new Error("locksmith_github commit_files requires a commit message.");
  }
  const rawFiles = Array.isArray(rawParams.files) ? rawParams.files : [];
  const files = rawFiles.map((entry, index) => normalizeCommitFile(entry, index));
  const deletePaths = readStringArray(rawParams, "deletePaths").map((entry, index) =>
    normalizeFilePath(entry, `deletePaths[${index}]`),
  );
  if (files.length === 0 && deletePaths.length === 0) {
    throw new Error("locksmith_github commit_files requires at least one file or delete path.");
  }
  const duplicatePath = findDuplicate([...files.map((file) => file.path), ...deletePaths]);
  if (duplicatePath) {
    throw new Error(`locksmith_github commit_files received duplicate path: ${duplicatePath}`);
  }
  return { owner, repo, branch, message, files, deletePaths };
}

function findDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

function asBase64(file: CommitFile): string {
  return file.encoding === "base64"
    ? file.content.replace(/\s+/gu, "")
    : Buffer.from(file.content, "utf8").toString("base64");
}

function blobEncoding(file: CommitFile): "utf-8" | "base64" {
  return file.encoding === "base64" ? "base64" : "utf-8";
}

function resultDataRecord(result: LocksmithCallResult): Record<string, unknown> | undefined {
  return isRecord(result.data) ? result.data : undefined;
}

function nestedRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

function readNestedString(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  let current = record;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (index === keys.length - 1) {
      return typeof current?.[key] === "string" ? (current[key] as string) : undefined;
    }
    current = nestedRecord(current, key);
  }
  return undefined;
}

function githubErrorMessage(result: LocksmithCallResult): string {
  const data = resultDataRecord(result);
  const direct = typeof data?.message === "string" ? data.message : undefined;
  const error = nestedRecord(data, "error");
  const nested = typeof error?.message === "string" ? error.message : undefined;
  return direct ?? nested ?? `${result.status} ${result.statusText}`.trim();
}

function commitResult(params: {
  input: CommitFilesInput;
  mode?: GithubCommitFilesResult["mode"];
  commitSha?: string;
  initializedCommitSha?: string;
  verification?: GithubCommitFilesResult["verification"];
  steps: GithubCallStep[];
  error?: GithubCommitFilesResult["error"];
}): GithubCommitFilesResult {
  return {
    ok: params.error === undefined && params.verification?.ok !== false,
    operation: "commit_files",
    owner: params.input.owner,
    repo: params.input.repo,
    branch: params.input.branch,
    ...(params.mode ? { mode: params.mode } : {}),
    ...(params.commitSha ? { commitSha: params.commitSha } : {}),
    ...(params.initializedCommitSha ? { initializedCommitSha: params.initializedCommitSha } : {}),
    filesCommitted: params.input.files.map((file) => file.path),
    filesDeleted: params.input.deletePaths,
    ...(params.verification ? { verification: params.verification } : {}),
    steps: params.steps,
    ...(params.error ? { error: params.error } : {}),
  };
}

async function githubCall(params: {
  cfg?: OpenClawConfig;
  user?: string;
  steps: GithubCallStep[];
  step: string;
  method: string;
  path: string;
  json?: unknown;
}): Promise<GithubCallSuccess> {
  const result = await callLocksmith({
    cfg: params.cfg,
    tool: "github",
    user: params.user,
    method: params.method,
    path: params.path,
    json: params.json,
  });
  const step = {
    step: params.step,
    method: params.method,
    path: params.path,
    ok: result.ok,
    status: result.status,
  };
  params.steps.push(step);
  return { result, step };
}

function failedCommitResult(
  input: CommitFilesInput,
  steps: GithubCallStep[],
  call: GithubCallSuccess,
) {
  return commitResult({
    input,
    steps,
    error: {
      step: call.step.step,
      status: call.result.status,
      message: githubErrorMessage(call.result),
    },
  });
}

function refPath(input: CommitFilesInput): string {
  return `repos/${input.owner}/${input.repo}/git/ref/heads/${input.branch}`;
}

function commitPath(input: CommitFilesInput, shaOrBranch: string): string {
  return `repos/${input.owner}/${input.repo}/commits/${shaOrBranch}`;
}

async function readCurrentBranchHead(params: {
  cfg?: OpenClawConfig;
  user?: string;
  input: CommitFilesInput;
  steps: GithubCallStep[];
}): Promise<{ exists: true; sha: string } | { exists: false; failed?: GithubCallSuccess }> {
  const ref = await githubCall({
    cfg: params.cfg,
    user: params.user,
    steps: params.steps,
    step: "read_ref",
    method: "GET",
    path: refPath(params.input),
  });
  if (!ref.result.ok) {
    return ref.result.status === 404 || ref.result.status === 409
      ? { exists: false }
      : { exists: false, failed: ref };
  }
  const sha = readNestedString(resultDataRecord(ref.result), ["object", "sha"]);
  return sha ? { exists: true, sha } : { exists: false, failed: ref };
}

async function verifyCommit(params: {
  cfg?: OpenClawConfig;
  user?: string;
  input: CommitFilesInput;
  steps: GithubCallStep[];
}): Promise<GithubCommitFilesResult["verification"]> {
  const verification = await githubCall({
    cfg: params.cfg,
    user: params.user,
    steps: params.steps,
    step: "verify_commit",
    method: "GET",
    path: commitPath(params.input, params.input.branch),
  });
  return {
    ok: verification.result.ok,
    status: verification.result.status,
    ...(readNestedString(resultDataRecord(verification.result), ["sha"])
      ? { commitSha: readNestedString(resultDataRecord(verification.result), ["sha"]) }
      : {}),
  };
}

async function commitViaGitData(params: {
  cfg?: OpenClawConfig;
  user?: string;
  input: CommitFilesInput;
  steps: GithubCallStep[];
  parentSha: string;
}): Promise<GithubCommitFilesResult> {
  const commit = await githubCall({
    cfg: params.cfg,
    user: params.user,
    steps: params.steps,
    step: "read_parent_commit",
    method: "GET",
    path: `repos/${params.input.owner}/${params.input.repo}/git/commits/${params.parentSha}`,
  });
  if (!commit.result.ok) {
    return failedCommitResult(params.input, params.steps, commit);
  }
  const baseTreeSha = readNestedString(resultDataRecord(commit.result), ["tree", "sha"]);
  if (!baseTreeSha) {
    return commitResult({
      input: params.input,
      steps: params.steps,
      error: {
        step: "read_parent_commit",
        status: commit.result.status,
        message: "GitHub commit response did not include tree.sha.",
      },
    });
  }

  const tree: Array<Record<string, unknown>> = [];
  for (const file of params.input.files) {
    const blob = await githubCall({
      cfg: params.cfg,
      user: params.user,
      steps: params.steps,
      step: `create_blob:${file.path}`,
      method: "POST",
      path: `repos/${params.input.owner}/${params.input.repo}/git/blobs`,
      json: {
        content: file.content,
        encoding: blobEncoding(file),
      },
    });
    if (!blob.result.ok) {
      return failedCommitResult(params.input, params.steps, blob);
    }
    const blobSha = readNestedString(resultDataRecord(blob.result), ["sha"]);
    if (!blobSha) {
      return commitResult({
        input: params.input,
        steps: params.steps,
        error: {
          step: `create_blob:${file.path}`,
          status: blob.result.status,
          message: "GitHub blob response did not include sha.",
        },
      });
    }
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blobSha });
  }

  for (const path of params.input.deletePaths) {
    tree.push({ path, mode: "100644", type: "blob", sha: null });
  }

  const createdTree = await githubCall({
    cfg: params.cfg,
    user: params.user,
    steps: params.steps,
    step: "create_tree",
    method: "POST",
    path: `repos/${params.input.owner}/${params.input.repo}/git/trees`,
    json: {
      base_tree: baseTreeSha,
      tree,
    },
  });
  if (!createdTree.result.ok) {
    return failedCommitResult(params.input, params.steps, createdTree);
  }
  const treeSha = readNestedString(resultDataRecord(createdTree.result), ["sha"]);
  if (!treeSha) {
    return commitResult({
      input: params.input,
      steps: params.steps,
      error: {
        step: "create_tree",
        status: createdTree.result.status,
        message: "GitHub tree response did not include sha.",
      },
    });
  }

  const createdCommit = await githubCall({
    cfg: params.cfg,
    user: params.user,
    steps: params.steps,
    step: "create_commit",
    method: "POST",
    path: `repos/${params.input.owner}/${params.input.repo}/git/commits`,
    json: {
      message: params.input.message,
      tree: treeSha,
      parents: [params.parentSha],
    },
  });
  if (!createdCommit.result.ok) {
    return failedCommitResult(params.input, params.steps, createdCommit);
  }
  const commitSha = readNestedString(resultDataRecord(createdCommit.result), ["sha"]);
  if (!commitSha) {
    return commitResult({
      input: params.input,
      steps: params.steps,
      error: {
        step: "create_commit",
        status: createdCommit.result.status,
        message: "GitHub commit response did not include sha.",
      },
    });
  }

  const updatedRef = await githubCall({
    cfg: params.cfg,
    user: params.user,
    steps: params.steps,
    step: "update_ref",
    method: "PATCH",
    path: refPath(params.input),
    json: {
      sha: commitSha,
      force: false,
    },
  });
  if (!updatedRef.result.ok) {
    return failedCommitResult(params.input, params.steps, updatedRef);
  }

  const verification = await verifyCommit(params);
  return commitResult({
    input: params.input,
    mode: "git-data",
    commitSha,
    verification,
    steps: params.steps,
    ...(verification?.ok === false
      ? {
          error: {
            step: "verify_commit",
            status: verification.status,
            message: "Final branch commit verification failed.",
          },
        }
      : {}),
  });
}

async function initializeEmptyRepoWithContents(params: {
  cfg?: OpenClawConfig;
  user?: string;
  input: CommitFilesInput;
  steps: GithubCallStep[];
}): Promise<GithubCommitFilesResult> {
  const [firstFile, ...remainingFiles] = params.input.files;
  if (!firstFile) {
    return commitResult({
      input: params.input,
      steps: params.steps,
      error: {
        step: "initialize_contents",
        status: 409,
        message: "Cannot initialize an empty repository with delete-only changes.",
      },
    });
  }

  const initialized = await githubCall({
    cfg: params.cfg,
    user: params.user,
    steps: params.steps,
    step: `initialize_contents:${firstFile.path}`,
    method: "PUT",
    path: `repos/${params.input.owner}/${params.input.repo}/contents/${firstFile.path}`,
    json: {
      message: params.input.message,
      content: asBase64(firstFile),
      branch: params.input.branch,
    },
  });
  if (!initialized.result.ok) {
    return failedCommitResult(params.input, params.steps, initialized);
  }
  const initializedCommitSha = readNestedString(resultDataRecord(initialized.result), [
    "commit",
    "sha",
  ]);

  if (remainingFiles.length === 0 && params.input.deletePaths.length === 0) {
    const verification = await verifyCommit(params);
    return commitResult({
      input: params.input,
      mode: "contents-initialized",
      commitSha: verification?.commitSha ?? initializedCommitSha,
      ...(initializedCommitSha ? { initializedCommitSha } : {}),
      verification,
      steps: params.steps,
      ...(verification?.ok === false
        ? {
            error: {
              step: "verify_commit",
              status: verification.status,
              message: "Initialized branch commit verification failed.",
            },
          }
        : {}),
    });
  }

  const restInput: CommitFilesInput = {
    ...params.input,
    files: remainingFiles,
  };
  const current = await readCurrentBranchHead({
    cfg: params.cfg,
    user: params.user,
    input: params.input,
    steps: params.steps,
  });
  if (!current.exists && current.failed) {
    return failedCommitResult(params.input, params.steps, current.failed);
  }
  if (!current.exists) {
    return commitResult({
      input: params.input,
      steps: params.steps,
      error: {
        step: "read_ref_after_initialize",
        status: 404,
        message: "Repository branch was not readable after Contents API initialization.",
      },
    });
  }

  const result = await commitViaGitData({
    cfg: params.cfg,
    user: params.user,
    input: restInput,
    steps: params.steps,
    parentSha: current.sha,
  });
  return {
    ...result,
    mode: result.ok ? "contents-initialized-then-git-data" : result.mode,
    filesCommitted: params.input.files.map((file) => file.path),
    ...(initializedCommitSha ? { initializedCommitSha } : {}),
  };
}

export async function commitFilesWithLocksmithGithub(params: {
  cfg?: OpenClawConfig;
  user?: string;
  rawParams: Record<string, unknown>;
}): Promise<GithubCommitFilesResult> {
  const input = normalizeCommitFilesInput(params.rawParams);
  const steps: GithubCallStep[] = [];
  const current = await readCurrentBranchHead({
    cfg: params.cfg,
    user: params.user,
    input,
    steps,
  });
  if (!current.exists && current.failed) {
    return failedCommitResult(input, steps, current.failed);
  }
  if (!current.exists) {
    return await initializeEmptyRepoWithContents({
      cfg: params.cfg,
      user: params.user,
      input,
      steps,
    });
  }
  return await commitViaGitData({
    cfg: params.cfg,
    user: params.user,
    input,
    steps,
    parentSha: current.sha,
  });
}
