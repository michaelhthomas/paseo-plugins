import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import {
  commitRpc,
  diffRpc,
  fileKey,
  filesRpc,
  changeRpc,
  lastCommitMessageRpc,
  linesRpc,
  statusRpc,
  type ContextLine,
  type FileDiff,
  type GitStatus,
  type Hunk,
  type MutationResult,
  type DiffSide,
  type StatusEntry,
} from "../shared/git";
import { allFolderKeys, collapseKey, type GroupBy, type GroupId } from "./changes-tree";
import { blockKey, diffKeyOf, type Block, type BlockAction, type DiffItem } from "./diff-rows";
import { applyOps, OPTIMISTIC_STAMP, type FileAction, type FileOp } from "./optimistic";

const STATUS_POLL_MS = 2_000;
const DIFF_BATCH = 20;

export type { FileAction };
export type HunkAction = BlockAction;
export type CommitMode = "staged" | "all" | "amend";

/** Per-workspace state shared by the Changes and Diff panels. Mutated in place; `version` bumps on every change. */
export type RepoState = {
  /** Status as shown: the daemon's, with in-flight file operations already applied. */
  status: GitStatus | null;
  statusError: string | null;
  diffs: Map<string, FileDiff>;
  loading: Set<string>;
  forced: Set<string>;
  /** Revealed context lines per file, by new-side line number. */
  context: Map<string, Map<number, ContextLine>>;
  /** Collapsed groups and folders in the Changes panel (`collapseKey`). Replaced, not mutated, so it can be a memo key. */
  treeCollapsed: ReadonlySet<string>;
  /** Blocks being staged, unstaged or restored (`blockKey`), shown as they will be until their diff is refetched. */
  pendingBlocks: Map<string, BlockAction>;
  draft: { message: string; mode: CommitMode };
  /** A file opened from the Changes panel, for the Diff panel to show and take keyboard focus for. */
  focus: DiffItem | null;
  /** The path the Diff panel shows. */
  selected: DiffItem | null;
  /** Load each side's diff (the Changes panel groups by staged and unstaged) or one combined diff per file. */
  diffMode: DiffMode;
  /** Diffs are loaded with `git diff -w`. */
  ignoreWhitespace: boolean;
  committing: boolean;
};

type PendingOp = {
  op: FileOp;
  /** Set once the daemon has answered: status requests numbered above this one include the change. */
  after: number | null;
};

type Internal = {
  state: RepoState;
  /** The daemon's last status, before optimistic operations. */
  server: GitStatus | null;
  pending: PendingOp[];
  version: number;
  listeners: Set<() => void>;
  holders: number;
  diffHolders: number;
  timer: ReturnType<typeof setTimeout> | null;
  statusRequest: Promise<void> | null;
  requestSeq: number;
  /** Numbers diff requests, so a change is only taken as shown once a diff requested after it arrives. */
  diffSeq: number;
  /** For each pending block (`blockKey`), the last diff request started before it was applied; null while in flight. */
  pendingAfter: Map<string, number | null>;
  /** The diffs the Diff panel steps through, in its order (`diffKeyOf` each item), for loading nearest first. */
  order: string[];
  /** A Diff panel is on screen (Paseo keeps background tabs mounted, at zero size). */
  diffVisible: boolean;
  appliedSeq: number;
  diffRun: Promise<void> | null;
  diffAgain: boolean;
  /** File and hunk mutations run one at a time, in the order the user made them. */
  queue: Promise<unknown>;
};

export type DiffMode = "combined" | "separate";

/** A diff to load: one side of a file, or the file's combined diff. */
export type DiffTarget = { key: string; path: string; side: DiffSide; origPath: string | null; untracked: boolean; stamp: string; optimistic: boolean };

/** The diffs the Diff panel can show in a mode. */
export function diffTargets(status: GitStatus | null, mode: DiffMode): DiffTarget[] {
  if (!status) return [];
  if (mode === "separate") {
    return [
      ...status.staged.map((entry) => ({ side: "staged" as const, entry })),
      ...status.unstaged.map((entry) => ({ side: "unstaged" as const, entry })),
    ].map(({ side, entry }) => ({
      key: fileKey(side, entry.path),
      path: entry.path,
      side,
      origPath: side === "staged" ? entry.origPath : null,
      untracked: entry.kind === "untracked",
      stamp: entry.stamp,
      optimistic: entry.stamp === OPTIMISTIC_STAMP,
    }));
  }
  const byPath = new Map<string, { staged: StatusEntry | null; unstaged: StatusEntry | null }>();
  for (const staged of status.staged) byPath.set(staged.path, { staged, unstaged: null });
  for (const unstaged of status.unstaged) byPath.set(unstaged.path, { staged: byPath.get(unstaged.path)?.staged ?? null, unstaged });
  return [...byPath].map(([path, { staged, unstaged }]) => ({
    key: fileKey("combined", path),
    path,
    side: "combined" as const,
    origPath: staged?.origPath ?? null,
    untracked: !staged && unstaged?.kind === "untracked",
    // Either side changing changes the combined diff.
    stamp: `${staged?.stamp ?? ""}|${unstaged?.stamp ?? ""}`,
    optimistic: staged?.stamp === OPTIMISTIC_STAMP || unstaged?.stamp === OPTIMISTIC_STAMP,
  }));
}

/**
 * Targets ordered by how far they are from the shown one in `order` (the Diff panel's), the next file before the
 * previous at each distance. Targets not in the order go last.
 */
export function byDistance(targets: readonly DiffTarget[], order: readonly string[], shown: string | null): DiffTarget[] {
  const position = new Map(order.map((key, index) => [key, index]));
  const center = (shown !== null ? position.get(shown) : undefined) ?? 0;
  const rank = (target: DiffTarget) => {
    const at = position.get(target.key);
    if (at === undefined) return Number.MAX_SAFE_INTEGER;
    const distance = Math.abs(at - center);
    return distance * 2 - (at > center ? 1 : 0);
  };
  return [...targets].sort((a, b) => rank(a) - rank(b));
}

/** The file status change a block's action makes: the whole side when it's the side's last change, else part of it. */
export function statusOp(block: Block, action: HunkAction): FileOp {
  const { diff } = block;
  const onSide = diff.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.type !== "context" && (line.origin ?? diff.side) === block.origin).length;
  if (onSide <= block.lines.length) return { action, paths: [diff.path] };
  const additions = block.lines.filter((line) => line.type === "add").length;
  return { action: `${action}-part`, paths: [diff.path], additions, deletions: block.lines.length - additions };
}

/**
 * Staging from the unstaged diff turns the block's additions, and its hunk's context, into unchanged lines at the same
 * working-tree line numbers. Revealing them keeps them on screen once the refetched diff leaves them out of its hunks.
 */
function keepRevealed(state: RepoState, block: Block, action: HunkAction) {
  if (block.diff.side !== "unstaged" || action !== "stage") return;
  const hunk = block.diff.hunks[block.hunkIndex];
  let lines = state.context.get(block.key);
  if (!lines) state.context.set(block.key, (lines = new Map()));
  hunk.lines.forEach((line, i) => {
    const inBlock = i >= block.range[0] && i <= block.range[1];
    if (line.newNo !== null && (line.type === "context" || (inBlock && line.type === "add"))) {
      lines.set(line.newNo, { content: line.content, tokens: line.tokens });
    }
  });
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createRepoStore(client: Pick<PluginClientContext, "rpc">) {
  const repos = new Map<string, Internal>();

  const repoFor = (workspaceId: string) => {
    let repo = repos.get(workspaceId);
    if (!repo) {
      repo = {
        state: {
          status: null,
          statusError: null,
          diffs: new Map(),
          loading: new Set(),
          forced: new Set(),
          context: new Map(),
          treeCollapsed: new Set(),
          pendingBlocks: new Map(),
          draft: { message: "", mode: "staged" },
          focus: null,
          selected: null,
          ignoreWhitespace: false,
          diffMode: "combined",
          committing: false,
        },
        server: null,
        pending: [],
        version: 0,
        listeners: new Set(),
        holders: 0,
        diffHolders: 0,
        timer: null,
        statusRequest: null,
        requestSeq: 0,
        diffSeq: 0,
        pendingAfter: new Map(),
        order: [],
        diffVisible: false,
        appliedSeq: 0,
        diffRun: null,
        diffAgain: false,
        queue: Promise.resolve(),
      };
      repos.set(workspaceId, repo);
    }
    return repo;
  };

  const notify = (repo: Internal) => {
    repo.version += 1;
    for (const listener of repo.listeners) listener();
  };

  /** Recomputes the shown status from the daemon's plus the operations still in flight. */
  const recompute = (repo: Internal) => {
    const { state } = repo;
    state.status = repo.server && repo.server.isRepo ? applyOps(repo.server, repo.pending.map((pending) => pending.op)) : repo.server;
  };

  const loadStatus = (workspaceId: string, { fresh = false }: { fresh?: boolean } = {}): Promise<void> => {
    const repo = repoFor(workspaceId);
    // A request already in flight may have started before the change we want to see.
    if (repo.statusRequest && !fresh) return repo.statusRequest;
    const seq = ++repo.requestSeq;
    const request = client
      .rpc(statusRpc, { workspaceId })
      .then(
        (status) => {
          // Ignore answers that arrive after a newer one.
          if (seq < repo.appliedSeq) return;
          repo.appliedSeq = seq;
          const before = repo.pending.length;
          repo.pending = repo.pending.filter((pending) => pending.after === null || seq <= pending.after);
          const changed = repo.server?.revision !== status.revision || repo.state.statusError !== null || repo.pending.length !== before;
          if (!changed) return;
          repo.server = status;
          repo.state.statusError = null;
          recompute(repo);
          const live = new Set(diffTargets(repo.state.status, repo.state.diffMode).map((target) => target.key));
          for (const key of [...repo.state.diffs.keys()]) {
            if (live.has(key)) continue;
            repo.state.diffs.delete(key);
            repo.state.context.delete(key);
            repo.state.forced.delete(key);
          }
          notify(repo);
          if (repo.diffHolders > 0) void loadDiffs(workspaceId);
        },
        (error: unknown) => {
          const message = errorMessage(error);
          if (repo.state.statusError !== message) {
            repo.state.statusError = message;
            notify(repo);
          }
        },
      )
      .finally(() => {
        if (repo.statusRequest === request) repo.statusRequest = null;
      });
    repo.statusRequest = request;
    return request;
  };

  const schedule = (workspaceId: string) => {
    const repo = repoFor(workspaceId);
    if (repo.timer) clearTimeout(repo.timer);
    repo.timer = setTimeout(async () => {
      repo.timer = null;
      if (repo.holders === 0) return;
      await loadStatus(workspaceId);
      if (repo.holders > 0) schedule(workspaceId);
    }, STATUS_POLL_MS);
  };

  /** Loads diffs whose status stamp changed, in display order, a batch at a time. */
  /** Loads some diffs in one request. Returns false if the request failed. */
  const fetchDiffs = async (workspaceId: string, batch: readonly DiffTarget[]): Promise<boolean> => {
    const repo = repoFor(workspaceId);
    const { state } = repo;
    const keys = batch.map((target) => target.key);
    for (const key of keys) state.loading.add(key);
    notify(repo);
    const ignoreWhitespace = state.ignoreWhitespace;
    const seq = ++repo.diffSeq;
    try {
      const { files } = await client.rpc(diffRpc, {
        workspaceId,
        ignoreWhitespace,
        files: batch.map(({ path, side, origPath, untracked, stamp, key }) => ({ path, side, origPath, untracked, stamp, force: state.forced.has(key) })),
      });
      // Loaded for the other whitespace mode; they're loaded again.
      for (const diff of state.ignoreWhitespace === ignoreWhitespace ? files : []) {
        const key = fileKey(diff.side, diff.path);
        const previous = state.diffs.get(key);
        // Revealed lines are numbered on the new side; they stay right while its content does. Staging leaves the
        // working tree alone, so unstaged and combined diffs keep everything that was expanded.
        if (previous && (!diff.newSideHash || previous.newSideHash !== diff.newSideHash)) state.context.delete(key);
        state.diffs.set(key, diff);
        // A diff requested after a change was applied shows it; one requested before may not, so the change stays
        // shown as pending until then.
        for (const pending of [...state.pendingBlocks.keys()]) {
          const after = repo.pendingAfter.get(pending);
          if (!pending.startsWith(`${key}#`) || after === null || (after !== undefined && seq <= after)) continue;
          state.pendingBlocks.delete(pending);
          repo.pendingAfter.delete(pending);
        }
      }
      return true;
    } catch (error) {
      console.error("[git-ui] loading diffs failed", error);
      return false;
    } finally {
      for (const key of keys) state.loading.delete(key);
      notify(repo);
    }
  };

  /** Diffs that need loading: missing or out of date, and not already on the way. */
  const wantedDiffs = (repo: Internal) => {
    const { state } = repo;
    return diffTargets(state.status, state.diffMode).filter(
      // Optimistic entries have no diff on the daemon yet.
      (target) => !target.optimistic && !state.loading.has(target.key) && state.diffs.get(target.key)?.stamp !== target.stamp,
    );
  };

  /**
   * Loads every diff the Diff panel can show, a batch at a time, nearest the shown file first: the files either side
   * of it in the Changes panel's order are ready before the user steps to them.
   */
  const loadDiffs = (workspaceId: string): Promise<void> => {
    const repo = repoFor(workspaceId);
    if (repo.diffRun) {
      repo.diffAgain = true;
      return repo.diffRun;
    }
    const run = async () => {
      for (;;) {
        const wanted = byDistance(wantedDiffs(repo), repo.order, repo.state.selected && diffKeyOf(repo.state.selected));
        if (wanted.length === 0) {
          if (!repo.diffAgain) return;
          repo.diffAgain = false;
          continue;
        }
        // Retry on the next status change rather than spinning.
        if (!(await fetchDiffs(workspaceId, wanted.slice(0, DIFF_BATCH)))) return;
      }
    };
    repo.diffRun = run().finally(() => (repo.diffRun = null));
    return repo.diffRun;
  };

  /** Loads the shown file's diff by itself, straight away, if it isn't loaded or on the way. */
  const loadSelected = (workspaceId: string) => {
    const repo = repoFor(workspaceId);
    const selected = repo.state.selected;
    if (repo.diffHolders === 0 || !selected) return;
    const key = diffKeyOf(selected);
    const target = wantedDiffs(repo).find((candidate) => candidate.key === key);
    if (target) void fetchDiffs(workspaceId, [target]);
  };

  const enqueue = <T>(repo: Internal, task: () => Promise<T>): Promise<T> => {
    const run = repo.queue.then(task, task);
    repo.queue = run.catch(() => undefined);
    return run;
  };

  const failure = (error: unknown): MutationResult => ({ ok: false, reason: "error", message: errorMessage(error) });

  const setDraft = (workspaceId: string, patch: Partial<RepoState["draft"]>) => {
    const repo = repoFor(workspaceId);
    repo.state.draft = { ...repo.state.draft, ...patch };
    notify(repo);
  };

  return {
    get(workspaceId: string): RepoState {
      return repoFor(workspaceId).state;
    },

    subscribe(workspaceId: string, listener: () => void) {
      const repo = repoFor(workspaceId);
      repo.listeners.add(listener);
      return () => {
        repo.listeners.delete(listener);
      };
    },

    version(workspaceId: string) {
      return repoFor(workspaceId).version;
    },

    /** Keeps status polling while held. `diffs` also keeps diffs loaded. Returns the release function. */
    retain(workspaceId: string, { diffs = false }: { diffs?: boolean } = {}) {
      const repo = repoFor(workspaceId);
      repo.holders += 1;
      if (diffs) repo.diffHolders += 1;
      void loadStatus(workspaceId).then(() => {
        if (diffs) void loadDiffs(workspaceId);
      });
      schedule(workspaceId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        repo.holders -= 1;
        if (diffs) repo.diffHolders -= 1;
        if (repo.holders === 0 && repo.timer) {
          clearTimeout(repo.timer);
          repo.timer = null;
        }
      };
    },

    refresh(workspaceId: string) {
      return loadStatus(workspaceId, { fresh: true });
    },

    /**
     * Stages, unstages, discards or resolves files. The panels show the result immediately; the daemon's next status
     * replaces it, and a failure puts the files back.
     */
    files(workspaceId: string, entries: readonly StatusEntry[], action: FileAction): Promise<MutationResult> {
      const repo = repoFor(workspaceId);
      const shown = entries.map((entry) => entry.path);
      // Unstaging a rename has to restore both paths.
      const paths = [...new Set(entries.flatMap((entry) => (action === "unstage" && entry.origPath ? [entry.path, entry.origPath] : [entry.path])))];
      const pending: PendingOp = { op: { action, paths: shown }, after: null };
      repo.pending.push(pending);
      recompute(repo);
      notify(repo);
      return enqueue(repo, async () => {
        const result = await client.rpc(filesRpc, { workspaceId, paths, action }).catch(failure);
        if (result.ok) pending.after = repo.requestSeq;
        else repo.pending = repo.pending.filter((other) => other !== pending);
        recompute(repo);
        notify(repo);
        void loadStatus(workspaceId, { fresh: true });
        return result;
      });
    },

    /**
     * Applies one block of changes. The diff shows it as applied immediately, and the file's status changes with it;
     * both come back if the daemon refuses. The diff isn't reloaded from scratch: the refetched one keeps what was
     * expanded, so nothing on screen moves.
     */
    block(workspaceId: string, block: Block, action: HunkAction): Promise<MutationResult> {
      const repo = repoFor(workspaceId);
      const { state } = repo;
      const { diff } = block;
      const pending = blockKey(block);
      state.pendingBlocks.set(pending, action);
      repo.pendingAfter.set(pending, null);
      keepRevealed(state, block, action);
      const op: PendingOp = { op: statusOp(block, action), after: null };
      repo.pending.push(op);
      recompute(repo);
      notify(repo);
      return enqueue(repo, async () => {
        const result = await client
          .rpc(changeRpc, { workspaceId, path: diff.path, origPath: diff.oldPath, view: diff.side, origin: block.origin, action, lines: block.lines })
          .catch(failure);
        if (result.ok) {
          repo.pendingAfter.set(pending, repo.diffSeq);
          op.after = repo.requestSeq;
        } else {
          state.pendingBlocks.delete(pending);
          repo.pendingAfter.delete(pending);
          repo.pending = repo.pending.filter((other) => other !== op);
        }
        recompute(repo);
        notify(repo);
        void loadStatus(workspaceId, { fresh: true });
        return result;
      });
    },

    async commit(workspaceId: string) {
      const repo = repoFor(workspaceId);
      const { message, mode } = repo.state.draft;
      repo.state.committing = true;
      notify(repo);
      try {
        // After any staging still in flight.
        const result = await enqueue(repo, () =>
          client.rpc(commitRpc, { workspaceId, message: message.trim(), amend: mode === "amend", all: mode === "all" }),
        );
        if (result.ok) setDraft(workspaceId, { message: "", mode: mode === "amend" ? "staged" : mode });
        return result;
      } catch (error) {
        return { ok: false, sha: null, message: errorMessage(error) };
      } finally {
        repo.state.committing = false;
        notify(repo);
        await loadStatus(workspaceId, { fresh: true });
      }
    },

    setDraft,

    async lastCommitMessage(workspaceId: string) {
      try {
        return (await client.rpc(lastCommitMessageRpc, { workspaceId })).message;
      } catch {
        return null;
      }
    },

    /** Reveals new-side lines `start`..`end` of a file's diff. */
    async expand(workspaceId: string, diff: FileDiff, start: number, end: number) {
      if (end < start) return;
      const repo = repoFor(workspaceId);
      const key = fileKey(diff.side, diff.path);
      const result = await client.rpc(linesRpc, { workspaceId, path: diff.path, side: diff.side, start, end });
      // The file may have changed while the lines were loading.
      if (repo.state.diffs.get(key)?.newSideHash !== diff.newSideHash) return;
      let lines = repo.state.context.get(key);
      if (!lines) repo.state.context.set(key, (lines = new Map()));
      result.lines.forEach((line, i) => lines.set(result.start + i, line));
      notify(repo);
    },

    /** Reloads every diff with or without `-w`. */
    setIgnoreWhitespace(workspaceId: string, ignoreWhitespace: boolean) {
      const repo = repoFor(workspaceId);
      const { state } = repo;
      if (state.ignoreWhitespace === ignoreWhitespace) return;
      state.ignoreWhitespace = ignoreWhitespace;
      state.diffs.clear();
      state.context.clear();
      state.pendingBlocks.clear();
      notify(repo);
      if (repo.diffHolders > 0) void loadDiffs(workspaceId);
    },

    /** Hides every revealed context line again. */
    clearContext(workspaceId: string) {
      const repo = repoFor(workspaceId);
      if (repo.state.context.size === 0) return;
      repo.state.context.clear();
      notify(repo);
    },

    toggleTree(workspaceId: string, group: GroupId, dirPath?: string) {
      const repo = repoFor(workspaceId);
      const key = collapseKey(group, dirPath);
      const next = new Set(repo.state.treeCollapsed);
      if (!next.delete(key)) next.add(key);
      repo.state.treeCollapsed = next;
      notify(repo);
    },

    /** Collapses or expands every folder in the Changes panel; groups stay as they are. */
    setAllFoldersCollapsed(workspaceId: string, groupBy: GroupBy, collapsed: boolean) {
      const repo = repoFor(workspaceId);
      // Group keys end in ":"; they stay.
      const next = new Set([...repo.state.treeCollapsed].filter((key) => key.endsWith(":")));
      if (collapsed) for (const key of allFolderKeys(repo.state.status, groupBy)) next.add(key);
      repo.state.treeCollapsed = next;
      notify(repo);
    },

    /** Loads a diff that came back too large. */
    force(workspaceId: string, key: string) {
      const repo = repoFor(workspaceId);
      repo.state.forced.add(key);
      repo.state.diffs.delete(key);
      notify(repo);
      void loadDiffs(workspaceId);
    },

    /** The Diff panel reports whether it's on screen. Doesn't notify. */
    setDiffVisible(workspaceId: string, visible: boolean) {
      repoFor(workspaceId).diffVisible = visible;
    },

    /** Whether a Diff panel is on screen, so opening a file needn't ask Paseo to show it. */
    isDiffVisible(workspaceId: string) {
      return repoFor(workspaceId).diffVisible;
    },

    /** Tells the store the Diff panel's order, so diffs load nearest the shown file first. Doesn't notify. */
    setOrder(workspaceId: string, order: string[]) {
      repoFor(workspaceId).order = order;
    },

    /** Loads each side's diff, or one combined diff per file. */
    setDiffMode(workspaceId: string, diffMode: DiffMode) {
      const repo = repoFor(workspaceId);
      if (repo.state.diffMode === diffMode) return;
      repo.state.diffMode = diffMode;
      notify(repo);
      if (repo.diffHolders > 0) void loadDiffs(workspaceId);
    },

    /** Opens a file from the Changes panel: the Diff panel shows it and takes keyboard focus. */
    focus(workspaceId: string, item: DiffItem) {
      const repo = repoFor(workspaceId);
      repo.state.focus = item;
      repo.state.selected = item;
      notify(repo);
      loadSelected(workspaceId);
    },

    /** Shows another file in the Diff panel. */
    select(workspaceId: string, item: DiffItem) {
      const repo = repoFor(workspaceId);
      const { selected } = repo.state;
      if (selected?.path === item.path && selected.side === item.side) return;
      repo.state.selected = item;
      notify(repo);
      loadSelected(workspaceId);
    },

    /** Clears the focus request once the Diff panel has handled it. */
    clearFocus(workspaceId: string) {
      const repo = repoFor(workspaceId);
      if (repo.state.focus === null) return;
      repo.state.focus = null;
      notify(repo);
    },
  };
}

export type RepoStore = ReturnType<typeof createRepoStore>;

/** Re-renders on every change to the workspace's repo state. */
export function useRepo(store: RepoStore, workspaceId: string) {
  const version = useSyncExternalStore(
    (listener) => store.subscribe(workspaceId, listener),
    () => store.version(workspaceId),
    () => store.version(workspaceId),
  );
  return { state: store.get(workspaceId), version };
}
