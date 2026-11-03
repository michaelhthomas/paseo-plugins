import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { copyText, FlatList, useToast } from "@getpaseo/plugin/client/react-native";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { LayoutChangeEvent, FlatList as NativeFlatList, View as NativeView } from "react-native";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import { fileKey, type StatusEntry } from "../shared/git";
import { discardMessage, useRepoActions } from "./actions";
import { IconButton, useConfirm } from "./controls";
import { commandForKey, moveCursor, resolveCursor, type DiffCursor } from "./diff-keys";
import { createBlockFocus } from "./block-focus";
import { CodeScrollbars, useCodeScroll } from "./code-scroll";
import { GapRow, LineRow, NoticeRow, SectionRow, SplitRow, type BlockHandlers, type DiffFrame } from "./diff-line";
import type { SyntaxColors } from "./syntax-theme";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  buildFileRows,
  diffKeyOf,
  entriesFor,
  expansionRange,
  itemKey,
  maxColumns,
  navigationItems,
  type Block,
  type BlockAction,
  type DiffItem,
  type Row,
} from "./diff-rows";
import { useDisplaySettings } from "./display-settings";
import { usePanelMenu, type MenuEntry } from "./menu";
import { useOverlayScrollbar } from "./overlay-scrollbar";
import { useColumnWidth } from "./column-width";
import { rowOffsets, type RowLayout } from "./row-layout";
import { useRepo, type RepoStore } from "./repo-store";
import { useSyntaxColors } from "./syntax-theme";
import { splitPath } from "./theme";
import { ChangeIcon, DiffStat, FileIcon } from "./tree-parts";

export const DIFF_PANEL_ID = "git-diff";

/** The most lines `git.lines` returns at once. */
const MAX_REVEAL = 2_000;

type RowOf<Kind extends Row["kind"]> = Extract<Row, { kind: Kind }>;

/** The last line of a gap one `git.lines` request reveals, and that request's key for the diff's version. */
const revealEnd = (row: RowOf<"gap">) => Math.min(row.end, row.start + MAX_REVEAL - 1);
const revealRequest = (row: RowOf<"gap">) => `${row.key}@${row.diff.newSideHash}:${row.start}-${revealEnd(row)}`;

type KeyEvent = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
  preventDefault?(): void;
};

const typingIn = (target: KeyEvent["target"]) =>
  !!target && (target.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName ?? ""));

/** What the list's non-line rows do; one stable object, like `BlockHandlers`. */
type ListHandlers = {
  onSectionCheck(row: RowOf<"section">): void;
  sectionMenu(row: RowOf<"section">): MenuEntry[];
  onForce(key: string): void;
  onExpand(row: RowOf<"gap">, direction: "up" | "down" | "all"): void;
  contextMenu: BlockHandlers["contextMenu"];
};

const listStyles = StyleSheet.create({ list: { flex: 1 }, content: { paddingBottom: 32 } });
const rowKey = (row: Row) => row.id;
const NO_ROWS: Row[] = [];
// About how long a smooth scroll runs; another key press sooner than this jumps instead of piling up animations.
const SCROLL_ANIMATION_MS = 300;

/**
 * The diff's rows. Memoized, and given only values that change when the shown rows do, so the panel can re-render
 * (header, cursor, scrollbars) without the list re-running `renderItem` for every mounted cell.
 */
const DiffList = memo(function DiffList({
  rows,
  theme,
  colors,
  frame,
  handlers,
  listHandlers,
  listRef,
  listProps,
  layout,
  initialIndex,
}: {
  rows: Row[];
  theme: PluginTheme;
  colors: SyntaxColors | null;
  frame: DiffFrame;
  handlers: BlockHandlers;
  listHandlers: ListHandlers;
  listRef: RefObject<NativeFlatList<Row> | null>;
  listProps: object;
  /** Where rows sit, worked out up front; null where text can't be measured (iOS and Android), so the list measures. */
  layout: RowLayout | null;
  /** The row to open at, when the list is made; needs `layout`. */
  initialIndex: number | null;
}) {
  const offsets = useMemo(() => (layout ? rowOffsets(rows, layout) : null), [rows, layout]);
  const getItemLayout = useMemo(
    () => (offsets ? (_: unknown, index: number) => ({ length: offsets[index + 1] - offsets[index], offset: offsets[index], index }) : undefined),
    [offsets],
  );
  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      switch (item.kind) {
        case "section":
          return <SectionRow theme={theme} row={item} frame={frame} onCheck={listHandlers.onSectionCheck} menuFor={listHandlers.sectionMenu} contextMenu={listHandlers.contextMenu} />;
        case "notice":
          return <NoticeRow theme={theme} row={item} frame={frame} onForce={listHandlers.onForce} />;
        case "gap":
          return <GapRow theme={theme} row={item} frame={frame} onExpand={listHandlers.onExpand} />;
        case "line":
          return <LineRow theme={theme} colors={colors} row={item} frame={frame} handlers={handlers} />;
        case "split":
          return <SplitRow theme={theme} colors={colors} row={item} frame={frame} handlers={handlers} />;
      }
    },
    [theme, colors, frame, handlers, listHandlers],
  );
  const onScrollToIndexFailed = useCallback(
    ({ index, averageItemLength }: { index: number; averageItemLength: number }) => {
      listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
      setTimeout(() => listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.1 }), 100);
    },
    [listRef],
  );
  return (
    <FlatList
      ref={listRef}
      {...listProps}
      style={listStyles.list}
      data={rows}
      keyExtractor={rowKey}
      renderItem={renderItem}
      getItemLayout={getItemLayout}
      initialScrollIndex={getItemLayout && initialIndex !== null ? initialIndex : undefined}
      // About a screen first, then small batches, and a short window either side: switching files mounts and
      // unmounts every one of these rows, so fewer of them is faster.
      initialNumToRender={40}
      maxToRenderPerBatch={20}
      windowSize={5}
      contentContainerStyle={listStyles.content}
      onScrollToIndexFailed={onScrollToIndexFailed}
    />
  );
});

export function createDiffPanel(store: RepoStore) {
  return function GitDiffPanel({ workspaceId, theme }: PluginWorkspacePanelProps) {
    const settings = useDisplaySettings();
    // Grouped by staged and unstaged, the Changes panel opens one side of a file; otherwise both, combined.
    const separate = settings.changesGroupBy === "staged";
    // Load diffs in the saved modes from the start, rather than loading them twice.
    useEffect(() => {
      if (!settings.ready) return;
      store.setIgnoreWhitespace(workspaceId, settings.hideWhitespace);
      store.setDiffMode(workspaceId, separate ? "separate" : "combined");
    }, [workspaceId, settings.ready, settings.hideWhitespace, separate]);
    useEffect(() => (settings.ready ? store.retain(workspaceId, { diffs: true }) : undefined), [workspaceId, settings.ready]);
    // Closed: opening a file has to ask Paseo to show the panel again.
    useEffect(() => () => store.setDiffVisible(workspaceId, false), [workspaceId]);
    const { state, version } = useRepo(store, workspaceId);
    const actions = useRepoActions(store, workspaceId);
    const colors = useSyntaxColors(theme);
    const { confirm, element: confirmModal } = useConfirm(theme);
    const menu = usePanelMenu(theme);
    const toast = useToast();
    const list = useRef<NativeFlatList<Row>>(null);
    const optionsButton = useRef<NativeView>(null);
    const scrollbar = useOverlayScrollbar(list, theme);
    const [viewport, setViewport] = useState(0);
    const [cursor, setCursor] = useState<DiffCursor>({ path: null, id: null, position: 0 });
    const focus = useRef(createBlockFocus()).current;
    // Set by keyboard moves: scroll the cursor's change into view once it's on screen.
    const scrollPending = useRef(false);
    const lastScroll = useRef(0);
    const { status, statusError } = state;
    const split = settings.diffLayout === "split";
    // Unwrapped lines scroll sideways, which only the web list can do.
    const wrap = settings.wrapLines || Platform.OS !== "web";

    // `state` is mutated in place; `version` says when.
    const items = useMemo(() => navigationItems(status, settings.changesView, settings.changesGroupBy), [status, version, settings.changesView, settings.changesGroupBy]);
    const keys = useMemo(() => items.map(itemKey), [items]);
    useEffect(() => store.setOrder(workspaceId, items.map(diffKeyOf)), [items, workspaceId]);
    // When the shown item goes away (committed, discarded, all of one side staged), show the one that took its place.
    // When only the grouping changed, keep the file.
    const lastIndex = useRef(0);
    const item = useMemo(() => {
      const selected = state.selected;
      const exact = selected && items.find((candidate) => candidate.path === selected.path && candidate.side === selected.side);
      const regrouped = selected && (selected.side === null) !== (items[0]?.side === null) ? items.find((candidate) => candidate.path === selected.path) : undefined;
      return exact ?? regrouped ?? items[Math.min(lastIndex.current, items.length - 1)] ?? null;
    }, [items, state.selected]);
    const key = item ? itemKey(item) : null;
    const fileIndex = key === null ? -1 : keys.indexOf(key);
    useEffect(() => {
      if (fileIndex >= 0) lastIndex.current = fileIndex;
      if (item) store.select(workspaceId, item);
    }, [item, fileIndex, workspaceId]);

    const rows = useMemo(() => buildFileRows(state, item, settings.diffLayout), [state, version, item, settings.diffLayout]);
    // Each block once, from its first row, in order.
    const blocks = useMemo(
      () => rows.flatMap((row) => ((row.kind === "line" || row.kind === "split") && row.blockStart && row.block ? [row.block] : [])),
      [rows],
    );
    const blockIds = useMemo(() => blocks.map((block) => block.id), [blocks]);
    const active = resolveCursor(cursor, key, blockIds);
    // Rows follow the cursor through the focus store, not props.
    useLayoutEffect(() => focus.set({ active }), [active, focus]);

    // With unchanged lines not collapsed, every gap in the shown file is revealed (below), a request's worth at a time.
    // Each range is asked for once per version of the diff, so a failure isn't retried on every render.
    const requested = useRef(new Set<string>());
    const [revealing, setRevealing] = useState(0);
    // Lines are still to be revealed above or among the changes, which would move them.
    const unrevealed = !settings.collapseUnchanged && (revealing > 0 || rows.some((row) => row.kind === "gap" && !requested.current.has(revealRequest(row))));

    // A file is drawn once it's complete: its diff loaded and, with unchanged lines not collapsed, every hidden line
    // revealed. Until then the list keeps the last complete rows (none the first time), so a file
    // never draws collapsed and then jumps as its lines arrive.
    const complete = !unrevealed && !rows.some((row) => row.kind === "notice" && row.id.endsWith("|loading"));
    const lastComplete = useRef<Row[] | null>(null);
    if (complete) lastComplete.current = rows;
    const ready = complete ? rows : (lastComplete.current ?? NO_ROWS);

    // The list renders a deferred copy of the rows. Rendering a file's rows is the slow part of switching files, and a
    // deferred render can be interrupted: holding j or l moves through files at key-repeat speed, the header keeping up,
    // and the list draws the file it stops on rather than every file passed on the way.
    const shownRows = useDeferredValue(ready);
    const digits = useMemo(() => shownRows.reduce((max, row) => ("digits" in row ? Math.max(max, row.digits) : max), 1), [shownRows]);
    const columns = useMemo(() => (wrap ? { left: 0, right: 0 } : maxColumns(shownRows)), [wrap, shownRows]);
    const codeScroll = useCodeScroll({ enabled: !wrap, split, viewport, digits, columns, resetKey: key });
    const frame = useMemo<DiffFrame>(() => ({ wrap, split, scrolls: codeScroll.enabled }), [wrap, split, codeScroll.enabled]);
    const columnWidth = useColumnWidth();
    const layout = useMemo<RowLayout | null>(
      () => (Platform.OS === "web" ? { wrap, split, viewport, columnWidth } : null),
      // Unwrapped rows don't depend on the width, so resizing the panel needn't lay them out again.
      [wrap, split, wrap ? viewport : 0, columnWidth],
    );

    // Another file reaching the list opens on the cursor's change (its first, unless stepped back into from the next
    // file). The list is made afresh for each file, starting at that row, so its first paint already shows it: no
    // scroll, and no blank frame while rows render at a scrolled-to position. Scrolling only then, not on every key
    // press, keeps rapid switching from re-rendering the outgoing file.
    const shownKey = shownRows[0]?.kind === "section" ? shownRows[0].key : null;
    const listHeight = useRef(0);
    const openAt = useMemo(() => {
      const index = shownRows.findIndex((row) => (row.kind === "line" || row.kind === "split") && row.blockStart && row.block?.id === active);
      if (index < 0 || !layout) return null;
      // A little above the change, like the scrolls to it (`viewPosition` 0.1).
      const offsets = rowOffsets(shownRows, layout);
      let start = index;
      while (start > 0 && offsets[index] - offsets[start - 1] <= listHeight.current * 0.1) start--;
      return start;
      // Only for the file reaching the list.
    }, [shownKey]);
    // The file the list last scrolled in; the first scroll in another file jumps.
    const scrolledKey = useRef<string | null>(null);
    useLayoutEffect(() => {
      // Opened at its change, or (its blocks not known yet) left for the scroll below.
      scrolledKey.current = openAt === null ? null : shownKey;
      scrollPending.current = openAt === null;
    }, [shownKey]);

    const show = useCallback(
      (next: DiffCursor) => {
        setCursor(next);
        const target = items.find((candidate) => itemKey(candidate) === next.path);
        if (target && next.path !== key) store.select(workspaceId, target);
        scrollPending.current = true;
      },
      [items, key, workspaceId],
    );

    // A file opened from the Changes panel: show its first change, straight away, and take the keyboard.
    useEffect(() => {
      if (state.focus === null) return;
      setCursor({ path: itemKey(state.focus), id: null, position: 0 });
      scrolledKey.current = null;
      scrollPending.current = true;
      // Without scrolling the app to it.
      (menu.rootRef.current as { focus?(options?: object): void } | null)?.focus?.({ preventScroll: true });
      store.clearFocus(workspaceId);
    }, [state.focus, workspaceId]);

    useEffect(() => {
      // Once the list shows the current rows, and they're done moving.
      if (!scrollPending.current || active === null || shownRows !== rows || unrevealed) return;
      const index = shownRows.findIndex((row) => (row.kind === "line" || row.kind === "split") && row.blockStart && row.block?.id === active);
      if (index < 0) return;
      scrollPending.current = false;
      const now = Date.now();
      const animated = scrolledKey.current === shownKey && now - lastScroll.current > SCROLL_ANIMATION_MS;
      scrolledKey.current = shownKey;
      lastScroll.current = now;
      const scroll = () => list.current?.scrollToIndex({ index, animated, viewPosition: 0.1 });
      // A jump goes now, with the reset to the top, so the top of the file never shows first.
      if (animated) requestAnimationFrame(scroll);
      else scroll();
    }, [active, rows, shownRows, shownKey, unrevealed]);

    const discardFiles = useCallback(
      (entries: StatusEntry[]) =>
        confirm({
          title: "Discard changes",
          message: discardMessage(entries),
          action: "Discard",
          onConfirm: () => void actions.files(entries, "discard"),
        }),
      [actions, confirm],
    );

    const restoreBlock = useCallback(
      (block: Block) =>
        confirm({
          title: "Restore change",
          message: `Discard this change to ${block.diff.path}? This can't be undone.`,
          action: "Restore",
          onConfirm: () => void actions.block(block, "discard"),
        }),
      [actions, confirm],
    );

    const copyPath = useCallback(
      (value: string) =>
        void copyText(value).then(
          () => toast.show("Path copied", { variant: "success" }),
          () => toast.error("Couldn't copy the path"),
        ),
      [toast],
    );

    // The file's checkbox: checked is staged, so checking stages whatever isn't yet, and unchecking unstages.
    const onSectionCheck = useCallback(
      (row: RowOf<"section">) => {
        if (row.unstaged) void actions.files([row.unstaged], "stage");
        else if (row.staged) void actions.files([row.staged], "unstage");
      },
      [actions],
    );
    const onBlockAction = useCallback(
      (block: Block, action: BlockAction) => (action === "discard" ? restoreBlock(block) : void actions.block(block, action)),
      [actions, restoreBlock],
    );
    const toggleBlock = useCallback(
      (block: Block) => void actions.block(block, block.origin === "staged" ? "unstage" : "stage"),
      [actions],
    );

    const sectionMenu = useCallback(
      (row: RowOf<"section">): MenuEntry[] => {
        const { staged, unstaged } = row;
        const entries: MenuEntry[] = [];
        if (unstaged) entries.push({ kind: "item", label: "Stage file", icon: "Plus", onSelect: () => void actions.files([unstaged], "stage") });
        if (staged) entries.push({ kind: "item", label: "Unstage file", icon: "Minus", onSelect: () => void actions.files([staged], "unstage") });
        entries.push({ kind: "item", label: "Copy path", icon: "Copy", onSelect: () => copyPath((unstaged ?? staged)!.path) });
        if (unstaged) entries.push({ kind: "separator" }, { kind: "item", label: "Discard unstaged changes", icon: "Undo2", danger: true, onSelect: () => discardFiles([unstaged]) });
        return entries;
      },
      [actions, copyPath, discardFiles],
    );

    const blockMenu = useCallback(
      (block: Block): MenuEntry[] => {
        if (!block.diff.patchable) return [];
        if (block.pending) return [];
        if (block.origin === "staged") return [{ kind: "item", label: "Unstage change", icon: "Minus", onSelect: () => onBlockAction(block, "unstage") }];
        return [
          { kind: "item", label: "Stage change", icon: "Plus", onSelect: () => onBlockAction(block, "stage") },
          { kind: "separator" },
          { kind: "item", label: "Restore change", icon: "Undo2", danger: true, onSelect: () => onBlockAction(block, "discard") },
        ];
      },
      [onBlockAction],
    );

    // Every line row takes this, so it's one object for the panel's lifetime that calls the latest callbacks: a new
    // one whenever the blocks change (any refresh) would re-render every row on screen.
    const latest = useRef({ key, blockIds, onBlockAction, blockMenu });
    latest.current = { key, blockIds, onBlockAction, blockMenu };
    const handlers = useMemo<BlockHandlers>(
      () => ({
        focus,
        onHover: (block) => focus.set({ hovered: block?.id ?? null }),
        onActivate: (block) => {
          const { key: current, blockIds: ids } = latest.current;
          setCursor({ path: current, id: block.id, position: Math.max(0, ids.indexOf(block.id)) });
        },
        onAction: (block, action) => latest.current.onBlockAction(block, action),
        menuFor: (block) => latest.current.blockMenu(block),
        contextMenu: menu.contextMenuProps,
      }),
      [menu.contextMenuProps, focus],
    );

    const onExpand = useCallback(
      (row: RowOf<"gap">, direction: "up" | "down" | "all") => {
        const range = expansionRange(row, direction);
        void actions.expand(row.diff, range.start, range.end);
      },
      [actions],
    );

    useEffect(() => {
      if (settings.collapseUnchanged) return;
      for (const row of rows) {
        if (row.kind !== "gap") continue;
        const request = revealRequest(row);
        if (requested.current.has(request)) continue;
        requested.current.add(request);
        setRevealing((count) => count + 1);
        void actions.expand(row.diff, row.start, revealEnd(row)).finally(() => setRevealing((count) => count - 1));
      }
    }, [settings.collapseUnchanged, rows, actions]);
    // Collapsing again hides what was revealed.
    const collapsedBefore = useRef(settings.collapseUnchanged);
    useEffect(() => {
      if (settings.collapseUnchanged && !collapsedBefore.current) {
        requested.current.clear();
        store.clearContext(workspaceId);
      }
      collapsedBefore.current = settings.collapseUnchanged;
    }, [settings.collapseUnchanged, workspaceId]);

    const onForce = useCallback((key: string) => store.force(workspaceId, key), [workspaceId]);

    const listLatest = useRef({ onSectionCheck, sectionMenu, onForce, onExpand });
    listLatest.current = { onSectionCheck, sectionMenu, onForce, onExpand };
    const listHandlers = useMemo<ListHandlers>(
      () => ({
        onSectionCheck: (row) => listLatest.current.onSectionCheck(row),
        sectionMenu: (row) => listLatest.current.sectionMenu(row),
        onForce: (key) => listLatest.current.onForce(key),
        onExpand: (row, direction) => listLatest.current.onExpand(row, direction),
        contextMenu: menu.contextMenuProps,
      }),
      [menu.contextMenuProps],
    );

    const onKeyDown = (event: KeyEvent) => {
      if (typingIn(event.target)) return;
      if (event.key === "Escape" && menu.element) return menu.close();
      const command = commandForKey(event);
      if (!command) return;
      event.preventDefault?.();
      if (command === "toggle-change") {
        const block = blocks.find((candidate) => candidate.id === active);
        if (block?.diff.patchable && !block.pending) toggleBlock(block);
        return;
      }
      const next = moveCursor(command, { paths: keys, path: key, blockIds, active });
      if (next) show(next);
    };

    const openOptions = () =>
      menu.openBelow(optionsButton.current, [
        { kind: "item", label: "Split view", icon: "Columns2", checked: split, onSelect: () => settings.update({ diffLayout: split ? "unified" : "split" }) },
        { kind: "item", label: "Hide whitespace", icon: "Space", checked: settings.hideWhitespace, onSelect: () => settings.update({ hideWhitespace: !settings.hideWhitespace }) },
        {
          kind: "item",
          label: "Collapse unchanged lines",
          icon: "FoldVertical",
          checked: settings.collapseUnchanged,
          onSelect: () => settings.update({ collapseUnchanged: !settings.collapseUnchanged }),
        },
        ...(Platform.OS === "web"
          ? [{ kind: "item" as const, label: "Wrap long lines", icon: "WrapText", checked: settings.wrapLines, onSelect: () => settings.update({ wrapLines: !settings.wrapLines }) }]
          : []),
        { kind: "separator" },
        { kind: "header", label: "Keyboard" },
        { kind: "header", label: "j k  ↓ ↑    Changes" },
        { kind: "header", label: "l h  → ←    Files" },
        { kind: "header", label: "s    Stage or unstage change" },
      ]);

    const muted = { color: theme.colors.foregroundMuted, fontSize: 13 } as const;

    let body;
    if (!status) {
      body = statusError ? (
        <Text style={[muted, { padding: 16 }]}>{statusError}</Text>
      ) : (
        <ActivityIndicator style={{ padding: 24 }} color={theme.colors.foregroundMuted} />
      );
    } else if (!status.isRepo) {
      body = <Text style={[muted, { padding: 16 }]}>This workspace isn't a git repository.</Text>;
    } else if (item === null) {
      body = <Text style={[muted, { padding: 16 }]}>No changes. The working tree is clean.</Text>;
    } else {
      body = (
        <View
          ref={codeScroll.attach as never}
          style={listStyles.list}
          onLayout={(event: LayoutChangeEvent) => {
            setViewport(event.nativeEvent.layout.width);
            listHeight.current = event.nativeEvent.layout.height;
          }}
          {...({ onWheel: codeScroll.onWheel } as object)}
        >
          <DiffList
            key={shownKey ?? ""}
            initialIndex={openAt}
            rows={shownRows}
            theme={theme}
            colors={colors}
            frame={frame}
            handlers={handlers}
            listHandlers={listHandlers}
            listRef={list}
            listProps={scrollbar.listProps}
            layout={layout}
          />
          {scrollbar.overlay}
          <CodeScrollbars theme={theme} scroll={codeScroll} />
        </View>
      );
    }

    const { name, dir } = splitPath(item?.path ?? "");
    const shownDiff = item ? (state.diffs.get(diffKeyOf(item)) ?? null) : null;
    const entries = entriesFor(status, item?.path ?? null);
    const shown = [item?.side !== "unstaged" ? entries.staged : null, item?.side !== "staged" ? entries.unstaged : null].flatMap((entry) => (entry ? [entry] : []));
    const sum = (pick: (entry: StatusEntry) => number | null) =>
      shown.reduce<number | null>((total, entry) => (total === null || pick(entry) === null ? null : total + pick(entry)!), 0);
    const stats =
      shownDiff && shownDiff.status !== "error"
        ? { additions: shownDiff.additions, deletions: shownDiff.deletions }
        : { additions: sum((entry) => entry.additions), deletions: sum((entry) => entry.deletions) };
    const kind = (shown.find((entry) => entry === entries.unstaged) ?? shown[0])?.kind;
    // Only while there's nothing to show yet; refreshes happen in place.
    const loading = item !== null && !shownDiff && state.loading.has(diffKeyOf(item));

    return (
      <View
        ref={menu.rootRef}
        // Zero-sized while its tab is in the background.
        onLayout={(event: LayoutChangeEvent) => {
          const { width, height } = event.nativeEvent.layout;
          store.setDiffVisible(workspaceId, width > 0 && height > 0);
        }}
        focusable
        {...({ onKeyDown } as object)}
        style={[{ flex: 1, backgroundColor: theme.colors.surface0 }, { outlineStyle: "none" } as object]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minHeight: 40,
            paddingLeft: 12,
            paddingRight: 4,
            borderBottomWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          {item !== null ? (
            <>
              <FileIcon name={name} theme={theme} />
              <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 14, color: theme.colors.foreground }}>
                {name}
                {dir ? <Text style={{ color: theme.colors.foregroundMuted }}>{` ${dir}`}</Text> : null}
              </Text>
              <DiffStat theme={theme} additions={stats.additions} deletions={stats.deletions} />
              {item.side ? <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>{item.side === "staged" ? "Staged" : "Unstaged"}</Text> : null}
              {kind ? <ChangeIcon kind={kind} theme={theme} /> : null}
            </>
          ) : null}
          <View style={{ flex: 1 }} />
          {loading ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
          {items.length > 0 ? (
            <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] }}>
              {fileIndex + 1} / {items.length}
            </Text>
          ) : null}
          <IconButton
            theme={theme}
            icon="ChevronLeft"
            size={14}
            label="Previous file"
            disabled={fileIndex <= 0}
            onPress={() => show({ path: keys[fileIndex - 1], id: null, position: 0 })}
          />
          <IconButton
            theme={theme}
            icon="ChevronRight"
            size={14}
            label="Next file"
            disabled={fileIndex < 0 || fileIndex >= items.length - 1}
            onPress={() => show({ path: keys[fileIndex + 1], id: null, position: 0 })}
          />
          <IconButton ref={optionsButton} theme={theme} icon="SlidersHorizontal" size={14} label="Diff options" onPress={openOptions} />
          <IconButton theme={theme} icon="RotateCw" size={14} label="Refresh" onPress={() => void store.refresh(workspaceId)} />
        </View>
        {body}
        {confirmModal}
        {menu.element}
      </View>
    );
  };
}
