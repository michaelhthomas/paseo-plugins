import type { FileStatusResult } from "simple-git";
import { describe, expect, it } from "vitest";
import { parseStatusV2, sectionStatus } from "../server/status";

const file = (path: string, index: string, working_dir: string, from?: string): FileStatusResult => ({ path, index, working_dir, from });
const noStats = { additions: null, deletions: null };

describe("sectionStatus", () => {
  it("puts a file with staged and unstaged changes in both sections", () => {
    const sections = sectionStatus([file("a.ts", "M", "M")], () => "s");
    expect(sections.staged).toEqual([{ path: "a.ts", origPath: null, kind: "modified", stamp: "MM:s", ...noStats }]);
    expect(sections.unstaged).toEqual([{ path: "a.ts", origPath: null, kind: "modified", stamp: "MM:s", ...noStats }]);
  });

  it("keeps the original path of staged renames only", () => {
    const sections = sectionStatus([file("new name.ts", "R", "M", "old name.ts")], () => "s");
    expect(sections.staged[0]).toMatchObject({ path: "new name.ts", origPath: "old name.ts", kind: "renamed" });
    expect(sections.unstaged[0]).toMatchObject({ path: "new name.ts", origPath: null, kind: "modified" });
  });

  it("separates conflicts, untracked and intent-to-add files", () => {
    const sections = sectionStatus(
      [file("c.ts", "U", "U"), file("both-added.ts", "A", "A"), file("u.ts", "?", "?"), file("ita.ts", " ", "A"), file("gone.ts", "D", " ")],
      () => "s",
    );
    expect(sections.conflicted.map((entry) => entry.path)).toEqual(["both-added.ts", "c.ts"]);
    expect(sections.unstaged.map((entry) => [entry.path, entry.kind])).toEqual([
      ["ita.ts", "added"],
      ["u.ts", "untracked"],
    ]);
    expect(sections.staged.map((entry) => [entry.path, entry.kind])).toEqual([["gone.ts", "deleted"]]);
  });

  it("stamps entries with their code and content stamp", () => {
    const sections = sectionStatus([file("a.ts", " ", "M")], (path) => `${path}@1`);
    expect(sections.unstaged[0].stamp).toBe(" M:a.ts@1");
  });
});

describe("parseStatusV2", () => {
  it("reads branch info, entries with their objects, renames, conflicts and untracked files", () => {
    const records = [
      "# branch.oid abc",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 h1 i1 src/with space.ts",
      "2 R. N... 100644 100644 100644 h2 i2 R100 new name.ts",
      "old name.ts",
      "u UU N... 100644 100644 100644 100644 a b c conflict.ts",
      "? fresh.txt",
      "",
    ];
    const status = parseStatusV2(records.join("\0"));
    expect([status.branch, status.upstream, status.detached, status.ahead, status.behind]).toEqual(["main", "origin/main", false, 2, 1]);
    expect(status.files.map((file) => [file.path, file.from ?? null, file.index, file.working_dir])).toEqual([
      ["src/with space.ts", null, " ", "M"],
      ["new name.ts", "old name.ts", "R", " "],
      ["conflict.ts", null, "U", "U"],
      ["fresh.txt", null, "?", "?"],
    ]);
    expect([...status.objects]).toEqual([
      ["src/with space.ts", "h1:i1"],
      ["new name.ts", "h2:i2"],
    ]);
  });

  it("reports a detached HEAD without a branch", () => {
    expect(parseStatusV2("# branch.oid abc\0# branch.head (detached)\0")).toMatchObject({ branch: null, detached: true });
  });
});
