import { spawn } from "node:child_process";
import type { DiffSide, FileDiff } from "../shared/git";
import { diffArgs, directSource, EMPTY_TREE, fileDiff, type DiffSource, type DiffTarget, type FileDiffTarget } from "./diff";
import { lifetimeSignal, type Repo } from "./git";

/**
 * Diffs for many files with a handful of git processes. Starting git is the expensive part (hundreds of milliseconds
 * a process on Windows), and a file's diff needs up to five: its diff, the staged and unstaged diffs for a combined
 * one, and its blobs. A batch instead runs one \`git diff\` per side for all its files, one \`git cat-file --batch\` for
 * all their blobs, and one HEAD check.
 */
export async function fileDiffs(repo: Repo, targets: readonly FileDiffTarget[]): Promise<FileDiff[]> {
  const source = batchSource(repo, targets);
  return Promise.all(targets.map((target) => fileDiff(repo, target, source)));
}

/** A path git writes without quoting in diff headers (with core.quotepath off): no quotes, backslashes or controls. */
// eslint-disable-next-line no-control-regex
const plain = (path: string) => !/["\\\x00-\x1f\x7f]/.test(path);

/** Splits multi-file \`git diff\` output into its files' sections, keyed by their \`diff --git\` line. */
export function splitDiff(raw: string): Map<string, string> {
  const sections = new Map<string, string>();
  const starts: number[] = [];
  if (raw.startsWith("diff --git ")) starts.push(0);
  for (let i = raw.indexOf("\ndiff --git "); i >= 0; i = raw.indexOf("\ndiff --git ", i + 1)) starts.push(i + 1);
  starts.forEach((start, n) => {
    const end = starts[n + 1] ?? raw.length;
    const section = raw.slice(start, end);
    sections.set(section.slice(0, section.indexOf("\n")), section);
  });
  return sections;
}

const headerFor = (oldPath: string, newPath: string) => `diff --git a/${oldPath} b/${newPath}`;

type Wanted = { path: string; origPath: string | null };

/** The sides each target needs diffs from: its own, and for combined diffs the staged and unstaged ones too. */
function sidesNeeded(target: DiffTarget): { side: DiffSide; wanted: Wanted }[] {
  if (target.untracked) return [];
  const own = { side: target.side, wanted: { path: target.path, origPath: target.side === "unstaged" ? null : target.origPath } };
  if (target.side !== "combined") return [own];
  return [own, { side: "staged", wanted: { path: target.path, origPath: target.origPath } }, { side: "unstaged", wanted: { path: target.path, origPath: null } }];
}

function batchSource(repo: Repo, targets: readonly FileDiffTarget[]): DiffSource {
  const direct = directSource(repo);
  const ignoreWhitespace = targets.some((target) => target.ignoreWhitespace);
  const wanted = new Map<DiffSide, Map<string, Wanted>>();
  for (const target of targets) {
    for (const { side, wanted: file } of sidesNeeded(target)) {
      if (!wanted.has(side)) wanted.set(side, new Map());
      wanted.get(side)!.set(file.path, file);
    }
  }
  const base = () => headOrEmptyTree(repo);
  const outputs = new Map<DiffSide, Promise<Map<string, string>>>();
  const output = (side: DiffSide) => {
    let result = outputs.get(side);
    if (!result) {
      const files = [...(wanted.get(side)?.values() ?? [])];
      const paths = [...new Set(files.flatMap((file) => (file.origPath ? [file.origPath, file.path] : [file.path])))];
      result = (side === "combined" ? base() : Promise.resolve("")).then((rev) => repo.reader.raw(diffArgs(side, paths, ignoreWhitespace, rev))).then(splitDiff);
      outputs.set(side, result);
    }
    return result;
  };

  return {
    async raw(target) {
      const file = sidesNeeded(target).find(({ side }) => side === target.side)?.wanted;
      // Untracked files, unusual names and options the batch wasn't run with go the slow way.
      const batched = file && wanted.get(target.side)?.has(file.path) && plain(file.path) && (!file.origPath || plain(file.origPath));
      if (!batched || !!target.ignoreWhitespace !== ignoreWhitespace) return direct.raw(target);
      const sections = await output(target.side);
      const section = sections.get(headerFor(file.origPath ?? file.path, file.path));
      if (section !== undefined) return section;
      // Expected as a rename but git didn't pair it: ask for this file alone, as before.
      if (file.origPath) return direct.raw(target);
      // No section: the file has no changes on this side.
      return "";
    },
    blob: prefetchBlobs(repo, targets),
  };
}

const hasHead = new WeakMap<Repo, true>();

/** HEAD, or the empty tree before the first commit. Once there's a commit there always is, so that's remembered. */
async function headOrEmptyTree(repo: Repo) {
  if (hasHead.has(repo)) return "HEAD";
  const out = await repo.reader.raw(["rev-parse", "--verify", "-q", "HEAD"]);
  if (!out.trim()) return EMPTY_TREE;
  hasHead.set(repo, true);
  return "HEAD";
}

/** Every blob the targets' diffs could need, by spec: the old side, and the index for staged diffs. */
function blobSpecs(target: DiffTarget) {
  if (target.untracked) return [];
  const old = target.side === "unstaged" ? `:${target.path}` : `HEAD:${target.origPath ?? target.path}`;
  return target.side === "staged" ? [old, `:${target.path}`] : [old];
}

/**
 * Reads the targets' blobs with one git process, started straight away so it runs alongside the diffs rather than
 * after them. Blobs of files that turn out to be binary or too large are read for nothing; that costs less than another
 * git process.
 */
function prefetchBlobs(repo: Repo, targets: readonly DiffTarget[]) {
  const specs = [...new Set(targets.flatMap(blobSpecs))];
  const prefetched = readBlobs(repo, specs);
  // Unused if every file is untracked; don't leave a failure unhandled.
  prefetched.catch(() => undefined);
  const fallback = blobBatcher(repo);
  return async (spec: string) => {
    const blobs = await prefetched;
    return blobs.has(spec) ? blobs.get(spec)! : fallback(spec);
  };
}

/** Collects the blobs asked for in the same turn of the event loop and reads them with one git process. */
function blobBatcher(repo: Repo) {
  let queued: { specs: Set<string>; result: Promise<Map<string, string | null>> } | null = null;
  return (spec: string): Promise<string | null> => {
    if (!queued) {
      const batch: { specs: Set<string>; result: Promise<Map<string, string | null>> } = {
        specs: new Set(),
        result: new Promise((resolve, reject) =>
          setImmediate(() => {
            if (queued === batch) queued = null;
            readBlobs(repo, [...batch.specs]).then(resolve, reject);
          }),
        ),
      };
      queued = batch;
    }
    queued.specs.add(spec);
    return queued.result.then((blobs) => blobs.get(spec) ?? null);
  };
}

/** Blobs by revision spec, read with one \`git cat-file --batch\`. Missing ones (no HEAD, not in the index) are null. */
export function readBlobs(repo: Repo, specs: readonly string[]): Promise<Map<string, string | null>> {
  const blobs = new Map<string, string | null>();
  // The batch protocol is line based.
  const asked = specs.filter((spec) => !spec.includes("\n") && !spec.includes("\r"));
  for (const spec of specs) blobs.set(spec, null);
  if (asked.length === 0) return Promise.resolve(blobs);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotepath=off", "cat-file", "--batch"], {
      cwd: repo.root,
      env: repo.readerEnv,
      signal: lifetimeSignal(),
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `git cat-file exited with ${code}`));
      const out = Buffer.concat(chunks);
      let at = 0;
      for (const spec of asked) {
        const newline = out.indexOf(0x0a, at);
        if (newline < 0) break;
        const header = out.subarray(at, newline).toString("utf8");
        at = newline + 1;
        // "<oid> <type> <size>", or "<spec> missing" / "<spec> ambiguous".
        const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (!match) continue;
        const size = Number(match[2]);
        if (match[1] === "blob") blobs.set(spec, out.subarray(at, at + size).toString("utf8"));
        at += size + 1;
      }
      resolve(blobs);
    });
    child.stdin.end(asked.join("\n") + "\n");
  });
}

