import type { EntryKind, GitStatus, StatusEntry } from "../shared/git";

/**
 * The Changes panel's rows. Files are grouped (all together, tracked vs untracked, or staged vs unstaged) and shown
 * as a flat list or as trees built the way Paseo builds its own Changes tree (packages/app/src/git/diff-tree.ts):
 * directories before files, plain ASCII order, single-child directory chains compressed into one row, folder rows
 * carrying their subtree's line counts. Folders are keyed by their full uncompressed path so collapse state survives
 * compression changing as files come and go.
 */

export type ViewMode = "tree" | "list";
export type GroupBy = "none" | "tracked" | "staged";
export type GroupId = "conflicts" | "all" | "tracked" | "untracked" | "staged" | "unstaged";
export type CheckState = "checked" | "unchecked" | "mixed";

export const GROUP_TITLES: Record<GroupId, string> = {
  conflicts: "Merge Conflicts",
  all: "Changes",
  tracked: "Tracked",
  untracked: "Untracked",
  staged: "Staged",
  unstaged: "Unstaged",
};

/** One file as the panel shows it. When grouping by staged/unstaged a file with both has one item per side. */
export type ChangeItem = {
  path: string;
  origPath: string | null;
  kind: EntryKind;
  staged: StatusEntry | null;
  unstaged: StatusEntry | null;
  conflict: StatusEntry | null;
  additions: number | null;
  deletions: number | null;
};

type Stats = { additions: number; deletions: number };

export type TreeRow =
  | ({ kind: "group"; id: string; group: GroupId; items: ChangeItem[]; collapsed: boolean; check: CheckState } & Stats)
  | ({
      kind: "folder";
      id: string;
      group: GroupId;
      dirPath: string;
      name: string;
      depth: number;
      collapsed: boolean;
      /** Every file below this folder, for folder-wide actions. */
      items: ChangeItem[];
      check: CheckState;
    } & Stats)
  | { kind: "file"; id: string; group: GroupId; item: ChangeItem; name: string; dir: string; depth: number; check: CheckState };

type DirNode = { kind: "dir"; dirPath: string; name: string; children: Node[] };
type FileNode = { kind: "file"; item: ChangeItem; name: string };
type Node = DirNode | FileNode;

const sumOrNull = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

function item(path: string, sides: Pick<ChangeItem, "staged" | "unstaged" | "conflict">): ChangeItem {
  const { staged, unstaged, conflict } = sides;
  const counts = [staged, unstaged, conflict].filter((entry): entry is StatusEntry => entry !== null);
  return {
    path,
    origPath: staged?.origPath ?? null,
    kind: conflict ? "conflict" : (staged?.kind ?? unstaged!.kind),
    ...sides,
    additions: counts.map((entry) => entry.additions).reduce(sumOrNull),
    deletions: counts.map((entry) => entry.deletions).reduce(sumOrNull),
  };
}

/** A file's checkbox: checked when fully staged, mixed when it has staged and unstaged changes. */
export function itemCheck(entry: ChangeItem): CheckState {
  if (entry.conflict) return "unchecked";
  if (entry.staged && entry.unstaged) return "mixed";
  return entry.staged ? "checked" : "unchecked";
}

export function aggregateCheck(items: readonly ChangeItem[]): CheckState {
  let checked = 0;
  let unchecked = 0;
  for (const entry of items) {
    const state = itemCheck(entry);
    if (state === "mixed") return "mixed";
    if (state === "checked") checked++;
    else unchecked++;
  }
  return checked && unchecked ? "mixed" : checked ? "checked" : "unchecked";
}

/** The panel's groups, in order, with their files. Empty groups are left out. */
export function groupItems(status: GitStatus, groupBy: GroupBy): { group: GroupId; items: ChangeItem[] }[] {
  const conflicts = status.conflicted.map((conflict) => item(conflict.path, { staged: null, unstaged: null, conflict }));
  let groups: { group: GroupId; items: ChangeItem[] }[];
  if (groupBy === "staged") {
    groups = [
      { group: "staged", items: status.staged.map((staged) => item(staged.path, { staged, unstaged: null, conflict: null })) },
      { group: "unstaged", items: status.unstaged.map((unstaged) => item(unstaged.path, { staged: null, unstaged, conflict: null })) },
    ];
  } else {
    const byPath = new Map<string, { staged: StatusEntry | null; unstaged: StatusEntry | null }>();
    for (const staged of status.staged) byPath.set(staged.path, { staged, unstaged: null });
    for (const unstaged of status.unstaged) byPath.set(unstaged.path, { staged: byPath.get(unstaged.path)?.staged ?? null, unstaged });
    const merged = [...byPath].map(([path, sides]) => item(path, { ...sides, conflict: null }));
    groups =
      groupBy === "none"
        ? [{ group: "all", items: merged }]
        : [
            { group: "tracked", items: merged.filter((entry) => entry.kind !== "untracked") },
            { group: "untracked", items: merged.filter((entry) => entry.kind === "untracked") },
          ];
  }
  return [{ group: "conflicts" as const, items: conflicts }, ...groups].filter((group) => group.items.length > 0);
}

/** Collapse key of a folder (`dirPath`) or of a whole group (`dirPath` omitted). */
export function collapseKey(group: GroupId, dirPath = "") {
  return `${group}:${dirPath}`;
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function buildTree(items: readonly ChangeItem[]): DirNode {
  const root: DirNode = { kind: "dir", dirPath: "", name: "", children: [] };
  const dirs = new Map<string, DirNode>([["", root]]);
  const ensureDir = (dirPath: string): DirNode => {
    const existing = dirs.get(dirPath);
    if (existing) return existing;
    const slash = dirPath.lastIndexOf("/");
    const node: DirNode = { kind: "dir", dirPath, name: dirPath.slice(slash + 1), children: [] };
    ensureDir(slash < 0 ? "" : dirPath.slice(0, slash)).children.push(node);
    dirs.set(dirPath, node);
    return node;
  };
  for (const entry of items) {
    const slash = entry.path.lastIndexOf("/");
    ensureDir(slash < 0 ? "" : entry.path.slice(0, slash)).children.push({ kind: "file", item: entry, name: entry.path.slice(slash + 1) });
  }
  const sort = (node: DirNode) => {
    node.children.sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : byName(a, b)));
    for (const child of node.children) if (child.kind === "dir") sort(child);
  };
  sort(root);
  return root;
}

function compress(node: DirNode): DirNode {
  let { name, dirPath } = node;
  let children = node.children.map((child) => (child.kind === "dir" ? compress(child) : child));
  while (children.length === 1 && children[0].kind === "dir") {
    const only = children[0];
    name = name ? `${name}/${only.name}` : only.name;
    dirPath = only.dirPath;
    children = only.children;
  }
  return { kind: "dir", dirPath, name, children };
}

function filesUnder(node: DirNode): ChangeItem[] {
  return node.children.flatMap((child) => (child.kind === "file" ? [child.item] : filesUnder(child)));
}

export function totals(items: readonly { additions: number | null; deletions: number | null }[]): Stats {
  let additions = 0;
  let deletions = 0;
  for (const entry of items) {
    additions += entry.additions ?? 0;
    deletions += entry.deletions ?? 0;
  }
  return { additions, deletions };
}

function splitPath(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

/** `dir` is only filled in for list rows; in a tree the folders show it. */
function fileRow(group: GroupId, entry: ChangeItem, depth: number, list: boolean): TreeRow {
  const { name, dir } = splitPath(entry.path);
  return { kind: "file", id: `${group}:file:${entry.path}`, group, item: entry, name, dir: list ? dir : "", depth, check: itemCheck(entry) };
}

function treeRows(group: GroupId, items: readonly ChangeItem[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: DirNode, depth: number) => {
    for (const child of node.children) {
      if (child.kind === "file") {
        rows.push(fileRow(group, child.item, depth, false));
        continue;
      }
      const under = filesUnder(child);
      const isCollapsed = collapsed.has(collapseKey(group, child.dirPath));
      rows.push({
        kind: "folder",
        id: `${group}:dir:${child.dirPath}`,
        group,
        dirPath: child.dirPath,
        name: child.name,
        depth,
        collapsed: isCollapsed,
        items: under,
        check: aggregateCheck(under),
        ...totals(under),
      });
      if (!isCollapsed) walk(child, depth + 1);
    }
  };
  const root = buildTree(items);
  walk({ ...root, children: root.children.map((child) => (child.kind === "dir" ? compress(child) : child)) }, 0);
  return rows;
}

function listRows(group: GroupId, items: readonly ChangeItem[]): TreeRow[] {
  return [...items].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((entry) => fileRow(group, entry, 0, true));
}

/** Rows for every non-empty group: a header, then its files unless the group is collapsed. */
export function buildTreeRows(
  status: GitStatus | null,
  options: { view: ViewMode; groupBy: GroupBy; collapsed: ReadonlySet<string> },
): TreeRow[] {
  if (!status?.isRepo) return [];
  const rows: TreeRow[] = [];
  for (const { group, items } of groupItems(status, options.groupBy)) {
    const groupCollapsed = options.collapsed.has(collapseKey(group));
    rows.push({
      kind: "group",
      id: `group:${group}`,
      group,
      items,
      collapsed: groupCollapsed,
      check: aggregateCheck(items),
      ...totals(items),
    });
    if (groupCollapsed) continue;
    rows.push(...(options.view === "tree" ? treeRows(group, items, options.collapsed) : listRows(group, items)));
  }
  return rows;
}

/** Every folder collapse key in the current trees, for "collapse all". */
export function allFolderKeys(status: GitStatus | null, groupBy: GroupBy): string[] {
  if (!status?.isRepo) return [];
  const keys: string[] = [];
  for (const { group, items } of groupItems(status, groupBy)) {
    const walk = (node: DirNode) => {
      for (const child of node.children) {
        if (child.kind !== "dir") continue;
        keys.push(collapseKey(group, child.dirPath));
        walk(child);
      }
    };
    walk(buildTree(items));
  }
  return keys;
}

/** What checking or unchecking a set of files does: toggling a fully staged set unstages it, anything else stages. */
export function checkboxChange(items: readonly ChangeItem[]) {
  if (aggregateCheck(items) === "checked") {
    return { unstage: items.flatMap((entry) => (entry.staged ? [entry.staged] : [])), stage: [], resolve: [] };
  }
  return {
    unstage: [],
    stage: items.flatMap((entry) => (entry.unstaged ? [entry.unstaged] : [])),
    resolve: items.flatMap((entry) => (entry.conflict ? [entry.conflict] : [])),
  };
}

/** Paseo's diff count format: 7, 1.2k, 10.2k, 3.4m. */
export function formatCount(value: number) {
  if (value < 1000) return String(value);
  const [divisor, suffix] = value < 1_000_000 ? [1000, "k"] : [1_000_000, "m"];
  const scaled = value / divisor;
  return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
}
