import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, type RefObject } from "react";
import { Platform } from "react-native";
import { isDarkTheme } from "./ansi-text";

/*
 * A copy of Paseo's own tooltip (packages/app/src/components/ui/tooltip.tsx and its use in
 * plugins/buttons/view.tsx), which the plugin SDK doesn't expose. Web only: it's mounted on document.body with
 * fixed positioning, so popovers and scroll areas can't clip it.
 *
 * Paseo's values: opens immediately on hover; 6px above the trigger, centered, flipping below when there's no room,
 * kept 8px inside the viewport; fades in and out over 80ms; max 280px wide; padding 4/8; radius 12; 1px border; theme `popover` background
 * (surface2 in dark themes, surface0 in light); medium shadow; 12px foreground text in the UI font.
 * The plugin theme has no `borderAccent`, so the border uses `border`.
 */

const OFFSET = 6;
const VIEWPORT_PADDING = 8;
const MAX_WIDTH = 280;
const UI_FONT = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SHADOW_DARK = "0 4px 8px rgba(0, 0, 0, 0.20)";
const SHADOW_LIGHT = "0 4px 16px rgba(0, 0, 0, 0.04)";
// Paseo animates with Reanimated's FadeIn/FadeOut.duration(80); Reanimated's default timing curve is
// Easing.inOut(Easing.quad), i.e. this cubic-bezier.
const FADE_MS = 80;
const FADE_EASING = "cubic-bezier(0.455, 0.03, 0.515, 0.955)";

// The plugin typechecks without the DOM library; declare just what's used.
type Rect = { left: number; top: number; width: number; height: number };
type DomElement = {
  textContent: string | null;
  style: Record<string, string>;
  getBoundingClientRect(): Rect;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  remove(): void;
};
declare const document: { createElement(tag: string): DomElement; body: { appendChild(element: DomElement): void } };
declare const window: { innerWidth: number; innerHeight: number };

function place(tooltip: DomElement, trigger: DomElement) {
  const anchor = trigger.getBoundingClientRect();
  const { width, height } = tooltip.getBoundingClientRect();
  let top = anchor.top - height - OFFSET;
  // Flip below when there isn't room above (and there's more below).
  if (top < VIEWPORT_PADDING && window.innerHeight - (anchor.top + anchor.height) > anchor.top) {
    top = anchor.top + anchor.height + OFFSET;
  }
  const left = anchor.left + anchor.width / 2 - width / 2;
  tooltip.style.left = `${Math.max(VIEWPORT_PADDING, Math.min(window.innerWidth - width - VIEWPORT_PADDING, left))}px`;
  tooltip.style.top = `${Math.max(VIEWPORT_PADDING, Math.min(window.innerHeight - height - VIEWPORT_PADDING, top))}px`;
}

/** Shows `label` in a Paseo-style tooltip while the pointer is over the element behind `ref` (web only). */
export function useWebTooltip(ref: RefObject<unknown>, label: string, theme: PluginTheme) {
  useEffect(() => {
    // On react-native-web a host component's ref is its DOM element.
    const trigger = ref.current as DomElement | null;
    if (Platform.OS !== "web" || !trigger) return;
    const dark = isDarkTheme(theme);
    let tooltip: DomElement | null = null;

    const hide = () => {
      const fading = tooltip;
      tooltip = null;
      if (!fading) return;
      fading.style.opacity = "0";
      setTimeout(() => fading.remove(), FADE_MS);
    };
    const show = () => {
      hide();
      const created = document.createElement("div");
      tooltip = created;
      created.textContent = label;
      Object.assign(created.style, {
        opacity: "0",
        transition: `opacity ${FADE_MS}ms ${FADE_EASING}`,
        position: "fixed",
        left: "0px",
        top: "0px",
        zIndex: "2147483000",
        pointerEvents: "none",
        maxWidth: `${MAX_WIDTH}px`,
        boxSizing: "border-box",
        padding: "4px 8px",
        borderRadius: "12px",
        border: `1px solid ${theme.colors.border}`,
        background: dark ? theme.colors.surface2 : theme.colors.surface0,
        boxShadow: dark ? SHADOW_DARK : SHADOW_LIGHT,
        color: theme.colors.foreground,
        fontFamily: UI_FONT,
        fontSize: "12px",
        lineHeight: "16px",
        whiteSpace: "normal",
      });
      document.body.appendChild(created);
      place(created, trigger);
      // Start the fade on the next frame, once the browser has the element at opacity 0.
      requestAnimationFrame(() => {
        if (tooltip === created) created.style.opacity = "1";
      });
    };

    trigger.addEventListener("pointerenter", show);
    trigger.addEventListener("pointerleave", hide);
    // Like Paseo's, it goes away once the button is used.
    trigger.addEventListener("pointerdown", hide);
    return () => {
      trigger.removeEventListener("pointerenter", show);
      trigger.removeEventListener("pointerleave", hide);
      trigger.removeEventListener("pointerdown", hide);
      hide();
    };
  }, [ref, label, theme]);
}
