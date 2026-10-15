import type { EntryKind, GitStatus, StatusEntry } from "../shared/git";

export type FileAction = "stage" | "unstage" | "discard" | "resolve";

/** Applying some of a file's changes: stage-part and unstage-part move them across, discard-part drops them. */
export type PartAction = "stage-part" | "unstage-part" | "discard-part";

/** An operation sent to the daemon whose result the UI shows before the daemon confirms it. */
export type FileOp =
  | { action: FileAction; paths: readonly string[] }
  | { action: PartAction; paths: readonly [string]; additions: number; deletions: number };

/** Stamp of entries that only exist optimistically. Their diffs aren't loaded until the daemon confirms them. */
export const OPTIMISTIC_STAMP = "optimistic";

const byPath = (a: StatusEntry, b: StatusEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

const sum = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

function moved(entry: StatusEntry, kind: EntryKind, origPath: string | null = null): StatusEntry {
  return { ...entry, kind, origPath, stamp: OPTIMISTIC_STAMP };
}

/** Adds `entry` to `list`, merging line counts into an entry for the same path. */
function merge(list: StatusEntry[], entry: StatusEntry) {
  const index = list.findIndex((existing) => existing.path === entry.path);
  if (index < 0) {
    list.push(entry);
    return;
  }
  const existing = list[index];
  list[index] = {
    ...existing,
    stamp: OPTIMISTIC_STAMP,
    additions: sum(existing.additions, entry.additions),
    deletions: sum(existing.deletions, entry.deletions),
  };
}

function take(list: StatusEntry[], paths: ReadonlySet<string>) {
  const taken: StatusEntry[] = [];
  const kept: StatusEntry[] = [];
  for (const entry of list) (paths.has(entry.path) ? taken : kept).push(entry);
  return { taken, kept };
}

const less = (count: number | null, by: number) => (count === null ? null : Math.max(0, count - by));

/**
 * Some of a file's changes leaving one side (`from`) and, unless discarded, arriving on the other. The file stays on
 * the side it leaves: only git can say whether anything is left there.
 */
function applyPart(status: GitStatus, op: Extract<FileOp, { action: PartAction }>): GitStatus {
  const [path] = op.paths;
  const fromStaged = op.action === "unstage-part";
  const from = fromStaged ? status.staged : status.unstaged;
  const entry = from.find((candidate) => candidate.path === path);
  if (!entry) return status;
  const left = from.map((candidate) =>
    candidate === entry ? { ...candidate, additions: less(candidate.additions, op.additions), deletions: less(candidate.deletions, op.deletions) } : candidate,
  );
  const to = [...(fromStaged ? status.unstaged : status.staged)];
  if (op.action !== "discard-part") merge(to, { ...moved(entry, entry.kind), additions: op.additions, deletions: op.deletions });
  const staged = fromStaged ? left : to.sort(byPath);
  const unstaged = fromStaged ? to.sort(byPath) : left;
  return { ...status, staged, unstaged };
}

/** What `status` will look like once `op` succeeds, as near as the client can tell without asking git. */
export function applyOp(status: GitStatus, op: FileOp): GitStatus {
  if (op.action === "stage-part" || op.action === "unstage-part" || op.action === "discard-part") return applyPart(status, op);
  const paths = new Set(op.paths);
  const staged = [...status.staged];
  let unstaged = [...status.unstaged];
  let conflicted = [...status.conflicted];
  switch (op.action) {
    case "stage": {
      const { taken, kept } = take(unstaged, paths);
      unstaged = kept;
      for (const entry of taken) merge(staged, moved(entry, entry.kind === "untracked" ? "added" : entry.kind));
      break;
    }
    case "unstage": {
      const { taken, kept } = take(staged, paths);
      staged.length = 0;
      staged.push(...kept);
      for (const entry of taken) {
        if (entry.kind === "renamed" && entry.origPath) {
          merge(unstaged, moved(entry, "untracked"));
          merge(unstaged, { ...moved(entry, "deleted"), path: entry.origPath, additions: 0, deletions: entry.deletions });
        } else {
          merge(unstaged, moved(entry, entry.kind === "added" || entry.kind === "copied" ? "untracked" : entry.kind));
        }
      }
      break;
    }
    case "discard":
      unstaged = take(unstaged, paths).kept;
      break;
    case "resolve": {
      const { taken, kept } = take(conflicted, paths);
      conflicted = kept;
      for (const entry of taken) merge(staged, moved(entry, "modified"));
      break;
    }
  }
  return { ...status, staged: staged.sort(byPath), unstaged: unstaged.sort(byPath), conflicted };
}

export function applyOps(status: GitStatus, ops: readonly FileOp[]): GitStatus {
  return ops.reduce(applyOp, status);
}
