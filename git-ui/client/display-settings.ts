import { useSettings } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { displaySettings } from "../shared/git";

export type DisplayValues = ReturnType<typeof displaySettings.schema.parse>;
type Layout = Omit<DisplayValues, "syntaxTheme">;

const DEFAULTS: Layout = { changesView: "tree", changesGroupBy: "tracked", diffLayout: "unified", hideWhitespace: false, wrapLines: true, collapseUnchanged: true };

/** The panels' view options, saved in the plugin's settings. Changes show at once, before the save lands. */
export function useDisplaySettings() {
  const settings = useSettings(displaySettings);
  const [override, setOverride] = useState<Partial<Layout>>({});
  const saved = settings.status === "ready" ? settings.values : null;
  // Once the saved values catch up, follow them again, including changes made on the settings screen.
  useEffect(() => {
    if (!saved) return;
    setOverride((current) => {
      const next = { ...current };
      for (const key of Object.keys(next) as (keyof Layout)[]) if (next[key] === saved[key]) delete next[key];
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [saved?.changesView, saved?.changesGroupBy, saved?.diffLayout, saved?.hideWhitespace, saved?.wrapLines, saved?.collapseUnchanged]);
  const values: Layout = { ...DEFAULTS, ...(saved ?? {}), ...override };
  const update = (patch: Partial<Layout>) => {
    setOverride((current) => ({ ...current, ...patch }));
    if (settings.status === "ready") void settings.save({ ...settings.values, ...patch }, settings.revision);
  };
  // Saved values have loaded, or failed to and the defaults stand.
  const ready = settings.status !== "loading";
  return { ...values, ready, update };
}
