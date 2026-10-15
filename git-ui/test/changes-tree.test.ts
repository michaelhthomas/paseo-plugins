import { describe, expect, it } from "vitest";
import type { GitStatus, StatusEntry } from "../shared/git";
import {
  aggregateCheck,
  allFolderKeys,
  buildTreeRows,
  checkboxChange,
  collapseKey,
  formatCount,
  groupItems,
  type GroupBy,
  type TreeRow,
  type ViewMode,
} from "../client/changes-tree";

const entry = (path: string, kind: StatusEntry["kind"] = "modified", additions = 1, deletions = 0): StatusEntry => ({
  path,
  origPath: null,
  kind,
  stamp: "s",
  additions,
  deletions,
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

const CHECK = { checked: "x", unchecked: " ", mixed: "-" } as const;

const describeRow = (row: TreeRow) =>
  row.kind === "group"
    ? `[${row.group}] ${CHECK[row.check]} +${row.additions}`
    : row.kind === "folder"
      ? `${"  ".repeat(row.depth)}${row.name}/ ${CHECK[row.check]} +${row.additions}`
      : `${"  ".repeat(row.depth)}${row.name}${row.dir ? ` (${row.dir})` : ""} ${CHECK[row.check]}`;

const rows = (s: GitStatus, view: ViewMode, groupBy: GroupBy, collapsed: string[] = []) =>
  buildTreeRows(s, { view, groupBy, collapsed: new Set(collapsed) }).map(describeRow);

describe("tree view", () => {
  const unstaged = [
    entry("aspire/README.md", "modified", 7),
    entry("aspire/client/ansi-text.tsx", "modified", 108),
    entry("aspire/client/aspire-popover.tsx", "modified", 52, 4),
    entry("aspire/index.client.tsx", "modified", 13, 1),
    entry("aspire/server/aspire.ts", "modified", 13, 1),
    entry("git-ui/server/deep/only/file.ts", "modified", 5),
    entry("top.ts", "modified", 2),
  ];

  it("puts folders first, sorts by ASCII, compresses single-child chains and sums stats", () => {
    expect(rows(status({ unstaged }), "tree", "none")).toEqual([
      "[all]   +200",
      "aspire/   +193",
      "  client/   +160",
      "    ansi-text.tsx  ",
      "    aspire-popover.tsx  ",
      "  server/   +13",
      "    aspire.ts  ",
      "  README.md  ",
      "  index.client.tsx  ",
      "git-ui/server/deep/only/   +5",
      "  file.ts  ",
      "top.ts  ",
    ]);
  });

  it("hides collapsed folders and groups, keyed by full path", () => {
    const shown = rows(status({ unstaged, staged: [entry("x.ts")] }), "tree", "staged", [collapseKey("unstaged", "aspire/client"), collapseKey("staged")]);
    expect(shown).toContain("  client/   +160");
    expect(shown.some((line) => line.includes("ansi-text"))).toBe(false);
    expect(shown.some((line) => line.includes("x.ts"))).toBe(false);
    expect(shown[0]).toBe("[staged] x +1");
  });

  it("lists every folder key, compressed or not", () => {
    expect(allFolderKeys(status({ unstaged: [entry("a/b/c.ts")] }), "none")).toEqual(["all:a", "all:a/b"]);
  });
});

describe("grouping and checkboxes", () => {
  const s = status({
    staged: [entry("src/both.ts"), entry("src/staged.ts", "added")],
    unstaged: [entry("src/both.ts"), entry("src/changed.ts"), entry("new.ts", "untracked")],
    conflicted: [entry("c.ts", "conflict")],
  });

  it("merges a file's staged and unstaged changes into one partly checked row", () => {
    expect(rows(s, "list", "none")).toEqual([
      "[conflicts]   +1",
      "c.ts  ",
      "[all] - +5",
      "new.ts  ",
      "both.ts (src) -",
      "changed.ts (src)  ",
      "staged.ts (src) x",
    ]);
  });

  it("splits tracked from untracked files, counting staged new files as tracked", () => {
    expect(groupItems(s, "tracked").map(({ group, items }) => [group, items.map((i) => i.path)])).toEqual([
      ["conflicts", ["c.ts"]],
      ["tracked", ["src/both.ts", "src/staged.ts", "src/changed.ts"]],
      ["untracked", ["new.ts"]],
    ]);
  });

  it("keeps one row per side when grouping by staged and unstaged", () => {
    expect(rows(s, "list", "staged").filter((line) => line.includes("both"))).toEqual(["both.ts (src) x", "both.ts (src)  "]);
  });

  it("stages what isn't staged, and unstages only a fully staged set", () => {
    const items = groupItems(s, "none").find((group) => group.group === "all")!.items;
    expect(aggregateCheck(items)).toBe("mixed");
    const toStage = checkboxChange(items);
    expect(toStage.stage.map((e) => e.path)).toEqual(["src/both.ts", "src/changed.ts", "new.ts"]);
    expect(toStage.unstage).toEqual([]);
    const staged = items.filter((i) => i.path === "src/staged.ts");
    expect(checkboxChange(staged).unstage.map((e) => e.path)).toEqual(["src/staged.ts"]);
    const conflicts = groupItems(s, "none")[0].items;
    expect(checkboxChange(conflicts).resolve.map((e) => e.path)).toEqual(["c.ts"]);
  });
});

describe("formatCount", () => {
  it("matches Paseo's compact counts", () => {
    expect([7, 999, 1000, 1234, 10_200, 123_456, 3_400_000].map(formatCount)).toEqual(["7", "999", "1k", "1.2k", "10.2k", "123k", "3.4m"]);
  });
});
