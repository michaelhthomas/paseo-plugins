import type { PluginTheme } from "@getpaseo/plugin";
import type { TextStyle } from "react-native";
import { Text } from "react-native";
import type { AnsiColor, AnsiSegment } from "../shared/ansi";
import { terminalFont } from "./terminal-font";

// VS Code's integrated terminal defaults, which is also roughly what the Aspire dashboard renders.
const DARK_PALETTE = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
];
const LIGHT_PALETTE = [
  "#000000", "#cd3131", "#107c10", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555",
  "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5",
];
const URL = /\bhttps?:\/\/[^\s"'<>()[\]{}]+[^\s"'<>()[\]{}.,;:!?]/g;
const CUBE = [0, 95, 135, 175, 215, 255];

const hex = (n: number) => n.toString(16).padStart(2, "0");

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

function resolve(color: AnsiColor, dark: boolean): string {
  if (typeof color === "string") return color;
  if (color < 16) return (dark ? DARK_PALETTE : LIGHT_PALETTE)[color];
  if (color < 232) {
    const n = color - 16;
    return `#${hex(CUBE[Math.floor(n / 36)])}${hex(CUBE[Math.floor(n / 6) % 6])}${hex(CUBE[n % 6])}`;
  }
  const gray = 8 + (color - 232) * 10;
  return `#${hex(gray)}${hex(gray)}${hex(gray)}`;
}

function segmentStyle(segment: AnsiSegment, theme: PluginTheme, dark: boolean): TextStyle {
  let fg = segment.fg === undefined ? undefined : resolve(segment.fg, dark);
  // Microsoft.Extensions.Logging paints its level badges on an explicit black background (40m). Treat that
  // as the default background, as the dashboard does, so it doesn't draw black boxes on a themed panel.
  let bg = segment.bg === undefined || segment.bg === 0 ? undefined : resolve(segment.bg, dark);
  if (segment.inverse) [fg, bg] = [bg ?? theme.colors.surface0, fg ?? theme.colors.foreground];
  const decorations = [segment.underline && "underline", segment.strike && "line-through"].filter(Boolean).join(" ");
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: segment.bold ? "700" : undefined,
    fontStyle: segment.italic ? "italic" : undefined,
    opacity: segment.dim ? 0.6 : undefined,
    textDecorationLine: (decorations || undefined) as TextStyle["textDecorationLine"],
  };
}

/** Renders one log line's ANSI segments, with URLs turned into links. Must be nested inside a parent `Text`. */
export function AnsiSegments({
  segments,
  theme,
  dark,
  onOpenUrl,
}: {
  segments: readonly AnsiSegment[];
  theme: PluginTheme;
  dark: boolean;
  onOpenUrl(url: string): void;
}) {
  return (
    <>
      {segments.map((segment, i) => {
        const style = segmentStyle(segment, theme, dark);
        const parts: (string | { url: string })[] = [];
        let last = 0;
        for (const match of segment.text.matchAll(URL)) {
          if (match.index! > last) parts.push(segment.text.slice(last, match.index));
          parts.push({ url: match[0] });
          last = match.index! + match[0].length;
        }
        if (last < segment.text.length) parts.push(segment.text.slice(last));
        return (
          <Text key={i} style={[terminalFont, style]}>
            {parts.map((part, j) =>
              typeof part === "string" ? (
                part
              ) : (
                <Text
                  key={j}
                  accessibilityRole="link"
                  onPress={() => onOpenUrl(part.url)}
                  style={[terminalFont, style, { textDecorationLine: "underline" }]}
                >
                  {part.url}
                </Text>
              ),
            )}
          </Text>
        );
      })}
    </>
  );
}
