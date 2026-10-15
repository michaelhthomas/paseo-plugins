import { resolve } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { GitError, simpleGit, type SimpleGit } from "simple-git";

export type Repo = {
  root: string;
  /** Status, diffs and file contents. Never takes optional locks, so polling can't block agents' git. */
  reader: SimpleGit;
  /** Stage, unstage, discard and commit. One process at a time, so mutations never overlap. */
  writer: SimpleGit;
  /** The reader's environment, for git processes simple-git can't run (ones that read stdin). */
  readerEnv: Record<string, string>;
};

export class NotARepositoryError extends Error {}

const READ_TIMEOUT_MS = 60_000;
// Commit hooks can be slow and quiet.
const WRITE_TIMEOUT_MS = 5 * 60_000;

// simple-git rejects tasks whose environment contains guarded keys it wasn't told to allow: every GIT_* key, plus
// these. Ambient ones are dropped rather than passed through.
const GUARDED_KEYS = new Set(["editor", "pager", "prefix", "ssh_askpass", "visual"]);
const OUR_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  // Treat paths as literal file names, so "a[1].ts" doesn't match "a1.ts".
  GIT_LITERAL_PATHSPECS: "1",
  LC_ALL: "C",
};

let lifetime = new AbortController();
const directories = new Map<string, string>();
const repos = new Map<string, Promise<Repo>>();

function baseEnv() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const lower = key.toLowerCase();
    if (value === undefined || lower.startsWith("git_") || GUARDED_KEYS.has(lower)) continue;
    env[key] = value;
  }
  return env;
}

const envFor = (kind: "reader" | "writer") => ({ ...baseEnv(), ...OUR_ENV, ...(kind === "reader" ? { GIT_OPTIONAL_LOCKS: "0" } : {}) });

/** Aborted when the plugin stops. */
export const lifetimeSignal = () => lifetime.signal;

function createGit(baseDir: string, kind: "reader" | "writer") {
  const env = envFor(kind);
  return simpleGit({
    baseDir,
    maxConcurrentProcesses: kind === "reader" ? 4 : 1,
    config: ["core.quotepath=off", "color.ui=never"],
    trimmed: false,
    abort: lifetime.signal,
    timeout: { block: kind === "reader" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS },
    allowEnvironment: Object.keys(env).filter((key) => key.toLowerCase().startsWith("git_")),
  }).env(env);
}

/** Opens the repository containing `directory`. Throws `NotARepositoryError` outside one. */
export async function openRepo(directory: string): Promise<Repo> {
  let root: string;
  try {
    root = (await createGit(directory, "reader").revparse(["--show-toplevel"])).trim();
  } catch (error) {
    if (error instanceof GitError && /not a git repository/i.test(error.message)) throw new NotARepositoryError(error.message);
    throw error;
  }
  if (!root) throw new NotARepositoryError(`${directory} is not inside a git repository`);
  root = resolve(root);
  return { root, reader: createGit(root, "reader"), writer: createGit(root, "writer"), readerEnv: envFor("reader") };
}

async function workspaceDirectory(workspaceId: string, { paseo }: PluginHandlerContext) {
  const known = directories.get(workspaceId);
  if (known) return known;
  const workspace = paseo.workspaces.ref(workspaceId);
  await workspace.refresh();
  const directory = workspace.directory;
  if (!directory) throw new Error(`Workspace ${workspaceId} has no directory`);
  directories.set(workspaceId, directory);
  return directory;
}

export async function repoFor(workspaceId: string, context: PluginHandlerContext) {
  const directory = await workspaceDirectory(workspaceId, context);
  let repo = repos.get(directory);
  if (!repo) {
    repo = openRepo(directory);
    repos.set(directory, repo);
    // Let a later call retry, e.g. after `git init`.
    repo.catch(() => repos.delete(directory));
  }
  return repo;
}

/** Turns git's stderr into something short enough for a toast. */
export function describeGitError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/index\.lock/.test(message)) return "Another git process is running in this repository. Try again in a moment.";
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^hint:/.test(line));
  const important = lines.find((line) => /^(fatal|error):/.test(line));
  return (important ?? lines[0] ?? "git failed").replace(/^(fatal|error):\s*/, "");
}

export function disposeRepos() {
  lifetime.abort();
  lifetime = new AbortController();
  repos.clear();
  directories.clear();
}
