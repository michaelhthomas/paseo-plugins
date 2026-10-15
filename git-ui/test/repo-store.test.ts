import { describe, expect, it } from "vitest";
import type { DiffLine, FileDiff } from "../shared/git";
import { blocksOf } from "../client/diff-rows";
import { byDistance, statusOp } from "../client/repo-store";

const line = (type: DiffLine["type"], n: number, origin: "staged" | "unstaged" | null): DiffLine => ({
  type,
  content: `${type}${n}`,
  oldNo: type === "add" ? null : n,
  newNo: type === "remove" ? null : n,
  noNewline: false,
  tokens: null,
  origin,
});

const combined = (lines: DiffLine[]): FileDiff => ({
  path: "a.ts",
  side: "combined",
  oldPath: null,
  stamp: "s",
  status: "ok",
  message: null,
  isNew: false,
  isDeleted: false,
  patchable: true,
  fingerprint: "f",
  newSideHash: "n",
  additions: 0,
  deletions: 0,
  hunks: [{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, header: "@@", hash: "h", lines }],
  newLineCount: 3,
});

describe("statusOp", () => {
  it("moves the whole side when the block is its last change, and part of it otherwise", () => {
    const diff = combined([line("remove", 1, "unstaged"), line("add", 1, "unstaged"), line("context", 2, null), line("add", 3, "staged")]);
    const [unstaged, staged] = blocksOf(diff)[0];
    expect(statusOp(unstaged, "stage")).toEqual({ action: "stage", paths: ["a.ts"] });
    expect(statusOp(staged, "unstage")).toEqual({ action: "unstage", paths: ["a.ts"] });

    const more = combined([line("add", 1, "unstaged"), line("context", 2, null), line("remove", 3, "unstaged")]);
    expect(statusOp(blocksOf(more)[0][0], "stage")).toEqual({ action: "stage-part", paths: ["a.ts"], additions: 1, deletions: 0 });
  });
});

describe("byDistance", () => {
  it("loads outward from the shown file, next before previous, unknown ones last", () => {
    const target = (key: string) => ({ key, path: key, side: "combined" as const, origPath: null, untracked: false, stamp: "s", optimistic: false });
    const order = ["a", "b", "c", "d", "e"];
    const sorted = byDistance(["e", "x", "a", "d", "b", "c"].map(target), order, "c").map((t) => t.key);
    expect(sorted).toEqual(["c", "d", "b", "e", "a", "x"]);
    expect(byDistance(["c", "a"].map(target), order, null).map((t) => t.key)).toEqual(["a", "c"]);
  });
});
