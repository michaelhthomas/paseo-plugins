import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { SimpleGit } from "simple-git";
import type { ChangedLine, ContextLine, DiffLine, DiffSide, FileDiff, MutationResult, Side, Token } from "../shared/git";
import { describeGitError, type Repo } from "./git";
import { buildSelectionPatch, contentLines, countLines, mapLine, parseFileDiff, type ParsedFileDiff, type ParsedLine } from "./diff-parse";
import { highlightFile } from "./highlight";

const MAX_CHANGED_LINES = 5_000;
const MAX_DIFF_CHARS = 4 * 1024 * 1024;
const MAX_FORCED_DIFF_CHARS = 32 * 1024 * 1024;
// What invalid UTF-8 decodes to.
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

export type DiffTarget = { path: string; side: DiffSide; origPath: string | null; untracked: boolean; ignoreWhitespace?: boolean };

// git's empty tree, the base of the combined diff before the first commit.
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Where a diff's raw output and blobs come from: one git process per request (`directSource`), or processes shared by
 * a whole batch of files (`batchSource` in diff-batch.ts).
 */
export type DiffSource = {
  raw(target: DiffTarget): Promise<string>;
  /** A blob by revision spec (`:path`, `HEAD:path`), or null if there isn't one. */
  blob(spec: string): Promise<string | null>;
};

export const directSource = (repo: Repo, git: SimpleGit = repo.reader): DiffSource => ({
  raw: (target) => rawDiff(git, repo, target),
  blob: (spec) => blob(git, spec),
});

/** Resolves a repo-relative path, refusing anything outside the repository. */
export function insideRepo(repo: Repo, path: string) {
  const absolute = resolve(repo.root, path);
  const rel = relative(repo.root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(repo.root, rel) !== absolute) {
    throw new Error(`${path} is outside the repository`);
  }
  return absolute;
}

export function diffArgs(side: DiffSide, paths: string[], ignoreWhitespace: boolean, base: string) {
  return [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-relative",
    "-U3",
    ...(side === "staged" ? ["--cached", "-M"] : side === "combined" ? ["-M", base] : []),
    ...(ignoreWhitespace ? ["-w"] : []),
    "--",
    ...paths,
  ];
}

/**
 * An untracked file as an all-additions diff. `git diff --no-index` would do, but it exits 1 whenever files differ,
 * and simple-git reports that as a failure as soon as git also warns on stderr (about line endings, for example).
 * Untracked diffs are display-only, so building one here is safe.
 */
export async function untrackedDiff(repo: Repo, path: string): Promise<string> {
  const bytes = await readFile(insideRepo(repo, path));
  const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n`;
  // git's own heuristic: a NUL in the first 8000 bytes means binary.
  if (bytes.subarray(0, 8000).includes(0)) return `${header}Binary files /dev/null and b/${path} differ\n`;
  const lines = contentLines(bytes.toString("utf8"));
  if (lines.length === 0) return header;
  const body = lines.map((line) => `+${line}\n`).join("");
  const noNewline = bytes.at(-1) === 0x0a ? "" : "\\ No newline at end of file\n";
  return `${header}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}${noNewline}`;
}

/** One file's raw `git diff` output. */
export async function rawDiff(git: SimpleGit, repo: Repo, target: DiffTarget): Promise<string> {
  if (target.untracked) return untrackedDiff(repo, target.path);
  // A staged rename only shows as a rename when both paths are in the pathspec.
  const paths = target.side !== "unstaged" && target.origPath ? [target.origPath, target.path] : [target.path];
  const base = target.side === "combined" ? ((await git.raw(["rev-parse", "--verify", "-q", "HEAD"])).trim() ? "HEAD" : EMPTY_TREE) : "";
  return git.raw(diffArgs(target.side, paths, target.ignoreWhitespace ?? false, base));
}

export function fingerprint(raw: string) {
  return createHash("sha1").update(raw).digest("hex");
}

async function blob(git: SimpleGit, spec: string): Promise<string | null> {
  try {
    return await git.raw(["cat-file", "blob", spec]);
  } catch {
    return null;
  }
}

async function worktreeFile(repo: Repo, path: string): Promise<string | null> {
  try {
    return await readFile(insideRepo(repo, path), "utf8");
  } catch {
    return null;
  }
}

/** The side of the diff that context lines come from: the index for staged changes, otherwise the working tree. */
export function newSideContent(repo: Repo, path: string, side: DiffSide, source = directSource(repo)) {
  return side === "staged" ? source.blob(`:${path}`) : worktreeFile(repo, path);
}

function oldSideContent(target: DiffTarget, source: DiffSource) {
  if (target.untracked) return Promise.resolve(null);
  return source.blob(target.side === "unstaged" ? `:${target.path}` : `HEAD:${target.origPath ?? target.path}`);
}

const changesIn = (diff: ParsedFileDiff | null, type: "add" | "remove") =>
  new Set(diff?.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => (line.type !== type ? [] : [type === "add" ? line.newNo! : line.oldNo!]))) ?? []);

/**
 * Which side each changed line is on. In the combined diff (HEAD to working tree) an added line is unstaged if the
 * unstaged diff adds it (it isn't in the index), and a removed line is staged if the staged diff removes it (it's gone
 * from the index); everything else is on the other side.
 */
async function lineOrigins(target: DiffTarget, source: DiffSource): Promise<(line: ParsedLine) => Side | null> {
  if (target.side !== "combined") {
    const side = target.side;
    return (line) => (line.type === "context" ? null : side);
  }
  if (target.untracked) return (line) => (line.type === "context" ? null : "unstaged");
  const [staged, unstaged] = await Promise.all([
    source.raw({ ...target, side: "staged" }).then(parseFileDiff),
    source.raw({ ...target, side: "unstaged" }).then(parseFileDiff),
  ]);
  const added = changesIn(unstaged, "add");
  const removed = changesIn(staged, "remove");
  return (line) => {
    if (line.type === "add") return added.has(line.newNo!) ? "unstaged" : "staged";
    if (line.type === "remove") return removed.has(line.oldNo!) ? "staged" : "unstaged";
    return null;
  };
}

/** Tokens for a line, unless they don't add up to its text (filters such as LFS or ident can make them differ). */
function tokensFor(lines: Token[][] | null, lineNo: number | null, content: string): Token[] | null {
  if (!lines || lineNo === null) return null;
  const tokens = lines[lineNo - 1];
  if (!tokens) return null;
  let text = "";
  for (const [part] of tokens) text += part;
  return text === content ? tokens : null;
}

function isPatchable(parsed: ParsedFileDiff, raw: string, target: DiffTarget) {
  // Output that wasn't valid UTF-8 can't be written back byte for byte, and `-w` hunks don't match the file.
  return !target.untracked && !target.ignoreWhitespace && !parsed.isBinary && !parsed.isSubmodule && parsed.hunks.length > 0 && !raw.includes(REPLACEMENT_CHAR);
}

export type FileDiffTarget = DiffTarget & { stamp: string; force?: boolean };

/** The file's diff, or an `error` diff when git fails for this file, so one file can't fail a whole batch. */
export async function fileDiff(repo: Repo, target: FileDiffTarget, source = directSource(repo)): Promise<FileDiff> {
  try {
    return await readFileDiff(repo, target, source);
  } catch (error) {
    return { ...emptyDiff(target, ""), status: "error", message: describeGitError(error) };
  }
}

function emptyDiff(target: FileDiffTarget, raw: string): FileDiff {
  return {
    path: target.path,
    side: target.side,
    oldPath: target.origPath,
    stamp: target.stamp,
    status: "ok",
    isNew: target.untracked,
    isDeleted: false,
    patchable: false,
    fingerprint: fingerprint(raw),
    newSideHash: "",
    additions: 0,
    deletions: 0,
    hunks: [],
    newLineCount: 0,
    message: null,
  };
}

async function readFileDiff(repo: Repo, target: FileDiffTarget, source: DiffSource): Promise<FileDiff> {
  const raw = await source.raw(target);
  const base = emptyDiff(target, raw);
  const parsed = parseFileDiff(raw);
  if (!parsed) return { ...base, status: "empty", message: target.ignoreWhitespace && !target.untracked ? "Only whitespace changed." : null };
  const summary = {
    ...base,
    isNew: parsed.isNew,
    isDeleted: parsed.isDeleted,
    additions: parsed.additions,
    deletions: parsed.deletions,
  };
  if (parsed.isBinary) return { ...summary, status: "binary" };
  if (parsed.hunks.length === 0 && parsed.isNew) return { ...summary, status: "empty" };
  if (parsed.isSubmodule || parsed.hunks.length === 0) return { ...summary, status: "unsupported" };
  const changed = parsed.additions + parsed.deletions;
  if (raw.length > MAX_FORCED_DIFF_CHARS || (!target.force && (changed > MAX_CHANGED_LINES || raw.length > MAX_DIFF_CHARS))) {
    return { ...summary, status: "too_large" };
  }

  const [newContent, oldContent] = await Promise.all([
    parsed.isDeleted ? Promise.resolve(null) : newSideContent(repo, target.path, target.side, source),
    parsed.isNew ? Promise.resolve(null) : oldSideContent(target, source),
  ]);
  const originOf = await lineOrigins(target, source);
  // Highlighting is the CPU-heavy part. Let other requests in between files, so a batch of them doesn't hold up the
  // diff the user just opened.
  await new Promise((resolve) => setImmediate(resolve));
  const newTokens = newContent === null ? null : highlightFile(newContent, target.path);
  const oldTokens = oldContent === null ? null : highlightFile(oldContent, target.origPath ?? target.path);
  const hunks = parsed.hunks.map(({ raw: _raw, lines, ...hunk }) => ({
    ...hunk,
    hash: hunkHash(lines),
    lines: lines.map(
      (line): DiffLine => ({
        ...line,
        origin: originOf(line),
        tokens:
          line.type === "remove" ? tokensFor(oldTokens, line.oldNo, line.content) : tokensFor(newTokens, line.newNo, line.content),
      }),
    ),
  }));
  const last = parsed.hunks.at(-1)!;
  const newLineCount = newContent !== null ? countLines(newContent) : parsed.isDeleted ? 0 : last.newStart + last.newCount - 1;
  const newSideHash = newContent === null ? "" : fingerprint(newContent);
  return { ...summary, patchable: isPatchable(parsed, raw, target), hunks, newLineCount, newSideHash };
}

export async function readLines(repo: Repo, path: string, side: DiffSide, start: number, end: number) {
  const content = await newSideContent(repo, path, side);
  if (content === null) return { start, lines: [] };
  const all = contentLines(content);
  const tokens = highlightFile(content, path);
  const lines = all.slice(start - 1, end).map(
    (text, i): ContextLine => ({ content: text, tokens: tokensFor(tokens, start + i, text) }),
  );
  return { start, lines };
}

const APPLY_FLAGS = {
  stage: ["--cached", "--recount"],
  unstage: ["--cached", "--reverse", "--recount"],
  discard: ["--reverse", "--recount"],
} as const;

export type HunkAction = keyof typeof APPLY_FLAGS;

/** A hunk's identity: its lines and their kinds, independent of where in the file it sits. */
export function hunkHash(lines: readonly { type: string; content: string; noNewline: boolean }[]) {
  const hash = createHash("sha1");
  for (const line of lines) hash.update(`${line.type[0]}${line.noNewline ? "\\" : " "}${line.content}\n`);
  return hash.digest("hex");
}

function findLine(diff: ParsedFileDiff, type: "add" | "remove", no: number, content: string): [number, number] | null {
  for (const [hunkIndex, hunk] of diff.hunks.entries()) {
    const index = hunk.lines.findIndex((line) => line.type === type && (type === "add" ? line.newNo : line.oldNo) === no && line.content === content);
    if (index >= 0) return [hunkIndex, index];
  }
  return null;
}

/**
 * Stages, unstages or restores some changed lines. Recomputes the staged or unstaged diff (`origin`) and finds each
 * line in it by number and content: if any isn't there any more, it refuses, so nothing is applied to content the user
 * hasn't seen. The patch changes only those lines, across however many hunks they're in.
 *
 * Lines shown in the combined diff are numbered on HEAD (removals) and the working tree (additions); the staged and
 * unstaged diffs meet at the index. So a removal still to stage is found through the staged diff (HEAD to index), and
 * an addition already staged through the unstaged diff (working tree to index).
 */
export async function applyChange(
  repo: Repo,
  input: { path: string; origPath: string | null; view: DiffSide; origin: Side; action: HunkAction; lines: ChangedLine[] },
): Promise<MutationResult> {
  const allowed = input.origin === "staged" ? input.action === "unstage" : input.action !== "unstage";
  if (!allowed) return { ok: false, reason: "error", message: `Can't ${input.action} a ${input.origin} change` };
  const base = { path: input.path, origPath: input.origPath, untracked: false };
  const target: DiffTarget = { ...base, side: input.origin };
  const raw = await rawDiff(repo.writer, repo, target);
  const parsed = parseFileDiff(raw);
  if (parsed && !isPatchable(parsed, raw, target)) {
    return { ok: false, reason: "error", message: "This change can only be staged as a whole file." };
  }
  const stale: MutationResult = { ok: false, reason: "stale", message: "The file changed. The diff has been refreshed." };
  if (!parsed) return stale;

  const crossed = input.origin === "unstaged" ? "remove" : "add";
  const through =
    input.view === "combined" && input.lines.some((line) => line.type === crossed)
      ? parseFileDiff(await rawDiff(repo.writer, repo, { ...base, side: input.origin === "unstaged" ? "staged" : "unstaged" }))
      : null;
  const selection = new Map<number, Set<number>>();
  for (const line of input.lines) {
    const no = input.view === "combined" && line.type === crossed ? mapLine(through, line.no, line.type === "remove" ? "old" : "new") : line.no;
    const found = no === null ? null : findLine(parsed, line.type, no, line.content);
    if (!found) return stale;
    const [hunk, index] = found;
    if (!selection.has(hunk)) selection.set(hunk, new Set());
    selection.get(hunk)!.add(index);
  }

  const dir = await mkdtemp(join(tmpdir(), "git-ui-"));
  try {
    const file = join(dir, "change.patch");
    await writeFile(file, buildSelectionPatch(parsed, selection, input.action !== "stage"), "utf8");
    await repo.writer.applyPatch(file, [...APPLY_FLAGS[input.action]]);
    return { ok: true, reason: null, message: null };
  } catch (error) {
    return { ok: false, reason: "error", message: describeGitError(error) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
