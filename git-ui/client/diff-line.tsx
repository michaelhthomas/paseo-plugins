import type { PluginTheme } from "@getpaseo/plugin";
import { memo, type ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { StatusEntry, Token } from "../shared/git";
import type { CheckState } from "./changes-tree";
import { IconButton, TextButton } from "./controls";
import { EXPAND_STEP, type Block, type BlockAction, type Cell, type Row } from "./diff-rows";
import type { SyntaxColors } from "./syntax-theme";
import { useBlockFocus, type BlockFocus } from "./block-focus";
import { SHIFTED_CODE } from "./code-scroll";
import { CODE_PADDING_RIGHT, gutterWidth, LINE_HEIGHT, SIGN_WIDTH, SPLIT_DIVIDER } from "./diff-metrics";
import { terminalFont } from "./terminal-font";
import type { MenuEntry } from "./menu";
import { Checkbox, DiffStat } from "./tree-parts";

const codeText = { ...terminalFont, lineHeight: LINE_HEIGHT } as const;
// Web-only styles that react-native-web passes through. Wrapped code may break inside a word that doesn't fit, which
// also lets it shrink to its column instead of overflowing.
const noWrapText = { whiteSpace: "pre" } as object;
const wrapText = { overflowWrap: "anywhere" } as object;

type RowOf<Kind extends Row["kind"]> = Extract<Row, { kind: Kind }>;

/**
 * How rows lay out. Without wrapping (web only) `scrolls` is set: rows stay as wide as the panel and only the code
 * moves sideways, so gutters, headers and the other side of a split row stay in view.
 */
export type DiffFrame = { wrap: boolean; split: boolean; scrolls: boolean };

const sameFields = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key]);
};

/**
 * Rows are rebuilt whenever repo state changes, so compare them field by field. Their fields point into the loaded
 * diffs, which keep their identity until the file's diff is refetched; a split row's cells are rebuilt with it, so
 * they're compared field by field too.
 */
function sameProps<P extends { row: object }>(prev: P, next: P) {
  for (const key of Object.keys(next) as (keyof P)[]) {
    if (key === "row") continue;
    if (prev[key] !== next[key]) return false;
  }
  const a = prev.row as Record<string, unknown>;
  const b = next.row as Record<string, unknown>;
  const keys = Object.keys(b);
  return (
    keys.length === Object.keys(a).length &&
    keys.every((key) => {
      if (a[key] === b[key]) return true;
      const [x, y] = [a[key], b[key]];
      return (key === "left" || key === "right") && !!x && !!y && sameFields(x as Record<string, unknown>, y as Record<string, unknown>);
    })
  );
}

/*
 * Line rows are the bulk of what the Diff panel renders. Their styles are plain objects made once and reused. Not
 * StyleSheet.create: on web that compiles to CSS classes, and Paseo's own font for Text then wins over the monospace
 * font, which only inline styles override.
 */
function cached<T>(cache: Map<string, T>, key: string, make: () => T): T {
  let value = cache.get(key);
  if (value === undefined) cache.set(key, (value = make()));
  return value;
}

const themeStyles = new WeakMap<PluginTheme, ReturnType<typeof makeThemeStyles>>();

function makeThemeStyles(theme: PluginTheme) {
  return {
    gutter: { ...codeText, paddingRight: 8, textAlign: "right", color: theme.colors.foregroundMuted, opacity: 0.75 },
    code: { ...codeText, paddingRight: CODE_PADDING_RIGHT, color: theme.colors.foreground },
    muted: { ...codeText, color: theme.colors.foregroundMuted },
  } as const;
}

const stylesFor = (theme: PluginTheme) => {
  let styles = themeStyles.get(theme);
  if (!styles) themeStyles.set(theme, (styles = makeThemeStyles(theme)));
  return styles;
};

const shared = {
  row: { flexDirection: "row", minHeight: LINE_HEIGHT },
  wrapped: { flex: 1, minWidth: 0 },
  clip: { flex: 1, minWidth: 0, overflow: "hidden" },
  // As wide as the line, which doesn't wrap (web only, where lines can scroll).
  maxContent: { width: "max-content" as unknown as number, alignSelf: "flex-start" },
  sign: { ...codeText, width: SIGN_WIDTH },
} as const;

const colorStyles = new Map<string, object>();
const codeColor = (color: string) => cached(colorStyles, color, () => ({ ...codeText, color }));
const widthStyles = new Map<string, object>();
const widthOf = (width: number) => cached(widthStyles, String(width), () => ({ width }));
const tintStyles = new Map<string, object>();
const tintStyle = (color: string, opacity: number) =>
  cached(tintStyles, `${color}|${opacity}`, () => ({ position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, backgroundColor: color, opacity }));

/** A wash of `color` behind a row, so any theme color format works without parsing it. */
function Tint({ color, opacity }: { color: string; opacity: number }) {
  return <View pointerEvents="none" style={tintStyle(color, opacity)} />;
}

function Gutter({ theme, value, digits }: { theme: PluginTheme; value: number | string | null; digits: number }) {
  return <Text style={[stylesFor(theme).gutter, widthOf(gutterWidth(digits))]}>{value ?? ""}</Text>;
}

/**
 * A line's highlighted text. Neighbouring tokens of the same color share one element (whitespace between keywords
 * usually takes the plain color), which roughly halves the elements a line needs.
 */
function Tokens({ tokens, content, colors, fallback }: { tokens: Token[] | null; content: string; colors: SyntaxColors | null; fallback: string }) {
  // An empty line still needs its height.
  if (!content) return <Text style={codeColor(fallback)}> </Text>;
  if (!tokens || !colors) return <Text style={codeColor(fallback)}>{content}</Text>;
  const runs: [string, string][] = [];
  for (const [text, role] of tokens) {
    const color = (role && colors[role]) || fallback;
    const last = runs[runs.length - 1];
    // Whitespace looks the same in any color: it joins the run before it, and a run of only whitespace (indentation)
    // takes the color of what follows.
    if (last && (last[1] === color || !text.trim())) last[0] += text;
    else if (last && !last[0].trim()) [last[0], last[1]] = [last[0] + text, color];
    else runs.push([text, color]);
  }
  return (
    <>
      {runs.map(([text, color], i) => (
        <Text key={i} style={codeColor(color)}>
          {text}
        </Text>
      ))}
    </>
  );
}

const tintFor = (theme: PluginTheme, type: Cell["type"]) =>
  type === "add" ? theme.colors.statusSuccess : type === "remove" ? theme.colors.statusDanger : null;
const signFor = (type: Cell["type"]) => (type === "add" ? "+" : type === "remove" ? "-" : " ");

/** A line's code: wrapped to the space left after the gutters, or on one line and shifted by the side's scroll. */
function Code({ theme, colors, line, scroll }: { theme: PluginTheme; colors: SyntaxColors | null; line: Omit<Cell, "no">; scroll: boolean }) {
  const styles = stylesFor(theme);
  const text = (
    <Text selectable style={[styles.code, scroll ? noWrapText : [shared.wrapped, wrapText]]}>
      <Tokens tokens={line.tokens} content={line.content} colors={colors} fallback={theme.colors.foreground} />
      {line.noNewline ? (
        <Text accessibilityLabel="No newline at end of file" style={styles.muted}>
          {"  ⊘ no newline"}
        </Text>
      ) : null}
    </Text>
  );
  if (!scroll) return text;
  return (
    <View style={shared.clip}>
      {/* Shifted by the list's --gitui-shift variable (code-scroll.tsx). */}
      <View {...({ dataSet: SHIFTED_CODE } as object)} style={shared.maxContent}>
        {text}
      </View>
    </View>
  );
}

type ContextMenu = (entries: () => MenuEntry[]) => object;

/** What a row with changed lines can do; one stable object from the panel. */
export type BlockHandlers = {
  /** The pointer entered (or, with null, left) a block's lines. */
  onHover(block: Block | null): void;
  onActivate(block: Block): void;
  onAction(block: Block, action: BlockAction): void;
  menuFor(block: Block): MenuEntry[];
  contextMenu: ContextMenu;
  /** The cursor's and the pointer's block; each row follows just its own. */
  focus: BlockFocus;
};

const BLOCK_BAR_WIDTH = 3;

function blockColor(theme: PluginTheme, block: Block) {
  return block.kind === "add" ? theme.colors.statusSuccess : block.kind === "remove" ? theme.colors.statusDanger : theme.colors.statusWarning;
}

/** An outline around a staged block, drawn a row at a time: sides on every row, top and bottom on the ends. */
function BlockOutline({ theme, block, start, end }: { theme: PluginTheme; block: Block; start: boolean; end: boolean }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 1,
        borderColor: blockColor(theme, block),
        opacity: 0.7,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderTopWidth: start ? 1 : 0,
        borderBottomWidth: end ? 1 : 0,
      }}
    />
  );
}

/** The bar along a block's lines: solid for unstaged changes, hollow for staged ones. */
function BlockBar({ theme, block }: { theme: PluginTheme; block: Block }) {
  const color = blockColor(theme, block);
  const staged = block.origin === "staged";
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: 0,
        width: BLOCK_BAR_WIDTH,
        zIndex: 2,
        backgroundColor: staged ? "transparent" : color,
        borderLeftWidth: staged ? 1 : 0,
        borderRightWidth: staged ? 1 : 0,
        borderColor: color,
      }}
    />
  );
}

function ToolbarButton({ theme, label, onPress }: { theme: PluginTheme; label: string; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} change`}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        height: LINE_HEIGHT - 4,
        paddingHorizontal: 7,
        borderRadius: 4,
        justifyContent: "center",
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <Text style={{ fontSize: 12, color: theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

/**
 * Stage and Restore (Unstage for staged changes), floating at the top right of a block. Exactly a line tall, so it
 * never spills onto the next row.
 */
function BlockToolbar({ theme, block, onAction }: { theme: PluginTheme; block: Block; onAction: BlockHandlers["onAction"] }) {
  const staged = block.origin === "staged";
  const toolbar = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        height: LINE_HEIGHT,
        paddingHorizontal: 1,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        shadowColor: "rgba(0, 0, 0, 0.2)",
        shadowOpacity: 1,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 4,
        elevation: 4,
      }}
    >
      {staged ? (
        <ToolbarButton theme={theme} label="Unstage" onPress={() => onAction(block, "unstage")} />
      ) : (
        <>
          <ToolbarButton theme={theme} label="Stage" onPress={() => onAction(block, "stage")} />
          <ToolbarButton theme={theme} label="Restore" onPress={() => onAction(block, "discard")} />
        </>
      )}
    </View>
  );
  return <View style={{ position: "absolute", top: 0, right: 12, zIndex: 20 }}>{toolbar}</View>;
}

type ChangeRowProps = {
  theme: PluginTheme;
  colors: SyntaxColors | null;
  frame: DiffFrame;
  handlers: BlockHandlers;
};

/**
 * A row of a block reacts to the pointer: hover shows the toolbar, a click makes the block current. On web, hover is
 * tracked with mouseenter and mouseleave, which don't fire when the pointer moves onto the toolbar inside the row (a
 * Pressable's hover-out does, which hid the toolbar under the pointer).
 */
function RowFrame({ block, start, end, theme, handlers, children }: { block: Block | null; start: boolean; end: boolean; theme: PluginTheme; handlers: BlockHandlers; children: ReactNode }) {
  const style = shared.row;
  if (!block) return <View style={style}>{children}</View>;
  const outline = block.origin === "staged" ? <BlockOutline theme={theme} block={block} start={start} end={end} /> : null;
  if (Platform.OS === "web") {
    const web = {
      onMouseEnter: () => handlers.onHover(block),
      onMouseLeave: () => handlers.onHover(null),
      onClick: () => handlers.onActivate(block),
      ...handlers.contextMenu(() => handlers.menuFor(block)),
    };
    return (
      <View style={style} {...(web as object)}>
        {outline}
        {children}
      </View>
    );
  }
  return (
    <Pressable accessible={false} onPress={() => handlers.onActivate(block)} {...handlers.contextMenu(() => handlers.menuFor(block))} style={style}>
      {outline}
      {children}
    </Pressable>
  );
}

/** Staged changes are washed more lightly than unstaged ones; the current change more strongly. */
const tintOpacity = (active: boolean, block: Block | null) => (block?.origin === "staged" ? (active ? 0.14 : 0.06) : active ? 0.22 : 0.13);

export const LineRow = memo(function LineRow({ theme, colors, row, frame, handlers }: ChangeRowProps & { row: RowOf<"line"> }) {
  const tint = tintFor(theme, row.type);
  const { block } = row;
  const { active, toolbar } = useBlockFocus(handlers.focus, block, row.blockStart);
  return (
    <RowFrame block={row.block} start={row.blockStart} end={row.blockEnd} theme={theme} handlers={handlers}>
      {tint ? <Tint color={tint} opacity={tintOpacity(active, block)} /> : null}
      {row.block ? <BlockBar theme={theme} block={row.block} /> : null}
      <Gutter theme={theme} value={row.oldNo} digits={row.digits} />
      <Gutter theme={theme} value={row.newNo} digits={row.digits} />
      <Text style={[shared.sign, codeColor(tint ?? theme.colors.foregroundMuted)]}>{signFor(row.type)}</Text>
      <Code theme={theme} colors={colors} line={row} scroll={frame.scrolls} />
      {toolbar && row.block ? <BlockToolbar theme={theme} block={row.block} onAction={handlers.onAction} /> : null}
    </RowFrame>
  );
}, sameProps);

// Diagonal hatching where one side of a split row has no line; a plain fill where CSS gradients aren't available.
const hatch = (theme: PluginTheme) =>
  Platform.OS === "web"
    ? ({ backgroundImage: `repeating-linear-gradient(-45deg, ${theme.colors.border} 0 1px, transparent 1px 8px)` } as object)
    : { backgroundColor: theme.colors.surface1 };

function SplitSide({
  theme,
  colors,
  cell,
  block,
  digits,
  scroll,
  right,
  active,
}: {
  theme: PluginTheme;
  colors: SyntaxColors | null;
  cell: Cell | null;
  block: Block | null;
  digits: number;
  scroll: boolean;
  right: boolean;
  active: boolean;
}) {
  const divider = right ? { borderLeftWidth: SPLIT_DIVIDER, borderColor: theme.colors.border } : null;
  if (!cell) return <View style={[{ flex: 1, flexBasis: 0 }, hatch(theme), divider]} />;
  const tint = tintFor(theme, cell.type);
  return (
    <View style={[{ flex: 1, flexBasis: 0, flexDirection: "row", minWidth: 0 }, divider]}>
      {tint ? <Tint color={tint} opacity={tintOpacity(active, block)} /> : null}
      {block && cell.type !== "context" ? <BlockBar theme={theme} block={block} /> : null}
      <Gutter theme={theme} value={cell.no} digits={digits} />
      <Text style={[shared.sign, codeColor(tint ?? theme.colors.foregroundMuted)]}>{signFor(cell.type)}</Text>
      <Code theme={theme} colors={colors} line={cell} scroll={scroll} />
    </View>
  );
}

export const SplitRow = memo(function SplitRow({ theme, colors, row, frame, handlers }: ChangeRowProps & { row: RowOf<"split"> }) {
  const { active, toolbar } = useBlockFocus(handlers.focus, row.block, row.blockStart);
  return (
    <RowFrame block={row.block} start={row.blockStart} end={row.blockEnd} theme={theme} handlers={handlers}>
      <SplitSide theme={theme} colors={colors} cell={row.left} block={row.block} digits={row.digits} scroll={frame.scrolls} right={false} active={active} />
      <SplitSide theme={theme} colors={colors} cell={row.right} block={row.block} digits={row.digits} scroll={frame.scrolls} right active={active} />
      {toolbar && row.block ? <BlockToolbar theme={theme} block={row.block} onAction={handlers.onAction} /> : null}
    </RowFrame>
  );
}, sameProps);

/** Where gap labels start: after the gutters. */
const labelInset = (frame: DiffFrame, digits: number) => (frame.split ? gutterWidth(digits) : gutterWidth(digits) * 2);

/** A full-width header band; a Pressable so long-press can open a menu on touch devices. */
function Band({ style, children, ...rest }: { frame: DiffFrame; style: object; children: ReactNode; [prop: string]: unknown }) {
  return (
    <Pressable accessible={false} {...rest} style={[style, { flexDirection: "row", alignItems: "center" }]}>
      {children}
    </Pressable>
  );
}

export const GapRow = memo(function GapRow({
  theme,
  row,
  frame,
  onExpand,
}: {
  theme: PluginTheme;
  row: RowOf<"gap">;
  frame: DiffFrame;
  onExpand(row: RowOf<"gap">, direction: "up" | "down" | "all"): void;
}) {
  const hidden = row.end - row.start + 1;
  const small = hidden <= EXPAND_STEP;
  return (
    <Band frame={frame} style={{ minHeight: 26, backgroundColor: theme.colors.surface1 }}>
      <View style={{ width: Math.max(labelInset(frame, row.digits), 60), flexDirection: "row", justifyContent: "center", gap: 2 }}>
        {!small && row.up ? <IconButton theme={theme} icon="ArrowUpToLine" size={13} label={`Show ${EXPAND_STEP} lines above`} onPress={() => onExpand(row, "up")} /> : null}
        {!small && row.down ? <IconButton theme={theme} icon="ArrowDownToLine" size={13} label={`Show ${EXPAND_STEP} lines below`} onPress={() => onExpand(row, "down")} /> : null}
        {small ? <IconButton theme={theme} icon="ChevronsUpDown" size={13} label={`Show ${hidden} hidden lines`} onPress={() => onExpand(row, "all")} /> : null}
      </View>
      <Pressable accessibilityRole="button" onPress={() => onExpand(row, "all")} style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
        <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
          {hidden === 1 ? "1 hidden line" : `${hidden} hidden lines`} · Show all
        </Text>
      </Pressable>
    </Band>
  );
}, sameProps);

/** The file's checkbox: checked when all its changes are staged, a dash when only some are. */
export const sectionCheck = (row: RowOf<"section">): CheckState => (row.staged && row.unstaged ? "mixed" : row.staged ? "checked" : "unchecked");

export const SectionRow = memo(function SectionRow({
  theme,
  row,
  frame,
  onCheck,
  menuFor,
  contextMenu,
}: {
  theme: PluginTheme;
  row: RowOf<"section">;
  frame: DiffFrame;
  onCheck(row: RowOf<"section">): void;
  menuFor(row: RowOf<"section">): MenuEntry[];
  contextMenu: ContextMenu;
}) {
  const { staged, unstaged, diff } = row;
  const entry = (unstaged ?? staged)!;
  const check = sectionCheck(row);
  const title = check === "mixed" ? "Partly staged" : check === "checked" ? "Staged" : "Unstaged";
  const count = (pick: (entry: StatusEntry) => number | null) => {
    const values = [staged, unstaged].flatMap((side) => (side ? [pick(side)] : []));
    return values.includes(null) ? null : (values as number[]).reduce((sum, value) => sum + value, 0);
  };
  const additions = diff && diff.status !== "error" ? diff.additions : count((side) => side.additions);
  const deletions = diff && diff.status !== "error" ? diff.deletions : count((side) => side.deletions);
  return (
    <Band frame={frame} {...contextMenu(() => menuFor(row))} style={{ minHeight: 36, borderBottomWidth: 1, borderColor: theme.colors.border }}>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, paddingRight: 9, minWidth: 0 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.foreground }}>{title}</Text>
        {staged?.origPath ? (
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, color: theme.colors.foregroundMuted }}>
            renamed from {staged.origPath}
          </Text>
        ) : null}
        <View style={{ flex: 1 }} />
        {diff?.status === "empty" ? null : <DiffStat theme={theme} additions={additions} deletions={deletions} />}
        <Checkbox theme={theme} state={check} label={check === "checked" ? `Unstage ${entry.path}` : `Stage ${entry.path}`} onPress={() => onCheck(row)} />
      </View>
    </Band>
  );
}, sameProps);

export function NoticeRow({ theme, row, frame, onForce }: { theme: PluginTheme; row: RowOf<"notice">; frame: DiffFrame; onForce(key: string): void }) {
  return (
    <Band frame={frame} style={{ backgroundColor: theme.colors.surface1 }}>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 }}>
        <Text style={{ flex: 1, fontSize: 13, fontStyle: "italic", color: theme.colors.foregroundMuted }}>{row.text}</Text>
        {row.force ? <TextButton theme={theme} label="Load anyway" onPress={() => onForce(row.key)} /> : null}
      </View>
    </Band>
  );
}
