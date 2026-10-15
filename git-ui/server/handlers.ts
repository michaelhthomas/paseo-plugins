import { rm } from "node:fs/promises";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { MutationResult } from "../shared/git";
import type {
  commitRpc,
  diffRpc,
  filesRpc,
  changeRpc,
  lastCommitMessageRpc,
  linesRpc,
  statusRpc,
  syntaxColorsRpc,
} from "../shared/git";
import { applyChange, insideRepo, readLines } from "./diff";
import { fileDiffs } from "./diff-batch";
import { describeGitError, NotARepositoryError, repoFor, type Repo } from "./git";
import { syntaxColors } from "./highlight";
import { NOT_A_REPO, readStatus } from "./status";

const MAX_CONTEXT_LINES = 2_000;

const ok: MutationResult = { ok: true, reason: null, message: null };
const failed = (error: unknown): MutationResult => ({ ok: false, reason: "error", message: describeGitError(error) });

export async function status({ workspaceId }: RpcInput<typeof statusRpc>, context: PluginHandlerContext) {
  try {
    return await readStatus(await repoFor(workspaceId, context));
  } catch (error) {
    if (error instanceof NotARepositoryError) return NOT_A_REPO;
    throw new Error(describeGitError(error));
  }
}

export async function diff({ workspaceId, files, ignoreWhitespace }: RpcInput<typeof diffRpc>, context: PluginHandlerContext) {
  const repo = await repoFor(workspaceId, context);
  return { files: await fileDiffs(repo, files.map((file) => ({ ...file, ignoreWhitespace }))) };
}

export async function lines({ workspaceId, path, side, start, end }: RpcInput<typeof linesRpc>, context: PluginHandlerContext) {
  const repo = await repoFor(workspaceId, context);
  return readLines(repo, path, side, start, Math.min(end, start + MAX_CONTEXT_LINES - 1));
}

export async function change({ workspaceId, ...input }: RpcInput<typeof changeRpc>, context: PluginHandlerContext) {
  const repo = await repoFor(workspaceId, context);
  try {
    return await applyChange(repo, input);
  } catch (error) {
    return failed(error);
  }
}

async function hasHead(repo: Repo) {
  // `--verify -q` exits 1 without output when there are no commits yet.
  return (await repo.writer.raw(["rev-parse", "--verify", "-q", "HEAD"])).trim() !== "";
}

async function discard(repo: Repo, paths: string[]) {
  // Untracked files have nothing to restore; delete them. Re-read status so only files git calls untracked go.
  const current = await readStatus(repo);
  const untracked = new Set(current.unstaged.filter((entry) => entry.kind === "untracked").map((entry) => entry.path));
  const tracked = paths.filter((path) => !untracked.has(path));
  if (tracked.length) await repo.writer.raw(["restore", "--worktree", "--", ...tracked]);
  for (const path of paths.filter((path) => untracked.has(path))) await rm(insideRepo(repo, path), { force: true });
}

export async function files({ workspaceId, paths, action }: RpcInput<typeof filesRpc>, context: PluginHandlerContext) {
  return applyFiles(await repoFor(workspaceId, context), paths, action);
}

export async function applyFiles(repo: Repo, paths: string[], action: RpcInput<typeof filesRpc>["action"]): Promise<MutationResult> {
  try {
    switch (action) {
      case "stage":
      case "resolve":
        await repo.writer.add(paths);
        break;
      case "unstage":
        if (await hasHead(repo)) await repo.writer.raw(["restore", "--staged", "--", ...paths]);
        else await repo.writer.rmKeepLocal(paths);
        break;
      case "discard":
        await discard(repo, paths);
        break;
    }
    return ok;
  } catch (error) {
    return failed(error);
  }
}

export async function commit({ workspaceId, message, amend, all }: RpcInput<typeof commitRpc>, context: PluginHandlerContext) {
  return commitChanges(await repoFor(workspaceId, context), message, { amend, all });
}

export async function commitChanges(repo: Repo, message: string, { amend = false, all = false }: { amend?: boolean; all?: boolean } = {}) {
  try {
    if (all) await repo.writer.add(["--all"]);
    const result = await repo.writer.commit(message, amend ? { "--amend": null } : {});
    // git exits 1 with only stdout ("nothing to commit"), which simple-git doesn't treat as an error.
    if (!result.commit) return { ok: false, sha: null, message: "Nothing to commit. Stage some changes first." };
    return { ok: true, sha: result.commit, message: null };
  } catch (error) {
    return { ok: false, sha: null, message: describeGitError(error) };
  }
}

export async function lastCommitMessage({ workspaceId }: RpcInput<typeof lastCommitMessageRpc>, context: PluginHandlerContext) {
  const repo = await repoFor(workspaceId, context);
  try {
    return { message: (await repo.reader.raw(["log", "-1", "--format=%B"])).replace(/\s+$/, "") || null };
  } catch {
    return { message: null };
  }
}

export function colors({ theme }: RpcInput<typeof syntaxColorsRpc>) {
  return syntaxColors(theme);
}
