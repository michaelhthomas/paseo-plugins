import { describe, expect, it } from "vitest";
import type { GitStatus, StatusEntry } from "../shared/git";
import { applyOp, applyOps, OPTIMISTIC_STAMP } from "../client/optimistic";

const entry = (path: string, kind: StatusEntry["kind"], extra: Partial<StatusEntry> = {}): StatusEntry => ({
  path,
  origPath: null,
  kind,
  stamp: "s",
  additions: 1,
  deletions: 1,
  ...extra,
});

const status = (sections: Partial<Pick<GitStatus, "staged" | "unstaged" | "conflicted">>): GitStatus => ({
  isRepo: true,
  branch: "main",
  upstream: null,
  detached: false,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  conflicted: [],
  revision: "r",
  ...sections,
});

const paths = (entries: StatusEntry[]) => entries.map((e) => `${e.kind}:${e.path}`);

describe("applyOp", () => {
  it("moves staged files across, turning untracked into added", () => {
    const next = applyOp(status({ unstaged: [entry("b.ts", "untracked"), entry("a.ts", "modified")] }), { action: "stage", paths: ["b.ts"] });
    expect(paths(next.staged)).toEqual(["added:b.ts"]);
    expect(paths(next.unstaged)).toEqual(["modified:a.ts"]);
    expect(next.staged[0].stamp).toBe(OPTIMISTIC_STAMP);
  });

  it("merges into a file that already has staged changes", () => {
    const next = applyOp(status({ staged: [entry("a.ts", "modified")], unstaged: [entry("a.ts", "modified", { additions: 2 })] }), {
      action: "stage",
      paths: ["a.ts"],
    });
    expect(next.staged).toHaveLength(1);
    expect(next.staged[0]).toMatchObject({ additions: 3, deletions: 2 });
    expect(next.unstaged).toEqual([]);
  });

  it("splits an unstaged rename into an untracked file and a deletion", () => {
    const next = applyOp(status({ staged: [entry("new.ts", "renamed", { origPath: "old.ts" })] }), { action: "unstage", paths: ["new.ts"] });
    expect(paths(next.unstaged)).toEqual(["untracked:new.ts", "deleted:old.ts"]);
    expect(next.staged).toEqual([]);
  });

  it("turns unstaged new files back into untracked ones", () => {
    const next = applyOp(status({ staged: [entry("n.ts", "added")] }), { action: "unstage", paths: ["n.ts"] });
    expect(paths(next.unstaged)).toEqual(["untracked:n.ts"]);
  });

  it("drops discarded files and stages resolved conflicts", () => {
    const next = applyOps(status({ unstaged: [entry("a.ts", "modified")], conflicted: [entry("c.ts", "conflict")] }), [
      { action: "discard", paths: ["a.ts"] },
      { action: "resolve", paths: ["c.ts"] },
    ]);
    expect(next.unstaged).toEqual([]);
    expect(next.conflicted).toEqual([]);
    expect(paths(next.staged)).toEqual(["modified:c.ts"]);
  });
});

describe("partial operations", () => {
  it("moves some changed lines to the other side and keeps the file where it was", () => {
    const before = status({ unstaged: [entry("a.ts", "modified", { additions: 5, deletions: 2 })] });
    const after = applyOp(before, { action: "stage-part", paths: ["a.ts"], additions: 2, deletions: 1 });
    expect(after.unstaged.map((e) => [e.path, e.additions, e.deletions])).toEqual([["a.ts", 3, 1]]);
    expect(after.staged.map((e) => [e.path, e.additions, e.deletions, e.stamp])).toEqual([["a.ts", 2, 1, OPTIMISTIC_STAMP]]);
  });

  it("adds unstaged lines to an already staged entry, and drops discarded ones", () => {
    const before = status({ staged: [entry("a.ts", "modified", { additions: 4, deletions: 0 })], unstaged: [entry("a.ts", "modified", { additions: 1, deletions: 1 })] });
    const unstaged = applyOp(before, { action: "unstage-part", paths: ["a.ts"], additions: 1, deletions: 0 });
    expect(unstaged.staged[0].additions).toBe(3);
    expect([unstaged.unstaged[0].additions, unstaged.unstaged[0].deletions]).toEqual([2, 1]);
    const discarded = applyOp(before, { action: "discard-part", paths: ["a.ts"], additions: 1, deletions: 1 });
    expect([discarded.staged, discarded.unstaged.map((e) => [e.additions, e.deletions])]).toEqual([before.staged, [[0, 0]]]);
  });
});
