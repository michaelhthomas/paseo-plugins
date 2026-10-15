import type { PluginTheme } from "@getpaseo/plugin";
import type { EntryKind } from "../shared/git";

/** True when the theme's background is dark. Unparseable colors count as dark, Paseo's default. */
export function isDarkTheme(theme: PluginTheme) {
  const color = theme.colors.surface0.trim();
  let rgb: number[] | null = null;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color);
  const fn = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color);
  if (short) rgb = short.slice(1).map((c) => parseInt(c + c, 16));
  else if (long) rgb = long.slice(1).map((c) => parseInt(c, 16));
  else if (fn) rgb = fn.slice(1).map(Number);
  if (!rgb) return true;
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128;
}

export const KIND_LABELS: Record<EntryKind, string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  typechange: "Type changed",
  untracked: "Untracked",
  conflict: "Conflict",
};

/** Splits a repo path into its file name and directory. */
export function splitPath(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}
