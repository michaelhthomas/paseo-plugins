import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { copyText, FlatList, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { FlatList as NativeFlatList, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { Platform, Pressable, Text, View } from "react-native";
import type { AspireResource, LogLine } from "../shared/aspire";
import { aspireLogsRpc, aspireResourcesRpc } from "../shared/aspire";
import { AnsiSegments, isDarkTheme } from "./ansi-text";
import { describeError } from "./aspire-popover";
import { findScrollElement, listenForUserScroll, observeVisibility, offsetInViewport, type ScrollElement } from "./dom-scroll";
import { logsTarget } from "./logs-target";
import { MONO, TERMINAL_FONT_SIZE } from "./terminal-font";
import { isTouchLayout, TouchContext, useTouch } from "./touch";

export const LOGS_PANEL_ID = "aspire-logs";

const LOG_POLL_MS = 1_000;
const RESOURCE_POLL_MS = 5_000;
// One buffer holds every resource (tabs filter it), so keep plenty for quiet resources next to chatty ones.
const MAX_LINES = 20_000;
const FOLLOW_SLOP = 24;
const RESTORE_FRAMES = 6;
const TAB_SWITCH_REVEAL_FRAMES = 2;
// A tab shows only its latest lines at first, so it opens at the bottom without rendering its whole history; older
// lines are added in chunks when the user scrolls up to them.
const TAIL_ROWS = 300;
const OLDER_ROWS = 500;
// On web, how close to the top of the list (in px) scrolling has to get before older lines are added.
const OLDER_TRIGGER_PX = 400;
const ANCHOR_FRAMES = 12;
// Virtualization: the web list renders from its first row, so render the whole tail up front and placing it at the
// end doesn't show rows trickling in. The inverted native list starts at the newest line, so a screenful is enough.
// After that, large batches; only a few screens' worth of rows stay mounted.
const INITIAL_ROWS = Platform.OS === "web" ? TAIL_ROWS : 80;
const BATCH_ROWS = 200;
const WINDOW_SCREENS = 7;
const USER_SCROLL_WINDOW_MS = 1_000;
const SETTLE_MS = 250;
// On the native apps the list is inverted (newest line at offset 0): the usual React Native setup for logs and chat.
// Following then needs no programmatic scrolling, which a virtualized list on native doesn't always notice — it
// would keep rendering rows for the old position and show blank space. Web keeps a normal list.
const INVERTED = Platform.OS !== "web";

/**
 * Space below the last line so it clears the phone's home indicator / gesture bar. The SDK exposes no safe-area
 * insets, so use a fixed allowance: the native apps draw under the system bar; mobile browsers have their own chrome.
 */
function bottomInset(layout: { compact: boolean; platform: "ios" | "android" | "web" }) {
  if (layout.platform !== "web") return 48;
  return layout.compact ? 32 : 12;
}

// Like the Aspire dashboard: stderr lines get a lavender badge rather than being recolored, and the combined
// view labels each line with a pastel badge per resource.
const STDERR_BADGE = "#b9aaf5";
const BADGE_TEXT = "#1e1e1e";
const RESOURCE_BADGES = ["#f9b47c", "#c8bea2", "#9fd3f5", "#a6dea0", "#f5a6bd", "#f2d67a", "#8fdccf", "#f5aa9b", "#d9c0ee", "#c2d98f"];
const lineText = { fontFamily: MONO, fontSize: TERMINAL_FONT_SIZE, lineHeight: 19 } as const;

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ marginTop: 1, paddingHorizontal: 5, borderRadius: 5, backgroundColor: color }}>
      <Text numberOfLines={1} style={{ fontFamily: MONO, fontSize: TERMINAL_FONT_SIZE - 1, lineHeight: 17, color: BADGE_TEXT }}>
        {label}
      </Text>
    </View>
  );
}

const rowId = (seq: number) => `aspire-log-${seq}`;

type LogRowProps = {
  line: LogLine;
  number: number;
  /** Line numbers in a single resource's tab; null in the combined view, which shows resource badges instead. */
  gutterWidth: number | null;
  badgeColor: string | null;
  showTimestamp: boolean;
  theme: PluginTheme;
  dark: boolean;
  onOpenUrl(url: string): void;
};

// Memoized so the panel re-rendering on every poll doesn't re-render every mounted row.
const LogRow = memo(function LogRow({ line, number, gutterWidth, badgeColor, showTimestamp, theme, dark, onOpenUrl }: LogRowProps) {
  return (
    <View nativeID={rowId(line.seq)} style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, paddingVertical: 1 }}>
      {gutterWidth === null ? null : (
        <Text style={[lineText, { minWidth: gutterWidth, textAlign: "right", color: theme.colors.foregroundMuted }]}>{number}</Text>
      )}
      {showTimestamp ? <Text style={[lineText, { color: theme.colors.foregroundMuted }]}>{time(line.timestamp) || "        "}</Text> : null}
      {badgeColor === null ? null : <Badge label={line.resource} color={badgeColor} />}
      {line.stderr ? <Badge label="stderr" color={STDERR_BADGE} /> : null}
      <Text selectable style={[lineText, { flex: 1, color: theme.colors.foreground }]}>
        <AnsiSegments segments={line.segments} theme={theme} dark={dark} onOpenUrl={onOpenUrl} />
      </Text>
    </View>
  );
});

function stateColor(theme: PluginTheme, resource: AspireResource) {
  if (resource.state === "FailedToStart" || resource.health === "Unhealthy") return theme.colors.statusDanger;
  if (resource.state === "Running") return resource.health === "Degraded" ? theme.colors.statusWarning : theme.colors.statusSuccess;
  return theme.colors.foregroundMuted;
}

function time(timestamp: string | null) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toTimeString().slice(0, 8);
}

function Chip({ theme, label, active, color, onPress }: { theme: PluginTheme; label: string; active: boolean; color?: string; onPress(): void }) {
  const touch = useTouch();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: touch ? 14 : 12,
        paddingVertical: touch ? 10 : 6,
        borderRadius: touch ? 18 : 14,
        borderWidth: 1,
        borderColor: active ? theme.colors.accent : theme.colors.border,
        backgroundColor: active ? theme.colors.surface2 : pressed ? theme.colors.surface1 : "transparent",
      })}
    >
      {color ? <View style={{ width: touch ? 8 : 6, height: touch ? 8 : 6, borderRadius: 4, backgroundColor: color }} /> : null}
      <Text style={{ fontSize: touch ? 14 : 13, color: theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

function ToolButton({ theme, label, active, onPress }: { theme: PluginTheme; label: string; active?: boolean; onPress(): void }) {
  const touch = useTouch();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: touch ? 14 : 10,
        paddingVertical: touch ? 10 : 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: active ? theme.colors.accent : theme.colors.border,
        backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
      })}
    >
      <Text style={{ fontSize: touch ? 14 : 13, color: active ? theme.colors.accent : theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

/** Everything read from the app host's single combined log stream. Resource tabs are filters over it. */
type Feed = {
  lines: LogLine[];
  generation: number | null;
  cursor: number;
  running: boolean | null;
  /** The server has delivered the initial backlog; until then the list stays hidden. */
  loaded: boolean;
};

/** Per-tab ("All" or one resource) view state: where it was scrolled, and what the user cleared. */
type TabView = {
  following: boolean;
  offset: number;
  /**
   * `seq` of the oldest line shown. Null shows the latest `TAIL_ROWS`, sliding as lines arrive (while following);
   * otherwise the start stays put so what the user is reading doesn't move.
   */
  windowStart: number | null;
  /** Lines with `seq` at or below this were cleared from this tab. */
  clearedThrough: number;
};

/** A line as shown in a tab, with its line number within that resource's output. */
type Row = { line: LogLine; number: number };

/** Per-workspace panel state. Lives outside the component so leaving and returning to the panel restores it. */
type PanelView = {
  filter: string;
  showTimestamps: boolean;
  resources: AspireResource[];
  feed: Feed;
  tabs: Map<string, TabView>;
};

export function createLogsPanel(client: PluginClientContext) {
  const views = new Map<string, PanelView>();

  const viewFor = (workspaceId: string) => {
    let view = views.get(workspaceId);
    if (!view) {
      view = {
        filter: "",
        showTimestamps: false,
        resources: [],
        feed: { lines: [], generation: null, cursor: 0, running: null, loaded: false },
        tabs: new Map(),
      };
      views.set(workspaceId, view);
    }
    return view;
  };

  const tabFor = (view: PanelView, resource: string | null) => {
    const key = resource ?? "*";
    let tab = view.tabs.get(key);
    if (!tab) {
      tab = { following: true, offset: 0, windowStart: null, clearedThrough: 0 };
      view.tabs.set(key, tab);
    }
    return tab;
  };

  return function AspireLogsPanel({ workspaceId, theme, layout }: PluginWorkspacePanelProps) {
    useSyncExternalStore(logsTarget.subscribe, logsTarget.getVersion, logsTarget.getVersion);
    const resource = logsTarget.get(workspaceId);
    const view = viewFor(workspaceId);
    const { feed } = view;
    const tab = tabFor(view, resource);
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    const [error, setError] = useState<string | null>(null);
    const list = useRef<NativeFlatList<Row>>(null);
    const container = useRef<View>(null);
    // The DOM element that actually scrolls (web only), found under `container`.
    const scrollElement = useRef<ScrollElement | null>(null);
    // While a scroll position is being reapplied, ignore scroll events (they're ours, not the user's).
    const restoring = useRef(false);
    // The tab whose rows have been placed at their scroll position; the list is hidden until then.
    const [revealedTab, setRevealedTab] = useState<TabView | null>(null);
    const hidden = useRef(false);
    // When the user last did something that scrolls up; only that may turn following off.
    const userScrolledAt = useRef(0);
    // Auto-scroll must not fight the user: hold it while a finger is down and until scrolling has settled
    // (momentum after a flick keeps pushing this forward).
    const touching = useRef(false);
    // The previous scroll offset, to tell scrolling up (the user leaving the bottom) from the list growing.
    const lastOffset = useRef(0);
    const settledAt = useRef(0);
    const catchUp = useRef<ReturnType<typeof setTimeout> | null>(null);
    const tabRef = useRef(tab);
    tabRef.current = tab;

    const { lines, running, loaded } = feed;
    const { following } = tab;
    const revealed = loaded && revealedTab === tab;
    const { resources, filter, showTimestamps } = view;
    const touch = isTouchLayout(layout);
    const update = (change: () => void) => {
      change();
      rerender();
    };
    // The rows currently in the list (the tab's window), for handlers defined before they're computed.
    const shownRef = useRef<Row[]>([]);
    const setFollowing = (value: boolean) =>
      update(() => {
        tab.following = value;
        // Following shows the latest lines; stopping pins the current start so arriving lines don't trim what's
        // on screen.
        tab.windowStart = value ? null : (shownRef.current[0]?.line.seq ?? null);
      });

    const scrollToBottom = () => {
      const element = scrollElement.current;
      if (element) element.scrollTop = element.scrollHeight;
      else if (INVERTED) list.current?.scrollToOffset({ offset: 0, animated: false });
      else list.current?.scrollToEnd({ animated: false });
    };

    const scrollToOffset = (offset: number) => {
      const element = scrollElement.current;
      if (element) element.scrollTop = offset;
      else list.current?.scrollToOffset({ offset, animated: false });
    };

    /**
     * Puts the current tab back where it was (the end when following, otherwise the saved offset), repeating for a
     * few frames because the list renders more rows after each scroll.
     */
    const restoreScroll = (onPlaced?: () => void, placedAfterFrames = RESTORE_FRAMES) => {
      restoring.current = true;
      let frames = 0;
      const step = () => {
        const target = tabRef.current;
        if (target.following) scrollToBottom();
        else scrollToOffset(target.offset);
        frames += 1;
        if (frames === placedAfterFrames) onPlaced?.();
        if (frames < RESTORE_FRAMES) requestAnimationFrame(step);
        else restoring.current = false;
      };
      requestAnimationFrame(step);
    };

    // Once the backlog is loaded, and whenever the tab changes, place the tab's rows while hidden, then show them.
    // The first placement waits for every correction frame (it's behind the loading indicator anyway); a tab switch
    // reveals as soon as the position is roughly set so switching doesn't blink, and keeps correcting while visible.
    const firstPlacement = useRef(true);
    useEffect(() => {
      if (!loaded || revealedTab === tab) return;
      const placedAfter = firstPlacement.current ? RESTORE_FRAMES : TAB_SWITCH_REVEAL_FRAMES;
      firstPlacement.current = false;
      restoreScroll(() => setRevealedTab(tab), placedAfter);
    }, [tab, loaded, revealedTab]);

    useEffect(() => {
      let live = true;
      let handle: ReturnType<typeof setTimeout> | null = null;
      const load = async () => {
        try {
          const next = await client.rpc(aspireResourcesRpc, { workspaceId });
          if (live) update(() => (view.resources = next.resources));
        } catch {
          // The log poll reports errors; the chips just keep their last value.
        }
        if (live) handle = setTimeout(load, RESOURCE_POLL_MS);
      };
      void load();
      return () => {
        live = false;
        if (handle) clearTimeout(handle);
      };
    }, [workspaceId]);

    useEffect(() => {
      let live = true;
      let handle: ReturnType<typeof setTimeout> | null = null;
      // Resumes from the feed's saved cursor, so returning to the panel only fetches what arrived meanwhile.
      const load = async () => {
        try {
          const next = await client.rpc(aspireLogsRpc, { workspaceId, generation: feed.generation, after: feed.cursor });
          if (!live) return;
          const reset = next.generation !== feed.generation;
          feed.generation = next.generation;
          feed.cursor = next.cursor;
          if (reset) {
            for (const stale of view.tabs.values()) {
              stale.clearedThrough = 0;
              stale.windowStart = null;
            }
          }
          if (reset || next.lines.length) {
            const merged = reset ? next.lines : feed.lines.concat(next.lines);
            feed.lines = merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged;
          }
          feed.running = next.running;
          feed.loaded = !next.loading;
          setError(next.error);
          rerender();
        } catch (e) {
          if (live) setError(describeError(e));
        }
        if (live) handle = setTimeout(load, LOG_POLL_MS);
      };
      void load();
      return () => {
        live = false;
        if (handle) clearTimeout(handle);
      };
    }, [workspaceId, feed]);

    // Log lines are labelled with the resource's display name; match the selected resource by either name.
    const selectedName = resource === null ? null : (resources.find((r) => r.name === resource)?.displayName ?? null);
    const { clearedThrough } = tab;
    const rows = useMemo(() => {
      const names = new Set([resource, selectedName]);
      const tabLines = resource === null ? lines : lines.filter((line) => names.has(line.resource));
      const numbered = tabLines.map((line, i): Row => ({ line, number: i + 1 })).filter((row) => row.line.seq > clearedThrough);
      const needle = filter.trim().toLowerCase();
      return needle ? numbered.filter((row) => row.line.text.toLowerCase().includes(needle)) : numbered;
    }, [lines, resource, selectedName, clearedThrough, filter]);

    const { windowStart } = tab;
    const shown = useMemo(() => {
      const tail = Math.max(0, rows.length - TAIL_ROWS);
      const start = windowStart === null ? tail : rows.findIndex((row) => row.line.seq >= windowStart);
      return rows.slice(start < 0 ? tail : start);
    }, [rows, windowStart]);
    shownRef.current = shown;
    const hasOlder = shown.length < rows.length;
    const loadingOlder = useRef(false);

    /** Adds the next chunk of older lines above the window. */
    const loadOlder = () => {
      const first = shown[0];
      if (!hasOlder || !first || loadingOlder.current) return;
      const index = rows.indexOf(first);
      const start = rows[Math.max(0, index - OLDER_ROWS)];
      const element = scrollElement.current;
      update(() => (tab.windowStart = start.line.seq));
      // The inverted native list adds them past its far end, so nothing on screen moves.
      if (INVERTED || !element) return;
      // On web they go above what's on screen. The virtualized list doesn't keep the visible rows in place (it renders
      // by index, and every index just shifted), so put the previously first row back where it was over a few frames,
      // estimating its position from the average row height until it has rendered.
      const id = rowId(first.line.seq);
      const before = offsetInViewport(element, id);
      const added = index - rows.indexOf(start);
      const estimate = element.scrollTop + added * (element.scrollHeight / Math.max(1, shown.length));
      loadingOlder.current = true;
      restoring.current = true;
      let frames = 0;
      let settled = 0;
      const step = () => {
        const now = offsetInViewport(element, id);
        if (now === null || before === null) element.scrollTop = estimate;
        else if (Math.abs(now - before) < 1) settled += 1;
        else {
          element.scrollTop += now - before;
          settled = 0;
        }
        frames += 1;
        if (frames < ANCHOR_FRAMES && settled < 2) {
          requestAnimationFrame(step);
          return;
        }
        tab.offset = lastOffset.current = element.scrollTop;
        restoring.current = false;
        loadingOlder.current = false;
      };
      requestAnimationFrame(step);
    };

    const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      // A hidden panel reports a zero-height viewport and a reset offset; that isn't the user scrolling.
      if (hidden.current || layoutMeasurement.height === 0) return;
      // In the inverted (native) list the newest line is at offset 0, so "away from the bottom" is a growing offset.
      const movedAway = INVERTED ? contentOffset.y > lastOffset.current + 1 : contentOffset.y < lastOffset.current - 1;
      lastOffset.current = contentOffset.y;
      if (!revealed || restoring.current) return;
      if (userBusy()) holdAutoScroll();
      tab.offset = contentOffset.y;
      // The inverted native list loads older lines through `onEndReached` instead.
      if (!INVERTED && hasOlder && contentOffset.y < OLDER_TRIGGER_PX) loadOlder();
      const fromBottom = INVERTED ? contentOffset.y : contentSize.height - (contentOffset.y + layoutMeasurement.height);
      if (fromBottom <= FOLLOW_SLOP) {
        if (!tab.following) setFollowing(true);
      } else if (tab.following && movedAway && Date.now() - userScrolledAt.current < USER_SCROLL_WINDOW_MS) {
        // Only the user scrolling away from the newest line stops following. Lines arriving (or rows rendering)
        // grow the list beyond the viewport, and our own scrolls move toward the newest line, so neither counts.
        setFollowing(false);
      }
    };

    // Scroll events are throttled, so the resting position after a drag or flick may never be reported by onScroll.
    const onDragEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onTouchEnd();
      onScroll(event);
    };
    const onMomentumEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      markUserScroll();
      onScroll(event);
    };

    const userBusy = () => touching.current || Date.now() < settledAt.current;

    /** Pauses auto-scroll until the user has been still for a moment, then catches up if still following. */
    const holdAutoScroll = () => {
      settledAt.current = Date.now() + SETTLE_MS;
      if (catchUp.current) clearTimeout(catchUp.current);
      catchUp.current = setTimeout(function check() {
        if (userBusy()) {
          catchUp.current = setTimeout(check, SETTLE_MS);
          return;
        }
        catchUp.current = null;
        if (tabRef.current.following && !hidden.current) scrollToBottom();
      }, SETTLE_MS);
    };
    useEffect(() => () => {
      if (catchUp.current) clearTimeout(catchUp.current);
    }, []);

    const markUserScroll = () => {
      userScrolledAt.current = Date.now();
      holdAutoScroll();
    };
    const onTouchStart = () => {
      touching.current = true;
      markUserScroll();
    };
    const onTouchEnd = () => {
      touching.current = false;
      markUserScroll();
    };

    // Paseo keeps inactive panels mounted but hidden with `display: none` (its RetainedPanel). The browser drops a
    // hidden element's scroll position and nothing re-renders when the tab comes back, so watch the DOM element.
    const listShown = running !== false;
    useEffect(() => {
      const element = findScrollElement(container.current);
      scrollElement.current = element;
      if (!element) return;
      const stopVisibility = observeVisibility(
        element,
        () => (hidden.current = true),
        () => {
          hidden.current = false;
          restoreScroll();
        },
      );
      const stopIntent = listenForUserScroll(element, markUserScroll, onTouchStart, onTouchEnd);
      return () => {
        stopVisibility();
        stopIntent();
        scrollElement.current = null;
      };
    }, [listShown]);

    // The inverted native list stays on the newest line by itself (new rows appear at offset 0), so only the web
    // list needs to be pushed to the end as it grows.
    const onContentSizeChange = () => {
      if (!INVERTED && revealed && following && !hidden.current && !userBusy()) scrollToBottom();
    };
    const listRows = useMemo(() => (INVERTED ? shown.slice().reverse() : shown), [shown]);

    const copyVisible = () => {
      void copyText(rows.map(({ line }) => (resource ? line.text : `[${line.resource}] ${line.text}`)).join("\n")).catch(() => {});
    };

    const muted = { fontSize: 12, color: theme.colors.foregroundMuted } as const;
    const dark = useMemo(() => isDarkTheme(theme), [theme]);
    const gutterWidth = Math.max(3, String(rows[rows.length - 1]?.number ?? 0).length) * TERMINAL_FONT_SIZE * 0.62;
    // Log lines carry the display name; replicas share one, so they share a color too.
    const badgeIndex = useMemo(() => {
      const names = [...new Set(resources.map((r) => r.displayName))].sort();
      return new Map(names.map((name, i) => [name, i]));
    }, [resources]);
    const badgeColorFor = (name: string) => {
      let index = badgeIndex.get(name);
      if (index === undefined) {
        index = 0;
        for (const ch of name) index = (index * 31 + ch.charCodeAt(0)) >>> 0;
      }
      return RESOURCE_BADGES[index % RESOURCE_BADGES.length];
    };
    const openUrl = useCallback((url: string) => void openExternalUrl(url).catch((e: unknown) => setError(describeError(e))), []);
    // Sits above the oldest shown line (the list's header on web, the footer of the flipped native list).
    const olderNotice = hasOlder ? <Text style={[muted, { paddingBottom: 6 }]}>Loading earlier lines…</Text> : null;

    return (
      <TouchContext.Provider value={touch}>
        <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
          <View style={{ gap: 8, padding: layout.compact ? 8 : 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              <Chip theme={theme} label="All" active={resource === null} onPress={() => logsTarget.set(workspaceId, null)} />
              {resources.map((r) => (
                <Chip
                  key={r.name}
                  theme={theme}
                  label={r.displayName}
                  active={resource === r.name}
                  color={stateColor(theme, r)}
                  onPress={() => logsTarget.set(workspaceId, r.name)}
                />
              ))}
            </ScrollView>
            <View style={{ flexDirection: "row", alignItems: "center", gap: touch ? 8 : 6, flexWrap: touch ? "wrap" : "nowrap" }}>
              <TextInput
                value={filter}
                onChangeText={(text) => update(() => (view.filter = text))}
                placeholder="Filter"
                placeholderTextColor={theme.colors.foregroundMuted}
                accessibilityLabel="Filter log lines"
                style={{
                  flex: 1,
                  ...(touch ? { flexBasis: "100%" } : null),
                  fontSize: touch ? 14 : 13,
                  paddingHorizontal: touch ? 12 : 10,
                  paddingVertical: touch ? 10 : 6,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface1,
                }}
              />
              <ToolButton theme={theme} label="Time" active={showTimestamps} onPress={() => update(() => (view.showTimestamps = !view.showTimestamps))} />
              <ToolButton
                theme={theme}
                label={following ? "Following" : "Follow"}
                active={following}
                onPress={() => {
                  setFollowing(true);
                  // Same multi-frame placement as switching tabs: lands on the newest line in either list orientation,
                  // even when the rows there haven't been rendered yet.
                  restoreScroll();
                }}
              />
              <ToolButton theme={theme} label="Copy" onPress={copyVisible} />
              <ToolButton theme={theme} label="Clear" onPress={() => update(() => (tab.clearedThrough = lines[lines.length - 1]?.seq ?? 0))} />
            </View>
          </View>

          {running === false ? (
            <View style={{ padding: 16 }}>
              <Text style={muted}>The Aspire app host for this workspace isn't running. Start it from the Aspire button in the header.</Text>
            </View>
          ) : (
            <View ref={container} style={{ flex: 1 }}>
              {/* Kept laid out but invisible until loaded and placed, so it can be scrolled into position first. */}
              <FlatList
                ref={list}
                style={{ opacity: revealed ? 1 : 0 }}
                data={listRows}
                inverted={INVERTED}
                // Scrolled away from the newest line, keep the visible lines still as new ones arrive; within the
                // threshold, snap to the newest line (that's following).
                maintainVisibleContentPosition={INVERTED ? { minIndexForVisible: 0, autoscrollToTopThreshold: FOLLOW_SLOP } : undefined}
                keyExtractor={(row) => String(row.line.seq)}
                initialNumToRender={INITIAL_ROWS}
                maxToRenderPerBatch={BATCH_ROWS}
                updateCellsBatchingPeriod={16}
                windowSize={WINDOW_SCREENS}
                onScroll={onScroll}
                onScrollBeginDrag={onTouchStart}
                onScrollEndDrag={onDragEnd}
                onMomentumScrollBegin={markUserScroll}
                onMomentumScrollEnd={onMomentumEnd}
                scrollEventThrottle={100}
                onContentSizeChange={onContentSizeChange}
                // An inverted list is flipped: its visual bottom is the content's top, and short content would sit at
                // the visual bottom. Filling the viewport and justifying to the (flipped) end pins it to the top instead,
                // along with the empty-state text.
                contentContainerStyle={{
                  padding: layout.compact ? 8 : 12,
                  [INVERTED ? "paddingTop" : "paddingBottom"]: bottomInset(layout),
                  ...(INVERTED ? { flexGrow: 1, justifyContent: "flex-end" } : null),
                }}
                ListEmptyComponent={<Text style={muted}>{filter ? "No matching lines." : "No log output yet."}</Text>}
                ListHeaderComponent={INVERTED ? null : olderNotice}
                ListFooterComponent={INVERTED ? olderNotice : null}
                onEndReached={INVERTED ? loadOlder : undefined}
                onEndReachedThreshold={1}
                renderItem={({ item: { line, number } }) => (
                  <LogRow
                    line={line}
                    number={number}
                    gutterWidth={resource === null ? null : gutterWidth}
                    badgeColor={resource === null ? badgeColorFor(line.resource) : null}
                    showTimestamp={showTimestamps}
                    theme={theme}
                    dark={dark}
                    onOpenUrl={openUrl}
                  />
                )}
              />
              {loaded ? null : (
                <View style={{ position: "absolute", top: 0, left: 0, right: 0, padding: layout.compact ? 8 : 12 }}>
                  <Text style={muted}>Loading logs…</Text>
                </View>
              )}
            </View>
          )}

          {error ? (
            <View style={{ padding: 8, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
              <Text style={{ fontSize: 12, color: theme.colors.statusDanger }}>{error}</Text>
            </View>
          ) : null}
        </View>
      </TouchContext.Provider>
    );
  };
}
