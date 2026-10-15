import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo } from "react";
import { Image, Platform, Pressable, Text, View } from "react-native";
import type { EntryKind } from "../shared/git";
import { formatCount, type CheckState } from "./changes-tree";
import { FILE_ICON_BY_EXTENSION, FILE_ICON_SVGS } from "./file-icons";
import { KIND_LABELS } from "./theme";

// Paseo's tree metrics (packages/app/src/components/tree-primitives.tsx).
export const TREE_ICON_SIZE = 16;
export const TREE_ICON_GAP = 8;
export const TREE_ROW_PADDING_VERTICAL = 6;
export const TREE_ROW_PADDING_RIGHT = 8;
const TREE_INDENT = 12;
const CHANGE_ICON_SIZE = 14;

export const treePaddingLeft = (depth: number) => 12 + depth * TREE_INDENT;

function iconName(fileName: string) {
  const dot = fileName.lastIndexOf(".");
  const extension = dot < 0 || dot === fileName.length - 1 ? null : fileName.slice(dot + 1).toLowerCase();
  return (extension && FILE_ICON_BY_EXTENSION[extension]) || "file";
}

/** Lucide stand-ins where SVG images can't be shown (iOS and Android image views don't decode SVG). */
const NATIVE_ICONS: Record<string, string> = {
  typescript: "FileCode",
  react_ts: "FileCode",
  react: "FileCode",
  javascript: "FileCode",
  json: "FileJson",
  markdown: "FileText",
  document: "FileText",
  image: "FileImage",
  svg: "FileImage",
  settings: "FileCog",
  lock: "FileLock",
  database: "Database",
  console: "SquareTerminal",
};

const iconUris = new Map<string, string>();

/** The material-icon-theme icon Paseo shows for a file. */
export const FileIcon = memo(function FileIcon({ name, theme }: { name: string; theme: PluginTheme }) {
  const icon = iconName(name);
  if (Platform.OS !== "web") {
    return <Icon name={NATIVE_ICONS[icon] ?? (icon === "file" ? "File" : "FileCode")} size={TREE_ICON_SIZE} color={theme.colors.foregroundMuted} />;
  }
  let uri = iconUris.get(icon);
  if (!uri) {
    uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(FILE_ICON_SVGS[icon] ?? FILE_ICON_SVGS.file)}`;
    iconUris.set(icon, uri);
  }
  return <Image source={{ uri }} style={{ width: TREE_ICON_SIZE, height: TREE_ICON_SIZE }} accessibilityIgnoresInvertColors />;
});

/** Paseo's change badges: a square with a plus, minus or dot. */
export function ChangeIcon({ kind, theme }: { kind: EntryKind; theme: PluginTheme }) {
  const [name, color] =
    kind === "added" || kind === "untracked" || kind === "copied"
      ? ["SquarePlus", theme.colors.statusSuccess]
      : kind === "deleted"
        ? ["SquareMinus", theme.colors.statusDanger]
        : kind === "renamed"
          ? ["SquareArrowRight", theme.colors.accent]
          : kind === "conflict"
            ? ["SquareX", theme.colors.statusDanger]
            : ["SquareDot", theme.colors.statusWarning];
  return (
    <View accessible accessibilityLabel={KIND_LABELS[kind]}>
      <Icon name={name} size={CHANGE_ICON_SIZE} color={color} />
    </View>
  );
}

export function DiffStat({ theme, additions, deletions }: { theme: PluginTheme; additions: number | null; deletions: number | null }) {
  if (additions === null || deletions === null) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: 20, gap: 4, flexShrink: 0 }}>
      <Text style={{ fontSize: 12, color: theme.colors.statusSuccess }}>+{formatCount(additions)}</Text>
      <Text style={{ fontSize: 12, color: theme.colors.statusDanger }}>-{formatCount(deletions)}</Text>
    </View>
  );
}

/** Tri-state staging checkbox: checked is fully staged, mixed is partly staged. */
export function Checkbox({ theme, state, label, onPress }: { theme: PluginTheme; state: CheckState; label: string; onPress(): void }) {
  const on = state !== "unchecked";
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: state === "mixed" ? "mixed" : on }}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 16,
        height: 16,
        borderRadius: 3,
        borderWidth: 1.5,
        alignItems: "center",
        justifyContent: "center",
        borderColor: on ? theme.colors.accent : theme.colors.foregroundMuted,
        backgroundColor: on ? theme.colors.accent : theme.colors.surface0,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {on ? <Icon name={state === "mixed" ? "Minus" : "Check"} size={12} color={theme.colors.accentForeground} /> : null}
    </Pressable>
  );
}

export function FolderIcon({ theme, open }: { theme: PluginTheme; open: boolean }) {
  return <Icon name={open ? "FolderOpen" : "Folder"} size={TREE_ICON_SIZE} color={theme.colors.foregroundMuted} />;
}

export function TreeChevron({ theme, expanded }: { theme: PluginTheme; expanded: boolean }) {
  return (
    <View
      style={{
        width: TREE_ICON_SIZE,
        height: TREE_ICON_SIZE,
        alignItems: "center",
        justifyContent: "center",
        transform: expanded ? [{ rotate: "90deg" }] : [],
        opacity: 0.8,
      }}
    >
      <Icon name="ChevronRight" size={TREE_ICON_SIZE} color={theme.colors.foregroundMuted} />
    </View>
  );
}
