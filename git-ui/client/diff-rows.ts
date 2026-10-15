import type { ChangedLine, ContextLine, DiffLine, DiffSide, FileDiff, GitStatus, Side, StatusEntry, Token } from "../shared/git";
import { fileKey } from "../shared/git";
import { buildTreeRows, type GroupBy, type ViewMode } from "./changes-tree";

/** How many lines one ↑ or ↓ press reveals. */
export const EXPAND_STEP = 20;
/** Browsers' default `tab-size`. */
const TAB_SIZE = 8;

export type DiffLayout = "unified" | "split";

/** One side of a split row. */
export type Cell = { type: DiffLine["type"]; content: string; tokens: Token[] | null; no: number | null; noNewline: boolean };

export type BlockAction = "stage" | "unstage" | "discard";

/**
 * A run of changed lines inside a hunk, all staged or all unstaged: what Stage, Unstage and Restore act on.
 */
export type Block = {
  id: string;
  key: string;
  diff: FileDiff;
  hunkIndex: number;
  /** Indices into the hunk's lines, inclusive. */
  range: [number, number];
  kind: "add" | "remove" | "mixed";
  origin: Side;
  /** What to send to apply it. */
  lines: ChangedLine[];
  /** Being applied: shown as it will be, without actions. */
  pending?: boolean;
};

/** Identifies a block in a loaded diff, for showing it as applied until the diff is refetched. */
export const blockKey = (block: Pick<Block, "key" | "diff" | "hunkIndex" | "range">) =>
  `${block.key}#${block.diff.fingerprint}:${block.hunkIndex}:${block.range[0]}`;

const originOf = (diff: FileDiff, line: DiffLine): Side => line.origin ?? (diff.side === "staged" ? "staged" : "unstaged");

const blockCache = new WeakMap<FileDiff, Block[][]>();

/** Each hunk's blocks. Cached per diff, so rows keep pointing at the same block objects until it's refetched. */
export function blocksOf(diff: FileDiff): Block[][] {
  let blocks = blockCache.get(diff);
  if (blocks) return blocks;
  const key = fileKey(diff.side, diff.path);
  blocks = diff.hunks.map((hunk, hunkIndex) => {
    const found: Block[] = [];
    let start = -1;
    hunk.lines.forEach((line, i) => {
      if (line.type === "context") return;
      if (start < 0) start = i;
      const next = hunk.lines[i + 1];
      // A block ends before context, or where staged changes meet unstaged ones.
      const last = !next || next.type === "context" || originOf(diff, next) !== originOf(diff, line);
      if (!last) return;
      const changed = hunk.lines.slice(start, i + 1);
      const types = new Set(changed.map((other) => other.type));
      const kind = types.size > 1 ? "mixed" : types.has("add") ? "add" : "remove";
      const lines = changed.map((other): ChangedLine => ({
        type: other.type === "add" ? "add" : "remove",
        no: (other.type === "add" ? other.newNo : other.oldNo)!,
        content: other.content,
      }));
      found.push({ id: `${key}|h${hunkIndex}b${start}`, key, diff, hunkIndex, range: [start, i], kind, origin: originOf(diff, line), lines });
      start = -1;
    });
    return found;
  });
  blockCache.set(diff, blocks);
  return blocks;
}

export type Row =
  /** The file's diff shown: its staged or unstaged changes, or both combined. */
  | { kind: "section"; id: string; key: string; side: DiffSide; staged: StatusEntry | null; unstaged: StatusEntry | null; diff: FileDiff | null }
  | { kind: "notice"; id: string; key: string; text: string; force: boolean }
  | {
      kind: "line";
      id: string;
      type: DiffLine["type"];
      content: string;
      tokens: Token[] | null;
      oldNo: number | null;
      newNo: number | null;
      noNewline: boolean;
      digits: number;
      /** The block of changes the line is in; null for context. */
      block: Block | null;
      /** The block's first line, where its toolbar goes. */
      blockStart: boolean;
      blockEnd: boolean;
    }
  | { kind: "split"; id: string; left: Cell | null; right: Cell | null; digits: number; block: Block | null; blockStart: boolean; blockEnd: boolean }
  | {
      kind: "gap";
      id: string;
      key: string;
      diff: FileDiff;
      /** Hidden new-side lines, inclusive. */
      start: number;
      end: number;
      /** Reveal lines at the top of the gap (below the content above). */
      down: boolean;
      /** Reveal lines at the bottom of the gap (above the content below). */
      up: boolean;
      digits: number;
    };

export type Gap = {
  /** New-side lines, inclusive. Empty when start > end. */
  start: number;
  end: number;
  /** oldNo = newNo + offset for unchanged lines in this gap. */
  offset: number;
  /** Index of the hunk after the gap, or `hunks.length` for the gap after the last hunk. */
  before: number;
};

const lastLine = (start: number, count: number) => (count === 0 ? start : start + count - 1);
const firstLine = (start: number, count: number) => (count === 0 ? start + 1 : start);

/** The unchanged stretches around and between a diff's hunks, on the new side. */
export function gapsFor(diff: Pick<FileDiff, "hunks" | "newLineCount">): Gap[] {
  const gaps: Gap[] = [];
  let prevNew = 0;
  let prevOld = 0;
  diff.hunks.forEach((hunk, index) => {
    gaps.push({ start: prevNew + 1, end: firstLine(hunk.newStart, hunk.newCount) - 1, offset: prevOld - prevNew, before: index });
    prevNew = lastLine(hunk.newStart, hunk.newCount);
    prevOld = lastLine(hunk.oldStart, hunk.oldCount);
  });
  gaps.push({ start: prevNew + 1, end: diff.newLineCount, offset: prevOld - prevNew, before: diff.hunks.length });
  return gaps;
}

export function lineDigits(diff: FileDiff) {
  const last = diff.hunks.at(-1);
  const max = Math.max(diff.newLineCount, last ? last.oldStart + last.oldCount : 0, 1);
  return String(max).length;
}

function gapRows(
  key: string,
  diff: FileDiff,
  gap: Gap,
  revealed: ReadonlyMap<number, ContextLine> | undefined,
  digits: number,
): Row[] {
  const rows: Row[] = [];
  const trailing = gap.before === diff.hunks.length;
  let hiddenStart: number | null = null;
  const flushHidden = (end: number) => {
    if (hiddenStart === null) return;
    rows.push({
      kind: "gap",
      id: `${key}|gap${hiddenStart}`,
      key,
      diff,
      start: hiddenStart,
      end,
      down: hiddenStart > 1,
      up: !(trailing && end === gap.end),
      digits,
    });
    hiddenStart = null;
  };
  for (let n = gap.start; n <= gap.end; n++) {
    const line = revealed?.get(n);
    if (!line) {
      hiddenStart ??= n;
      continue;
    }
    flushHidden(n - 1);
    rows.push({
      kind: "line",
      id: `${key}|ctx${n}`,
      type: "context",
      content: line.content,
      tokens: line.tokens,
      oldNo: n + gap.offset,
      newNo: n,
      noNewline: false,
      digits,
      block: null,
      blockStart: false,
      blockEnd: false,
    });
  }
  flushHidden(gap.end);
  return rows;
}

const NOTICES: Partial<Record<FileDiff["status"], string>> = {
  binary: "Binary file not shown.",
  unsupported: "No text changes to show (mode change or submodule).",
  empty: "No changes.",
};

function noticeFor(diff: FileDiff) {
  if (diff.status === "error") return `Couldn't read this diff: ${diff.message ?? "git failed"}`;
  if (diff.status === "empty" && diff.message) return diff.message;
  if (diff.status === "empty" && diff.isNew) return "Empty file.";
  return NOTICES[diff.status];
}

function fileRows(
  key: string,
  diff: FileDiff,
  revealed: ReadonlyMap<number, ContextLine> | undefined,
  pendingBlocks: ReadonlyMap<string, BlockAction>,
  digits: number,
): Row[] {
  const notice = noticeFor(diff);
  if (notice) return [{ kind: "notice", id: `${key}|notice`, key, text: notice, force: false }];
  if (diff.status === "too_large") {
    return [
      {
        kind: "notice",
        id: `${key}|notice`,
        key,
        text: `Large diff not shown (${diff.additions + diff.deletions} changed lines).`,
        force: true,
      },
    ];
  }
  const gaps = gapsFor(diff);
  const rows: Row[] = [];
  diff.hunks.forEach((hunk, index) => {
    rows.push(...gapRows(key, diff, gaps[index], revealed, digits));
    const blockAt = new Map<number, Block>();
    for (const block of blocksOf(diff)[index]) for (let j = block.range[0]; j <= block.range[1]; j++) blockAt.set(j, block);
    hunk.lines.forEach((line, j) => {
      const id = `${key}|h${index}l${j}`;
      const block = blockAt.get(j) ?? null;
      const pending = block && pendingBlocks.get(blockKey(block));
      const edges = { blockStart: block !== null && block.range[0] === j, blockEnd: block !== null && block.range[1] === j };
      if (pending && diff.side === "combined" && pending !== "discard") {
        // Staging or unstaging only moves a combined diff's lines to the other side.
        rows.push({ kind: "line", id, ...line, digits, block: pendingBlock(block, pending), ...edges });
        return;
      }
      if (pending) {
        // Shown as it will be until the diff is refetched: staging keeps the additions, restoring or unstaging keeps
        // the removals, either way as unchanged lines. It comes back if git refuses.
        if (line.type === (pending === "stage" ? "add" : "remove")) {
          rows.push({ kind: "line", id, ...line, type: "context", digits, block: null, blockStart: false, blockEnd: false });
        }
        return;
      }
      rows.push({ kind: "line", id, ...line, digits, block, ...edges });
    });
  });
  rows.push(...gapRows(key, diff, gaps[diff.hunks.length], revealed, digits));
  return rows;
}

const pendingCopies = new WeakMap<Block, Block>();

/** A block being staged or unstaged, shown on the side it's moving to. One copy per block, so rows stay equal. */
function pendingBlock(block: Block, action: BlockAction): Block {
  let copy = pendingCopies.get(block);
  if (!copy) pendingCopies.set(block, (copy = { ...block, origin: action === "stage" ? "staged" : "unstaged", pending: true }));
  return copy;
}

const cell = (line: Pick<DiffLine, "type" | "content" | "tokens" | "noNewline">, no: number | null): Cell => ({
  type: line.type,
  content: line.content,
  tokens: line.tokens,
  no,
  noNewline: line.noNewline,
});

/**
 * Side-by-side pairs for a run of diff lines: context lines on both sides, and each run of removals beside the
 * additions that follow it, padded with blanks on the shorter side.
 */
export function splitPairs<Line extends { type: DiffLine["type"] }>(lines: readonly Line[]) {
  const pairs: [Line | null, Line | null][] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "context") {
      pairs.push([line, line]);
      i += 1;
      continue;
    }
    const removed: Line[] = [];
    while (i < lines.length && lines[i].type === "remove") removed.push(lines[i]), (i += 1);
    const added: Line[] = [];
    while (i < lines.length && lines[i].type === "add") added.push(lines[i]), (i += 1);
    for (let k = 0; k < Math.max(removed.length, added.length); k++) pairs.push([removed[k] ?? null, added[k] ?? null]);
  }
  return pairs;
}

/** Replaces each run of line rows with split rows. */
function toSplit(rows: Row[]): Row[] {
  const out: Row[] = [];
  let run: RowOf<"line">[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const ids = run.map((row) => row.id);
    // Pairs never outnumber lines, so each takes the id of a distinct line.
    splitPairs(run).forEach(([left, right], i) => {
      const line = (left ?? right)!;
      out.push({
        kind: "split",
        id: `${ids[i]}|s`,
        left: left && cell(left, left.oldNo),
        right: right && cell(right, right.newNo),
        digits: line.digits,
        block: line.block,
        blockStart: !!(left?.blockStart || right?.blockStart),
        blockEnd: !!(left?.blockEnd || right?.blockEnd),
      });
    });
    run = [];
  };
  for (const row of rows) {
    if (row.kind === "line") run.push(row);
    else flush(), out.push(row);
  }
  flush();
  return out;
}

type RowOf<Kind extends Row["kind"]> = Extract<Row, { kind: Kind }>;

/** How many columns text takes in a monospace font, with tabs expanded to tab stops. */
export function textColumns(text: string) {
  let columns = 0;
  for (const char of text) columns = char === "	" ? columns + TAB_SIZE - (columns % TAB_SIZE) : columns + 1;
  return columns;
}

/** The widest line on each side, in columns, for scrolling unwrapped lines. Unified rows count as the left side. */
export function maxColumns(rows: readonly Row[]) {
  let left = 0;
  let right = 0;
  for (const row of rows) {
    if (row.kind === "line") left = Math.max(left, textColumns(row.content));
    else if (row.kind === "split") {
      left = Math.max(left, textColumns(row.left?.content ?? ""));
      right = Math.max(right, textColumns(row.right?.content ?? ""));
    }
  }
  return { left, right };
}

/** A file's staged and unstaged entries. */
export function entriesFor(status: GitStatus | null, path: string | null) {
  const find = (entries: StatusEntry[] | undefined) => (path === null ? null : (entries?.find((entry) => entry.path === path) ?? null));
  return { staged: find(status?.staged), unstaged: find(status?.unstaged) };
}

/**
 * What the Diff panel shows: a file's staged or unstaged changes (`side`), or with `side` null both, in one
 * combined diff.
 */
export type DiffItem = { path: string; side: Side | null };

export const itemKey = (item: DiffItem) => `${item.side ?? "all"}:${item.path}`;

/** The diff an item shows. */
export function diffKeyOf(item: DiffItem) {
  return fileKey(item.side ?? "combined", item.path);
}

/** The rows of an item's diff: a header with the file's checkbox, then its changes. */
export function buildFileRows(
  state: {
    status: GitStatus | null;
    diffs: ReadonlyMap<string, FileDiff>;
    context: ReadonlyMap<string, ReadonlyMap<number, ContextLine>>;
    pendingBlocks: ReadonlyMap<string, BlockAction>;
  },
  item: DiffItem | null,
  layout: DiffLayout,
): Row[] {
  if (!item) return [];
  const { staged, unstaged } = entriesFor(state.status, item.path);
  const shown = item.side === "staged" ? staged : item.side === "unstaged" ? unstaged : (unstaged ?? staged);
  if (!shown) return [];
  const side: DiffSide = item.side ?? "combined";
  const key = diffKeyOf(item);
  const diff = state.diffs.get(key) ?? null;
  const rows: Row[] = [
    { kind: "section", id: `section:${key}`, key, side, staged: item.side === "unstaged" ? null : staged, unstaged: item.side === "staged" ? null : unstaged, diff },
  ];
  if (!diff) rows.push({ kind: "notice", id: `${key}|loading`, key, text: "Loading…", force: false });
  else rows.push(...fileRows(key, diff, state.context.get(key), state.pendingBlocks, lineDigits(diff)));
  return layout === "split" ? toSplit(rows) : rows;
}

/**
 * What the Diff panel steps through, in the order the Changes panel shows it. Grouped by staged and unstaged, each
 * side of a file is its own item; otherwise each file is one item showing both. Conflicted files aren't included:
 * they have no diff to show.
 */
export function navigationItems(status: GitStatus | null, view: ViewMode, groupBy: GroupBy): DiffItem[] {
  const items = new Map<string, DiffItem>();
  for (const row of buildTreeRows(status, { view, groupBy, collapsed: new Set() })) {
    if (row.kind !== "file" || !(row.item.staged || row.item.unstaged)) continue;
    const item: DiffItem = { path: row.item.path, side: groupBy === "staged" ? (row.item.staged ? "staged" : "unstaged") : null };
    items.set(itemKey(item), item);
  }
  return [...items.values()];
}

/** The range ↑ / ↓ / "show all" reveals in a gap row. */
export function expansionRange(row: { start: number; end: number }, direction: "up" | "down" | "all") {
  if (direction === "all" || row.end - row.start + 1 <= EXPAND_STEP) return { start: row.start, end: row.end };
  return direction === "down"
    ? { start: row.start, end: row.start + EXPAND_STEP - 1 }
    : { start: row.end - EXPAND_STEP + 1, end: row.end };
}
