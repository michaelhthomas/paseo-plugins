import { describe, expect, it } from "vitest";
import type { ContextLine, DiffLine, FileDiff, Hunk } from "../shared/git";
import { blockKey, blocksOf, buildFileRows, expansionRange, gapsFor, navigationItems, splitPairs, textColumns, type Row } from "../client/diff-rows";

const hunk = (oldStart: number, oldCount: number, newStart: number, newCount: number): Hunk => ({
  oldStart,
  oldCount,
  newStart,
  newCount,
  header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
  hash: `${oldStart}`,
  lines: [],
});

const diff = (hunks: Hunk[], newLineCount: number): FileDiff => ({
  path: "a.ts",
  side: "unstaged",
  oldPath: null,
  stamp: "s",
  status: "ok",
  isNew: false,
  isDeleted: false,
  patchable: true,
  fingerprint: "f",
  newSideHash: "n",
  additions: 0,
  deletions: 0,
  hunks,
  newLineCount,
  message: null,
});

describe("gapsFor", () => {
  it("covers the top, the middle and the end of the file", () => {
    // Line 6 replaced by two lines; line 31 deleted.
    expect(gapsFor(diff([hunk(3, 7, 3, 8), hunk(28, 6, 29, 5)], 60))).toEqual([
      { start: 1, end: 2, offset: 0, before: 0 },
      { start: 11, end: 28, offset: -1, before: 1 },
      { start: 34, end: 60, offset: 0, before: 2 },
    ]);
  });

  it("handles zero-count hunks", () => {
    // Pure insertion after old line 5; pure deletion of old line 20 (after new line 20).
    expect(gapsFor(diff([hunk(5, 0, 6, 2), hunk(20, 1, 21, 0)], 40))).toEqual([
      { start: 1, end: 5, offset: 0, before: 0 },
      { start: 8, end: 21, offset: -2, before: 1 },
      { start: 22, end: 40, offset: -1, before: 2 },
    ]);
  });

  it("leaves no gaps for a whole new file", () => {
    const gaps = gapsFor(diff([hunk(0, 0, 1, 3)], 3));
    expect(gaps.every((gap) => gap.start > gap.end)).toBe(true);
  });
});

describe("buildFileRows", () => {
  const status = {
    isRepo: true,
    branch: "main",
    upstream: null,
    detached: false,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [{ path: "a.ts", origPath: null, kind: "modified" as const, stamp: "s", additions: 1, deletions: 1 }],
    conflicted: [],
    revision: "r",
  };

  it("splits a gap around revealed lines and numbers both sides", () => {
    const file = diff([hunk(3, 7, 3, 8), hunk(28, 6, 29, 5)], 60);
    const revealed = new Map<number, ContextLine>([[15, { content: "fifteen", tokens: null }]]);
    const rows = buildFileRows({ status, diffs: new Map([["unstaged:a.ts", file]]), context: new Map([["unstaged:a.ts", revealed]]), pendingBlocks: new Map() }, { path: "a.ts", side: "unstaged" as const }, "unified");
    const middle = rows.filter((row) => (row.kind === "gap" && row.start >= 11 && row.end <= 28) || (row.kind === "line" && row.newNo === 15));
    expect(middle.map((row) => (row.kind === "gap" ? [row.start, row.end, row.down, row.up] : [row.kind === "line" && row.oldNo, row.kind === "line" && row.newNo]))).toEqual([
      [11, 14, true, true],
      [14, 15],
      [16, 28, true, true],
    ]);
    const first = rows.find((row): row is Extract<Row, { kind: "gap" }> => row.kind === "gap")!;
    expect([first.start, first.end, first.down, first.up]).toEqual([1, 2, false, true]);
    const last = rows.filter((row): row is Extract<Row, { kind: "gap" }> => row.kind === "gap").at(-1)!;
    expect([last.start, last.end, last.down, last.up]).toEqual([34, 60, true, false]);
  });

  it("shows one side of a file, or both combined", () => {
    const both = { ...status, staged: status.unstaged };
    const empty = { diffs: new Map(), context: new Map(), pendingBlocks: new Map() };
    const sections = (item: { path: string; side: "staged" | "unstaged" | null }) =>
      buildFileRows({ status: both, ...empty }, item, "unified").flatMap((row) => (row.kind === "section" ? [[row.key, !!row.staged, !!row.unstaged]] : []));
    expect(sections({ path: "a.ts", side: "staged" })).toEqual([["staged:a.ts", true, false]]);
    expect(sections({ path: "a.ts", side: null })).toEqual([["combined:a.ts", true, true]]);
    expect(buildFileRows({ status, ...empty }, { path: "a.ts", side: "staged" }, "unified")).toEqual([]);
    expect(buildFileRows({ status, ...empty }, { path: "b.ts", side: null }, "unified")).toEqual([]);
  });

  it("splits a combined diff's blocks where staged changes meet unstaged ones, and moves pending ones across", () => {
    const line = (type: DiffLine["type"], n: number, origin: "staged" | "unstaged" | null): DiffLine => ({
      type,
      content: `${type}${n}`,
      oldNo: type === "add" ? null : n,
      newNo: type === "remove" ? null : n,
      noNewline: false,
      tokens: null,
      origin,
    });
    const file = { ...diff([{ ...hunk(1, 3, 1, 3), lines: [line("remove", 1, "staged"), line("add", 1, "staged"), line("add", 2, "unstaged"), line("context", 3, null)] }], 3), side: "combined" as const };
    const [staged, unstaged] = blocksOf(file)[0];
    expect([staged.range, staged.origin, unstaged.range, unstaged.origin]).toEqual([[0, 1], "staged", [2, 2], "unstaged"]);
    expect(unstaged.lines).toEqual([{ type: "add", no: 2, content: "add2" }]);
    const rows = buildFileRows(
      { status, diffs: new Map([["combined:a.ts", file]]), context: new Map(), pendingBlocks: new Map([[blockKey(unstaged), "stage" as const]]) },
      { path: "a.ts", side: null },
      "unified",
    );
    const moved = rows.find((row): row is Extract<Row, { kind: "line" }> => row.kind === "line" && row.content === "add2")!;
    expect([moved.type, moved.block?.origin, moved.block?.pending]).toEqual(["add", "staged", true]);
  });

  it("pairs lines side by side, marking each block's first row", () => {
    const line = (type: DiffLine["type"], oldNo: number | null, newNo: number | null): DiffLine => ({ type, content: `${type}${oldNo ?? newNo}`, oldNo, newNo, noNewline: false, tokens: null, origin: type === "context" ? null : "unstaged" });
    const file = diff([{ ...hunk(1, 2, 1, 2), lines: [line("remove", 1, null), line("add", null, 1), line("context", 2, 2)] }], 4);
    const revealed = new Map<number, ContextLine>([[3, { content: "three", tokens: null }]]);
    const rows = buildFileRows({ status, diffs: new Map([["unstaged:a.ts", file]]), context: new Map([["unstaged:a.ts", revealed]]), pendingBlocks: new Map() }, { path: "a.ts", side: "unstaged" as const }, "split");
    const split = rows.filter((row): row is Extract<Row, { kind: "split" }> => row.kind === "split");
    expect(split.map((row) => [row.left?.no ?? null, row.right?.no ?? null, row.block?.id ?? null, row.blockStart])).toEqual([
      [1, 1, "unstaged:a.ts|h0b0", true],
      [2, 2, null, false],
      [3, 3, null, false],
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it("shows a pending block as it will be once applied", () => {
    const line = (type: DiffLine["type"], oldNo: number | null, newNo: number | null): DiffLine => ({ type, content: `${type}${oldNo ?? newNo}`, oldNo, newNo, noNewline: false, tokens: null, origin: type === "context" ? null : "unstaged" });
    const file = diff([{ ...hunk(1, 2, 1, 2), lines: [line("remove", 1, null), line("add", null, 1), line("context", 2, 2)] }], 2);
    const [block] = blocksOf(file)[0];
    const shown = (action: "stage" | "discard") =>
      buildFileRows({ status, diffs: new Map([["unstaged:a.ts", file]]), context: new Map(), pendingBlocks: new Map([[blockKey(block), action]]) }, { path: "a.ts", side: "unstaged" as const }, "unified")
        .flatMap((row) => (row.kind === "line" ? [`${row.type}:${row.content}`] : []));
    expect(shown("stage")).toEqual(["context:add1", "context:context2"]);
    expect(shown("discard")).toEqual(["context:remove1", "context:context2"]);
  });
});

describe("blocksOf", () => {
  it("splits a hunk into runs of changed lines", () => {
    const line = (type: DiffLine["type"]): DiffLine => ({ type, content: "", oldNo: null, newNo: null, noNewline: false, tokens: null, origin: type === "context" ? null : "unstaged" });
    const file = diff([{ ...hunk(1, 5, 1, 5), lines: ["context", "remove", "add", "context", "add", "add", "context", "remove"].map((type) => line(type as DiffLine["type"])) }], 9);
    expect(blocksOf(file)[0].map((block) => [block.range, block.kind])).toEqual([
      [[1, 2], "mixed"],
      [[4, 5], "add"],
      [[7, 7], "remove"],
    ]);
    expect(blocksOf(file)).toBe(blocksOf(file));
  });
});

describe("expansionRange", () => {
  it("reveals a step from the right end, or everything when the gap is small", () => {
    expect(expansionRange({ start: 11, end: 60 }, "down")).toEqual({ start: 11, end: 30 });
    expect(expansionRange({ start: 11, end: 60 }, "up")).toEqual({ start: 41, end: 60 });
    expect(expansionRange({ start: 11, end: 25 }, "up")).toEqual({ start: 11, end: 25 });
    expect(expansionRange({ start: 11, end: 60 }, "all")).toEqual({ start: 11, end: 60 });
  });
});

describe("splitPairs", () => {
  const line = (type: DiffLine["type"], n: number) => ({ type, content: String(n), tokens: null, noNewline: false, oldNo: type === "add" ? null : n, newNo: type === "remove" ? null : n });

  it("puts removals beside the additions after them and pads the shorter side", () => {
    const pairs = splitPairs([line("context", 1), line("remove", 2), line("remove", 3), line("add", 2), line("context", 4), line("add", 5)]);
    expect(pairs.map(([left, right]) => [left?.type ?? null, right?.type ?? null])).toEqual([
      ["context", "context"],
      ["remove", "add"],
      ["remove", null],
      ["context", "context"],
      [null, "add"],
    ]);
  });
});

describe("textColumns", () => {
  it("expands tabs to the next tab stop", () => {
    expect(textColumns("ab")).toBe(2);
    expect(textColumns("	x")).toBe(9);
    expect(textColumns("abc	x")).toBe(9);
  });
});

describe("navigationItems", () => {
  const entry = (path: string, kind: "modified" | "untracked" = "modified") => ({ path, origPath: null, kind, stamp: "s", additions: 1, deletions: 0 });
  const status = {
    isRepo: true,
    branch: "main",
    upstream: null,
    detached: false,
    ahead: 0,
    behind: 0,
    staged: [entry("src/b.ts")],
    unstaged: [entry("src/b.ts"), entry("a.ts"), entry("src/a.ts"), entry("new.ts", "untracked")],
    conflicted: [],
    revision: "r",
  };

  it("follows the Changes panel's order, each file once unless grouped by staged and unstaged", () => {
    const keys = (view: "tree" | "list", groupBy: "tracked" | "staged") => navigationItems(status, view, groupBy).map((item) => `${item.side ?? "all"}:${item.path}`);
    expect(keys("tree", "tracked")).toEqual(["all:src/a.ts", "all:src/b.ts", "all:a.ts", "all:new.ts"]);
    expect(keys("list", "staged")).toEqual(["staged:src/b.ts", "unstaged:a.ts", "unstaged:new.ts", "unstaged:src/a.ts", "unstaged:src/b.ts"]);
  });
});
