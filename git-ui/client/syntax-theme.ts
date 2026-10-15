import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { DEFAULT_SYNTAX_THEME, displaySettings, MATCH_PASEO, SYNTAX_THEMES, syntaxColorsRpc } from "../shared/git";
import { isDarkTheme } from "./theme";

export type SyntaxColors = Record<string, string>;

const APP_SETTINGS_KEY = "@paseo:app-settings";
const RECHECK_MS = 3_000;

/**
 * Paseo's own syntax theme. There is no plugin API for it: the app keeps it in AsyncStorage, which on web and desktop
 * is `localStorage`. This reads that internal key, so it returns null on iOS and Android, and whenever the format
 * changes.
 */
export function readPaseoSyntaxTheme(): string | null {
  try {
    const storage = (globalThis as { localStorage?: { getItem(key: string): string | null } }).localStorage;
    const raw = storage?.getItem(APP_SETTINGS_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw)?.syntaxTheme;
    return typeof value === "string" && SYNTAX_THEMES.some((theme) => theme.id === value) ? value : null;
  } catch {
    return null;
  }
}

/** Colors Paseo would give `theme` itself, if a future SDK adds them to the plugin theme. */
function runtimeSyntaxColors(theme: PluginTheme): SyntaxColors | null {
  const syntax: unknown = (theme.colors as { syntax?: unknown }).syntax;
  if (!syntax || typeof syntax !== "object") return null;
  const entries = Object.entries(syntax);
  return entries.length > 0 && entries.every(([, value]) => typeof value === "string") ? (syntax as SyntaxColors) : null;
}

/** The syntax theme id to use: the plugin setting, or Paseo's when the setting is "Match Paseo". */
export function useSyntaxThemeId() {
  const settings = useSettings(displaySettings);
  const choice = settings.status === "ready" ? settings.values.syntaxTheme : MATCH_PASEO;
  const [paseoTheme, setPaseoTheme] = useState(readPaseoSyntaxTheme);

  useEffect(() => {
    if (choice !== MATCH_PASEO) return;
    // Nothing announces a change to Paseo's setting, so look again now and then and when the app comes back.
    const recheck = () => setPaseoTheme(readPaseoSyntaxTheme());
    recheck();
    const timer = setInterval(recheck, RECHECK_MS);
    const subscription = AppState.addEventListener("change", recheck);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [choice]);

  if (choice !== MATCH_PASEO && SYNTAX_THEMES.some((theme) => theme.id === choice)) return choice;
  return paseoTheme ?? DEFAULT_SYNTAX_THEME;
}

/** Role-to-color map for highlighted tokens, or null while it loads. */
export function useSyntaxColors(theme: PluginTheme): SyntaxColors | null {
  const runtime = runtimeSyntaxColors(theme);
  const id = useSyntaxThemeId();
  const fetchColors = useRpc(syntaxColorsRpc);
  const query = useQuery({
    queryKey: ["git-ui", "syntax-colors", id],
    queryFn: () => fetchColors({ theme: id }),
    staleTime: Infinity,
    enabled: !runtime,
  });
  if (runtime) return runtime;
  if (!query.data) return null;
  return isDarkTheme(theme) ? query.data.dark : query.data.light;
}
