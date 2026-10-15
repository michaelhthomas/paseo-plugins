import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { copyText, FlatList, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { LayoutChangeEvent, FlatList as NativeFlatList, NativeScrollEvent, NativeSyntheticEvent, View as NativeView } from "react-native";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { GitStatus, StatusEntry } from "../shared/git";
import { discardMessage, useRepoActions } from "./actions";
import {
  buildTreeRows,
  checkboxChange,
  GROUP_TITLES,
  totals,
  type ChangeItem,
  type GroupBy,
  type GroupId,
  type TreeRow,
  type ViewMode,
} from "./changes-tree";
import { CommitBox } from "./commit-box";
import { IconButton, useConfirm } from "./controls";
import { DIFF_PANEL_ID } from "./diff-panel";
import { usePanelMenu, type MenuEntry } from "./menu";
import { useOverlayScrollbar } from "./overlay-scrollbar";
import type { DiffItem } from "./diff-rows";
import { useDisplaySettings } from "./display-settings";
import { useRepo, type RepoStore } from "./repo-store";
import {
  ChangeIcon,
  Checkbox,
  DiffStat,
  FileIcon,
  FolderIcon,
  TREE_ICON_GAP,
  TREE_ICON_SIZE,
  TREE_ROW_PADDING_RIGHT,
  TREE_ROW_PADDING_VERTICAL,
  TreeChevron,
  treePaddingLeft,
} from "./tree-parts";

export const CHANGES_PANEL_ID = "git-changes";

// Every row is this tall, so the list can place rows (and scroll to them) without measuring.
const TREE_ROW_HEIGHT = TREE_ICON_SIZE + TREE_ROW_PADDING_VERTICAL * 2 + 4;
// About how long a smooth scroll runs; another step sooner than this jumps instead.
const SCROLL_ANIMATION_MS = 300;

type ContextMenuProps = ReturnType<ReturnType<typeof usePanelMenu>["contextMenuProps"]>;

/**
 * A row with Paseo's tree metrics, indent guides, a hover highlight and a tint when selected. `trailing` (the
 * checkbox) sits beside the row's pressable area rather than inside it, so pressing it never also presses the row.
 */
function RowFrame({
  theme,
  depth,
  guides,
  selected,
  label,
  expanded,
  onPress,
  contextMenu,
  trailing,
  children,
}: {
  theme: PluginTheme;
  depth: number;
  guides: boolean;
  selected?: boolean;
  label: string;
  expanded?: boolean;
  onPress(): void;
  contextMenu: ContextMenuProps;
  trailing: ReactNode;
  children(hovered: boolean): ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: hovered || pressed ? theme.colors.surface2 : "transparent",
      }}
    >
      {/* An accent tint over the hover color, so a selected row still shows hovering. */}
      {selected ? <View pointerEvents="none" style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: theme.colors.accent, opacity: 0.18 }} /> : null}
      {guides
        ? Array.from({ length: depth }, (_, level) => (
            <View
              key={level}
              pointerEvents="none"
              style={{ position: "absolute", top: 0, bottom: 0, left: treePaddingLeft(level) + TREE_ICON_SIZE / 2 - 1, width: 1, backgroundColor: theme.colors.border }}
            />
          ))
        : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected, expanded }}
        onPress={onPress}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        {...contextMenu}
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: TREE_ICON_GAP,
          height: TREE_ROW_HEIGHT,
          paddingLeft: treePaddingLeft(depth),
          paddingRight: TREE_ICON_GAP,
        }}
      >
        {children(hovered)}
      </Pressable>
      <View style={{ paddingRight: TREE_ROW_PADDING_RIGHT + 4 }}>{trailing}</View>
    </View>
  );
}

function rowName(theme: PluginTheme, text: string, bright: boolean, dir?: string) {
  return (
    <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, fontSize: 14, color: theme.colors.foreground, opacity: bright ? 1 : 0.76 }}>
      {text}
      {dir ? <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>{`  ${dir}`}</Text> : null}
    </Text>
  );
}

type RowHandlers = {
  onToggleCollapsed(group: GroupId, dirPath?: string): void;
  onOpen(item: ChangeItem): void;
  onCheck(items: ChangeItem[]): void;
  menuFor(row: TreeRow): MenuEntry[];
  contextMenuProps(entries: () => MenuEntry[]): ContextMenuProps;
};

const ChangesRow = memo(function ChangesRow({ theme, row, view, selected, handlers }: { theme: PluginTheme; row: TreeRow; view: ViewMode; selected: boolean; handlers: RowHandlers }) {
  const contextMenu = handlers.contextMenuProps(() => handlers.menuFor(row));
  const guides = view === "tree";
  if (row.kind === "group") {
    const title = GROUP_TITLES[row.group];
    return (
      <RowFrame
        theme={theme}
        depth={0}
        guides={false}
        label={title}
        expanded={!row.collapsed}
        onPress={() => handlers.onToggleCollapsed(row.group)}
        contextMenu={contextMenu}
        trailing={<Checkbox theme={theme} state={row.check} label={`Stage all ${title.toLowerCase()} files`} onPress={() => handlers.onCheck(row.items)} />}
      >
        {() => (
          <>
            <TreeChevron theme={theme} expanded={!row.collapsed} />
            <Text numberOfLines={1} style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>
              {title}
            </Text>
            <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted, opacity: 0.7 }}>{row.items.length}</Text>
            <View style={{ flex: 1 }} />
            <DiffStat theme={theme} additions={row.additions} deletions={row.deletions} />
          </>
        )}
      </RowFrame>
    );
  }
  if (row.kind === "folder") {
    return (
      <RowFrame
        theme={theme}
        depth={row.depth}
        guides={guides}
        label={row.dirPath}
        expanded={!row.collapsed}
        onPress={() => handlers.onToggleCollapsed(row.group, row.dirPath)}
        contextMenu={contextMenu}
        trailing={<Checkbox theme={theme} state={row.check} label={`Stage ${row.dirPath}`} onPress={() => handlers.onCheck(row.items)} />}
      >
        {(hovered) => (
          <>
            <FolderIcon theme={theme} open={!row.collapsed} />
            {rowName(theme, row.name, hovered)}
            <View style={{ flex: 1 }} />
            <DiffStat theme={theme} additions={row.additions} deletions={row.deletions} />
          </>
        )}
      </RowFrame>
    );
  }
  const { item } = row;
  const renamedFrom = item.origPath ? ` ← ${item.origPath.slice(item.origPath.lastIndexOf("/") + 1)}` : "";
  return (
    <RowFrame
      theme={theme}
      depth={row.depth}
      guides={guides}
      selected={selected}
      label={item.conflict ? item.path : `Show diff of ${item.path}`}
      onPress={() => handlers.onOpen(item)}
      contextMenu={contextMenu}
      trailing={
        <Checkbox
          theme={theme}
          state={row.check}
          label={item.conflict ? `Mark ${item.path} resolved` : `Stage ${item.path}`}
          onPress={() => handlers.onCheck([item])}
        />
      }
    >
      {(hovered) => (
        <>
          <FileIcon name={row.name} theme={theme} />
          {rowName(theme, `${row.name}${renamedFrom}`, hovered || selected, row.dir)}
          <View style={{ flex: 1 }} />
          <DiffStat theme={theme} additions={item.additions} deletions={item.deletions} />
          <ChangeIcon kind={item.kind} theme={theme} />
        </>
      )}
    </RowFrame>
  );
});

function Header({
  theme,
  status,
  foldersCollapsed,
  view,
  optionsRef,
  onToggleFolders,
  onOptions,
  onRefresh,
}: {
  theme: PluginTheme;
  status: GitStatus;
  foldersCollapsed: boolean;
  view: ViewMode;
  optionsRef: Ref<NativeView>;
  onToggleFolders(): void;
  onOptions(): void;
  onRefresh(): void;
}) {
  const muted = { fontSize: 12, color: theme.colors.foregroundMuted } as const;
  const all = totals([...status.staged, ...status.unstaged]);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, paddingLeft: 12, paddingRight: 4, borderBottomWidth: 1, borderColor: theme.colors.border }}>
      <Icon name="GitBranch" size={14} color={theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: theme.colors.foreground }}>
        {status.detached ? "Detached HEAD" : (status.branch ?? "No branch")}
      </Text>
      {status.ahead ? <Text style={muted}>↑{status.ahead}</Text> : null}
      {status.behind ? <Text style={muted}>↓{status.behind}</Text> : null}
      <DiffStat theme={theme} additions={all.additions} deletions={all.deletions} />
      <View style={{ flex: 1 }} />
      {view === "tree" ? (
        <IconButton
          theme={theme}
          icon={foldersCollapsed ? "ChevronsUpDown" : "ChevronsDownUp"}
          size={14}
          label={foldersCollapsed ? "Expand all folders" : "Collapse all folders"}
          onPress={onToggleFolders}
        />
      ) : null}
      <IconButton ref={optionsRef} theme={theme} icon="SlidersHorizontal" size={14} label="View options" onPress={onOptions} />
      <IconButton theme={theme} icon="RotateCw" size={14} label="Refresh" onPress={onRefresh} />
    </View>
  );
}

/**
 * What opening a file shows: the side it's listed under when grouped by staged and unstaged, otherwise the staged and
 * unstaged changes combined.
 */
const diffItemFor = (item: ChangeItem, groupBy: GroupBy): DiffItem => ({
  path: item.path,
  side: groupBy === "staged" ? (item.staged ? "staged" : "unstaged") : null,
});

/** The Diff panel shows this row's file (and, for one side of it, this row's side). */
const shows = (selected: DiffItem | null, item: ChangeItem) =>
  !!selected && selected.path === item.path && (selected.side === null || !!(selected.side === "staged" ? item.staged : item.unstaged));

const unstagedOf = (items: readonly ChangeItem[]) => items.flatMap((item) => (item.unstaged ? [item.unstaged] : []));
const stagedOf = (items: readonly ChangeItem[]) => items.flatMap((item) => (item.staged ? [item.staged] : []));
const conflictsOf = (items: readonly ChangeItem[]) => items.flatMap((item) => (item.conflict ? [item.conflict] : []));

export function createChangesPanel(store: RepoStore, client: Pick<PluginClientContext, "openPanel">) {
  return function GitChangesPanel({ workspaceId, theme }: PluginWorkspacePanelProps) {
    useEffect(() => store.retain(workspaceId), [workspaceId]);
    const { state, version } = useRepo(store, workspaceId);
    const actions = useRepoActions(store, workspaceId);
    const toast = useToast();
    const { confirm, element: confirmModal } = useConfirm(theme);
    const menu = usePanelMenu(theme);
    const optionsButton = useRef<NativeView>(null);
    const list = useRef<NativeFlatList<TreeRow>>(null);
    const scrollbar = useOverlayScrollbar(list, theme);
    const settings = useDisplaySettings();
    const layout = { view: settings.changesView, groupBy: settings.changesGroupBy, update: settings.update };
    const [commitExpanded, setCommitExpanded] = useState(false);
    const { status, statusError } = state;
    // `state` is mutated in place; `version` says when.
    const rows = useMemo(
      () => buildTreeRows(status, { view: layout.view, groupBy: layout.groupBy, collapsed: state.treeCollapsed }),
      // Not `version`: rows rebuilt for unrelated changes (the Diff panel's file, loading diffs) would re-render them all.
      [status, layout.view, layout.groupBy, state.treeCollapsed],
    );
    const foldersCollapsed = rows.some((row) => row.kind === "folder" && row.collapsed);

    const onOpen = useCallback(
      (item: ChangeItem) => {
        if (item.conflict) return;
        store.focus(workspaceId, diffItemFor(item, layout.groupBy));
        // Asking Paseo to show the panel costs it a layout pass; skip that when the diff is already on screen.
        if (!store.isDiffVisible(workspaceId)) client.openPanel(DIFF_PANEL_ID, { workspaceId });
      },
      [workspaceId, layout.groupBy],
    );

    // Following the Diff panel's file (stepped through with its keys) scrolls the least that brings its row into view.
    // Worked out from the fixed row height and where the list is headed, not where it is mid-animation, so a held key
    // doesn't pile up scrolls; repeats jump, a single step animates.
    const scroll = useRef({ offset: 0, viewport: 0, requestedAt: 0 });
    useEffect(() => {
      const index = rows.findIndex((row) => row.kind === "file" && shows(state.selected, row.item));
      const { offset, viewport, requestedAt } = scroll.current;
      if (index < 0 || !viewport) return;
      const top = index * TREE_ROW_HEIGHT;
      const target = top < offset ? top : top + TREE_ROW_HEIGHT > offset + viewport ? top + TREE_ROW_HEIGHT - viewport : null;
      if (target === null) return;
      const now = Date.now();
      scroll.current = { offset: target, viewport, requestedAt: now };
      list.current?.scrollToOffset({ offset: target, animated: now - requestedAt > SCROLL_ANIMATION_MS });
      // Only when the file changes, not when the rows do.
    }, [state.selected]);
    const listProps = useMemo(() => {
      const base = scrollbar.listProps as { onScroll?(event: NativeSyntheticEvent<NativeScrollEvent>): void; onLayout?(event: LayoutChangeEvent): void };
      return {
        ...base,
        onScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
          base.onScroll?.(event);
          // Mid-animation positions would undo where the list is headed.
          if (Date.now() - scroll.current.requestedAt > SCROLL_ANIMATION_MS) scroll.current.offset = event.nativeEvent.contentOffset.y;
        },
        onLayout(event: LayoutChangeEvent) {
          base.onLayout?.(event);
          scroll.current.viewport = event.nativeEvent.layout.height;
        },
      };
    }, [scrollbar.listProps]);
    const getItemLayout = useCallback(
      (_: unknown, index: number) => ({ length: TREE_ROW_HEIGHT, offset: index * TREE_ROW_HEIGHT, index }),
      [],
    );

    const onCheck = useCallback(
      (items: ChangeItem[]) => {
        const change = checkboxChange(items);
        if (change.unstage.length) void actions.files(change.unstage, "unstage");
        if (change.stage.length) void actions.files(change.stage, "stage");
        if (change.resolve.length) void actions.files(change.resolve, "resolve");
      },
      [actions],
    );

    const discard = useCallback(
      (entries: StatusEntry[]) =>
        confirm({
          title: entries.length === 1 ? "Discard changes" : "Discard all changes",
          message: discardMessage(entries),
          action: "Discard",
          onConfirm: () => void actions.files(entries, "discard"),
        }),
      [actions, confirm],
    );

    const copyPath = useCallback(
      (path: string) =>
        void copyText(path).then(
          () => toast.show("Path copied", { variant: "success" }),
          () => toast.error("Couldn't copy the path"),
        ),
      [toast],
    );

    const menuFor = (row: TreeRow): MenuEntry[] => {
      const items = row.kind === "file" ? [row.item] : row.items;
      const unstaged = unstagedOf(items);
      const staged = stagedOf(items);
      const conflicts = conflictsOf(items);
      const many = row.kind !== "file";
      const entries: MenuEntry[] = [];
      if (row.kind === "file" && !row.item.conflict) entries.push({ kind: "item", label: "Open diff", icon: "FileDiff", onSelect: () => onOpen(row.item) });
      if (unstaged.length) entries.push({ kind: "item", label: many ? "Stage all" : "Stage", icon: "Plus", onSelect: () => void actions.files(unstaged, "stage") });
      if (staged.length) entries.push({ kind: "item", label: many ? "Unstage all" : "Unstage", icon: "Minus", onSelect: () => void actions.files(staged, "unstage") });
      if (conflicts.length) entries.push({ kind: "item", label: "Mark resolved", icon: "Check", onSelect: () => void actions.files(conflicts, "resolve") });
      if (row.kind !== "group") {
        const path = row.kind === "file" ? row.item.path : row.dirPath;
        entries.push({ kind: "item", label: "Copy path", icon: "Copy", onSelect: () => copyPath(path) });
      }
      if (unstaged.length) {
        entries.push({ kind: "separator" });
        entries.push({ kind: "item", label: many ? "Discard all changes" : "Discard changes", icon: "Undo2", danger: true, onSelect: () => discard(unstaged) });
      }
      return entries;
    };

    // One object for the panel's lifetime, calling the latest callbacks, so memoized rows don't re-render for it.
    const latest = useRef({ onOpen, onCheck, menuFor });
    latest.current = { onOpen, onCheck, menuFor };
    const handlers = useMemo<RowHandlers>(
      () => ({
        onToggleCollapsed: (group, dirPath) => store.toggleTree(workspaceId, group, dirPath),
        onOpen: (item) => latest.current.onOpen(item),
        onCheck: (items) => latest.current.onCheck(items),
        menuFor: (row) => latest.current.menuFor(row),
        contextMenuProps: menu.contextMenuProps,
      }),
      [workspaceId, menu.contextMenuProps],
    );

    const openOptions = () =>
      menu.openBelow(optionsButton.current, [
        { kind: "header", label: "View" },
        { kind: "item", label: "List", checked: layout.view === "list", onSelect: () => layout.update({ changesView: "list" }) },
        { kind: "item", label: "Tree", checked: layout.view === "tree", onSelect: () => layout.update({ changesView: "tree" }) },
        { kind: "separator" },
        { kind: "header", label: "Group By" },
        { kind: "item", label: "None", checked: layout.groupBy === "none", onSelect: () => layout.update({ changesGroupBy: "none" }) },
        { kind: "item", label: "Tracked & Untracked", checked: layout.groupBy === "tracked", onSelect: () => layout.update({ changesGroupBy: "tracked" }) },
        { kind: "item", label: "Staged & Unstaged", checked: layout.groupBy === "staged", onSelect: () => layout.update({ changesGroupBy: "staged" }) },
      ]);

    const muted = { fontSize: 13, color: theme.colors.foregroundMuted, padding: 12 } as const;
    if (!status || !status.isRepo) {
      return (
        <View style={{ flex: 1 }}>
          {!status && !statusError ? (
            <ActivityIndicator style={{ padding: 24 }} color={theme.colors.foregroundMuted} />
          ) : (
            <Text style={muted}>{statusError ?? "This workspace isn't a git repository."}</Text>
          )}
        </View>
      );
    }

    return (
      <View style={{ flex: 1 }} ref={menu.rootRef}>
        <Header
          theme={theme}
          status={status}
          view={layout.view}
          optionsRef={optionsButton}
          foldersCollapsed={foldersCollapsed}
          onToggleFolders={() => store.setAllFoldersCollapsed(workspaceId, layout.groupBy, !foldersCollapsed)}
          onOptions={openOptions}
          onRefresh={() => void store.refresh(workspaceId)}
        />
        {statusError ? <Text style={[muted, { color: theme.colors.statusDanger }]}>{statusError}</Text> : null}
        {commitExpanded ? null : (
          <View style={{ flex: 1 }}>
          <FlatList
            ref={list}
            {...listProps}
            style={{ flex: 1 }}
            data={rows}
            extraData={version}
            keyExtractor={(row) => row.id}
            ListEmptyComponent={<Text style={muted}>No changes.</Text>}
            renderItem={({ item }) => (
              <ChangesRow
                theme={theme}
                row={item}
                view={layout.view}
                selected={item.kind === "file" && shows(state.selected, item.item)}
                handlers={handlers}
              />
            )}
            contentContainerStyle={{ paddingBottom: 32 }}
            getItemLayout={getItemLayout}
          />
          {scrollbar.overlay}
          </View>
        )}
        <CommitBox
          store={store}
          workspaceId={workspaceId}
          theme={theme}
          status={status}
          expanded={commitExpanded}
          onToggleExpanded={() => setCommitExpanded((expanded) => !expanded)}
          openMenu={menu.openBelow}
        />
        {confirmModal}
        {menu.element}
      </View>
    );
  };
}
