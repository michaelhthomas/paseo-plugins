import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FileStatusResult } from "simple-git";
import type { EntryKind, GitStatus, StatusEntry } from "../shared/git";
import type { Repo } from "./git";

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const INDEX_KINDS: Record<string, EntryKind> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
};

const WORKTREE_KINDS: Record<string, EntryKind> = {
  M: "modified",
  // Intent-to-add files show as " A".
  A: "added",
  D: "deleted",
  T: "typechange",
};

type Section = Pick<GitStatus, "staged" | "unstaged" | "conflicted">;

/**
 * Sorts simple-git's status files into the staged, unstaged and conflicted sections. A file with staged and
 * unstaged changes appears in both. `stampFor` gives the part of an entry's stamp that tracks file content.
 */
export function sectionStatus(files: readonly FileStatusResult[], stampFor: (path: string) => string): Section {
  const sections: Section = { staged: [], unstaged: [], conflicted: [] };
  const entry = (file: FileStatusResult, kind: EntryKind, code: string): StatusEntry => ({
    path: file.path,
    origPath: file.from && file.from !== file.path ? file.from : null,
    kind,
    stamp: `${code}:${stampFor(file.path)}`,
    additions: null,
    deletions: null,
  });
  for (const file of files) {
    const code = file.index + file.working_dir;
    if (CONFLICT_CODES.has(code)) {
      sections.conflicted.push(entry(file, "conflict", code));
      continue;
    }
    if (file.index === "?") {
      sections.unstaged.push(entry(file, "untracked", code));
      continue;
    }
    if (file.index === "!") continue;
    const staged = INDEX_KINDS[file.index];
    if (staged) sections.staged.push(entry(file, staged, code));
    const unstaged = WORKTREE_KINDS[file.working_dir];
    // A staged rename's worktree changes belong to the new path only.
    if (unstaged) sections.unstaged.push({ ...entry(file, unstaged, code), origPath: null });
  }
  const byPath = (a: StatusEntry, b: StatusEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  sections.staged.sort(byPath);
  sections.unstaged.sort(byPath);
  sections.conflicted.sort(byPath);
  return sections;
}

export type ParsedStatus = {
  files: FileStatusResult[];
  /** Per path, the HEAD and index objects git compared ("hH:hI"); absent for untracked files. */
  objects: Map<string, string>;
  branch: string | null;
  upstream: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
};

/**
 * Parses `git status --porcelain=v2 --branch -z`. Unlike v1, it names the HEAD and index objects of every changed
 * entry, which identify its staged and unstaged diffs without looking at the index file as a whole.
 */
export function parseStatusV2(output: string): ParsedStatus {
  const status: ParsedStatus = { files: [], objects: new Map(), branch: null, upstream: null, detached: false, ahead: 0, behind: 0 };
  const records = output.split("\0");
  // "." means unmodified in v2; v1 (and the section rules) use a space.
  const side = (code: string) => (code === "." ? " " : code);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith("# ")) {
      const [, key, ...rest] = record.split(" ");
      const value = rest.join(" ");
      if (key === "branch.head") {
        status.detached = value === "(detached)";
        status.branch = status.detached ? null : value;
      } else if (key === "branch.upstream") status.upstream = value;
      else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) [status.ahead, status.behind] = [Number(match[1]), Number(match[2])];
      }
      continue;
    }
    const fieldsBeforePath = { "1": 8, "2": 9, u: 10 }[record[0]];
    if (fieldsBeforePath === undefined) {
      // "? path" (untracked) or "! path" (ignored).
      if (record[0] === "?") status.files.push({ path: record.slice(2), index: "?", working_dir: "?" } as FileStatusResult);
      continue;
    }
    const fields = record.split(" ");
    const path = fields.slice(fieldsBeforePath).join(" ");
    const xy = fields[1];
    const file = { path, index: side(xy[0]), working_dir: side(xy[1]) } as FileStatusResult;
    if (record[0] === "2") {
      // The rename's old path is the next record.
      (file as { from?: string }).from = records[++i];
    }
    status.files.push(file);
    if (record[0] !== "u") status.objects.set(path, `${fields[6]}:${fields[7]}`);
  }
  return status;
}

async function statStamp(path: string) {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "-";
  }
}

type LineStats = { additions: number | null; deletions: number | null };

/** Parses `git diff --numstat -z`. Renames come as "a\td\t" followed by the old and new paths. */
export function parseNumstat(output: string): Map<string, LineStats> {
  const stats = new Map<string, LineStats>();
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(fields[i]);
    if (!match) continue;
    let path = match[3];
    if (path === "") {
      path = fields[i + 2] ?? "";
      i += 2;
    }
    // Binary files report "-".
    stats.set(path, match[1] === "-" ? { additions: null, deletions: null } : { additions: Number(match[1]), deletions: Number(match[2]) });
  }
  return stats;
}

const MAX_COUNTED_BYTES = 2 * 1024 * 1024;

async function untrackedStats(repo: Repo, path: string): Promise<LineStats> {
  try {
    const absolute = resolve(repo.root, path);
    if ((await stat(absolute)).size > MAX_COUNTED_BYTES) return { additions: null, deletions: null };
    const bytes = await readFile(absolute);
    if (bytes.subarray(0, 8000).includes(0)) return { additions: null, deletions: null };
    let lines = 0;
    for (const byte of bytes) if (byte === 0x0a) lines++;
    if (bytes.length > 0 && bytes.at(-1) !== 0x0a) lines++;
    return { additions: lines, deletions: 0 };
  } catch {
    return { additions: null, deletions: null };
  }
}

const NUMSTAT = ["diff", "--numstat", "-z", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative"];

/** Line counts for every entry. Only recomputed when the status revision changes. */
const statsCache = new Map<string, { revision: string; sections: Section }>();

async function withStats(repo: Repo, revision: string, sections: Section): Promise<Section> {
  const cached = statsCache.get(repo.root);
  if (cached?.revision === revision) return cached.sections;
  const [staged, unstaged] = await Promise.all([
    sections.staged.length ? repo.reader.raw([...NUMSTAT, "--cached", "-M"]).then(parseNumstat) : new Map<string, LineStats>(),
    sections.unstaged.length ? repo.reader.raw(NUMSTAT).then(parseNumstat) : new Map<string, LineStats>(),
  ]);
  const untracked = new Map(
    await Promise.all(
      sections.unstaged
        .filter((entry) => entry.kind === "untracked")
        .map(async (entry) => [entry.path, await untrackedStats(repo, entry.path)] as const),
    ),
  );
  const result: Section = {
    staged: sections.staged.map((entry) => ({ ...entry, ...staged.get(entry.path) })),
    unstaged: sections.unstaged.map((entry) => ({ ...entry, ...(untracked.get(entry.path) ?? unstaged.get(entry.path)) })),
    conflicted: sections.conflicted,
  };
  statsCache.set(repo.root, { revision, sections: result });
  return result;
}

export async function readStatus(repo: Repo): Promise<GitStatus> {
  const result = parseStatusV2(await repo.reader.raw(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]));
  const paths = [...new Set(result.files.map((file) => file.path))];
  const stamps = await Promise.all(paths.map((path) => statStamp(resolve(repo.root, path))));
  // An entry's diffs depend on its HEAD and index objects and its working-tree file, and nothing else: staging one
  // file leaves every other file's stamp, and so its loaded diff, alone.
  const byPath = new Map(paths.map((path, i) => [path, `${stamps[i]}:${result.objects.get(path) ?? "-"}`]));
  const sections = sectionStatus(result.files, (path) => byPath.get(path) ?? "-");
  const status = {
    isRepo: true,
    branch: result.branch,
    upstream: result.upstream,
    detached: result.detached,
    ahead: result.ahead,
    behind: result.behind,
    ...sections,
  };
  const revision = createHash("sha1").update(JSON.stringify(status)).digest("hex");
  return { ...status, ...(await withStats(repo, revision, sections)), revision };
}

export const NOT_A_REPO: GitStatus = {
  isRepo: false,
  branch: null,
  upstream: null,
  detached: false,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  conflicted: [],
  revision: "not-a-repo",
};

export function forgetStatusCaches() {
  statsCache.clear();
}
