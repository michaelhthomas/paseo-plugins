import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { resolveRefsRpc, type ResolvedRef } from "../shared/contracts";
import { chipDataUrl, chipMarkdown } from "../shared/chip-svg";
import { findRefs, refKey, replaceRefs, uniqueRefs, type WorkRef } from "../shared/refs";
import { chipIcon, chipTint, describeRef, refLabel } from "./chip-style";

const CACHE_MS = 5 * 60_000;
const MAX_CACHE = 500;

type Resolved = ReadonlyMap<string, ResolvedRef>;

/**
 * Timeline rows don't get Paseo's plugin providers (state hooks, `useRpc`, react-query), so lookups go through the
 * contribution's `client.rpc` and a small cache keyed by agent and references.
 */
function createLookup(client: PluginClientContext) {
  const cache = new Map<string, { value: Promise<Resolved>; at: number }>();
  return (agentId: string, refs: readonly WorkRef[]): Promise<Resolved> => {
    const key = `${agentId}|${refs.map(refKey).join(",")}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
    const value = client.rpc(resolveRefsRpc, { agentId, refs: [...refs] }).then(({ refs: results }) => {
      const found = new Map<string, ResolvedRef>();
      for (const ref of results) if (ref.found && ref.url) found.set(refKey(ref), ref);
      return found as Resolved;
    });
    cache.set(key, { value, at: Date.now() });
    value.catch((error) => {
      cache.delete(key);
      console.warn("[work-refs] lookup failed", error);
    });
    return value;
  };
}

const EMPTY: Resolved = new Map();

/** Paseo's chat paragraph line height (`components/markdown/styles.ts`), which inline images are drawn at. */
const lineHeight = (compact: boolean) => Math.round((compact ? 14 : 15) * 1.4);

export function createRefMessage(client: PluginClientContext) {
  const lookup = createLookup(client);

  /**
   * An assistant message rendered by Paseo's Markdown, with each resolved reference replaced by a linked SVG chip
   * image, which Paseo shows inline in the text.
   */
  return function RefMessage({ agentId, item, theme, layout }: PluginTimelineItemProps<{ text: string }>) {
    const { text } = item.data;
    const refs = useMemo(() => uniqueRefs(findRefs(text)), [text]);
    const [found, setFound] = useState<Resolved>(EMPTY);

    useEffect(() => {
      if (refs.length === 0) return;
      let live = true;
      lookup(agentId, refs).then(
        (result) => live && setFound(result),
        () => {},
      );
      return () => {
        live = false;
      };
    }, [agentId, refs]);

    const { colors } = theme;
    const height = lineHeight(layout.compact);
    const markdown = useMemo(() => {
      if (found.size === 0) return text;
      const chips = new Map<string, string>();
      for (const [key, ref] of found) {
        const label = refLabel(ref);
        const image = chipDataUrl({
          label,
          title: ref.title ?? "",
          icon: chipIcon(ref),
          tint: chipTint(ref, colors),
          iconUrl: ref.iconUrl,
          stateColor: ref.stateColor,
          colors: { background: colors.surface1, border: colors.border, foreground: colors.foreground, muted: colors.foregroundMuted },
          height,
        });
        chips.set(key, chipMarkdown({ alt: `${label} ${ref.title ?? ""}`.trim(), tooltip: describeRef(ref), image, url: ref.url! }));
      }
      return replaceRefs(text, (ref) => chips.get(refKey(ref)) ?? null);
    }, [text, found, colors, height]);

    return <Markdown>{markdown}</Markdown>;
  };
}
