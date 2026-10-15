import type { PluginTheme } from "@getpaseo/plugin";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { clampOffset, codeRegions, syncRegions, type CodeRegion } from "./diff-metrics";
import { offsetForDrag, thumbGeometry } from "./scrollbar-geometry";

// The plugin typechecks without the DOM library; declare just what dragging and the shift variable use.
type PointerLike = { clientX: number };
declare const window: {
  addEventListener(type: "pointermove" | "pointerup" | "pointercancel", listener: (event: PointerLike) => void): void;
  removeEventListener(type: "pointermove" | "pointerup" | "pointercancel", listener: (event: PointerLike) => void): void;
};
type StyledElement = { style: { setProperty(name: string, value: string): void } };
declare const document: {
  getElementById(id: string): unknown;
  createElement(tag: "style"): { id: string; textContent: string };
  head: { appendChild(node: unknown): void };
};

/** Marks a row's code as scrolled; with the stylesheet below, it follows the list's `--gitui-shift` variable. */
export const SHIFTED_CODE = { gituiShift: "" };
const SHIFT_STYLE_ID = "git-ui-code-shift";

/**
 * Sideways scrolling shifts every row's code by one CSS variable on the list, so scrolling (and mounting rows) costs
 * no React work and no per-row animation nodes. Web only, where lines can scroll.
 */
function ensureShiftStyle() {
  if (Platform.OS !== "web" || document.getElementById(SHIFT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = SHIFT_STYLE_ID;
  style.textContent = "[data-gitui-shift] { transform: translateX(var(--gitui-shift, 0px)); }";
  document.head.appendChild(style);
}

/** A number with listeners, for the scrollbars; nothing else re-renders when it changes. */
function observable(initial: number) {
  let value = initial;
  const listeners = new Set<(value: number) => void>();
  return {
    get: () => value,
    set(next: number) {
      value = next;
      for (const listener of listeners) listener(next);
    },
    subscribe(listener: (value: number) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

type Offset = ReturnType<typeof observable>;

type WheelLike = { deltaX: number; deltaY: number; deltaMode?: number; shiftKey?: boolean };
type WheelEvent = WheelLike & { nativeEvent?: WheelLike };

// Paseo's scrollbar metrics, as in overlay-scrollbar.tsx, turned sideways.
const RAIL_HEIGHT = 8;
const THUMB_HEIGHT = RAIL_HEIGHT - 4;
const GRAB_HEIGHT = 12;
const RESTING_OPACITY = 0.4;
/** Pixels per wheel "line" (Firefox reports lines). */
const WHEEL_LINE = 16;

/**
 * Sideways scrolling for unwrapped code. The list itself never scrolls sideways: each row stays as wide as the panel,
 * gutters and headers stay put, and only the code is shifted. In split view each side keeps its half, so a long line
 * on one side never pushes the other out of view, and the two sides scroll together. Horizontal wheel input (or
 * Shift+wheel) scrolls; each side also gets an overlay scrollbar.
 */
export function useCodeScroll({
  enabled,
  split,
  viewport,
  digits,
  columns,
  resetKey,
}: {
  enabled: boolean;
  split: boolean;
  viewport: number;
  digits: number;
  columns: { left: number; right: number };
  /** Scrolls back to the start when this changes (another file). */
  resetKey: string | null;
}) {
  const offset = useRef(observable(0)).current;
  const target = useRef<StyledElement | null>(null);
  /** A ref for the element containing the rows (the list's wrapper); the shift variable is set on it. */
  const attach = useCallback((node: unknown) => {
    target.current = (node as StyledElement | null) ?? null;
    target.current?.style?.setProperty("--gitui-shift", `${-offset.get()}px`);
  }, [offset]);
  useEffect(ensureShiftStyle, []);
  const regions = useMemo(() => syncRegions(codeRegions({ split, viewport, digits, columns })), [split, viewport, digits, columns.left, columns.right]);
  const regionsRef = useRef(regions);
  regionsRef.current = regions;

  // The sides of a split row scroll together: one offset moves both.
  const set = useCallback(
    (value: number) => {
      const { left, right } = regionsRef.current;
      // The narrower side has the most to scroll.
      const next = clampOffset(value, right && right.width < left.width ? right : left);
      if (next === offset.get()) return;
      offset.set(next);
      target.current?.style.setProperty("--gitui-shift", `${-next}px`);
    },
    [offset],
  );

  // Keep within the overflow when the panel or the lines change, and start over for another file.
  useEffect(() => set(offset.get()), [regions, set]);
  useEffect(() => set(0), [resetKey, set]);

  const onWheel = useCallback(
    (event: WheelEvent) => {
      const wheel = event.nativeEvent ?? event;
      const scale = wheel.deltaMode === 1 ? WHEEL_LINE : 1;
      const delta = Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY) ? wheel.deltaX : wheel.shiftKey ? wheel.deltaY : 0;
      if (delta) set(offset.get() + delta * scale);
    },
    [set],
  );

  return { enabled, regions, offset, set, attach, onWheel: enabled ? onWheel : undefined };
}

export type CodeScroll = ReturnType<typeof useCodeScroll>;

function Scrollbar({ theme, region, offset, onScroll }: { theme: PluginTheme; region: CodeRegion; offset: Offset; onScroll(offset: number): void }) {
  const [position, setPosition] = useState(offset.get());
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ clientX: 0, offset: 0 });
  useEffect(() => {
    return offset.subscribe(setPosition);
  }, [offset]);
  const geometry = thumbGeometry({ offset: position, viewportSize: region.width, contentSize: region.content });
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerLike) => onScroll(offsetForDrag(dragStart.current.offset, event.clientX - dragStart.current.clientX, geometryRef.current));
    const stop = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging, onScroll]);

  if (!geometry.visible) return null;
  const startDrag = (event: { nativeEvent?: { clientX?: number }; clientX?: number; preventDefault?: () => void }) => {
    const clientX = event.nativeEvent?.clientX ?? event.clientX;
    if (typeof clientX !== "number") return;
    event.preventDefault?.();
    dragStart.current = { clientX, offset: position };
    setDragging(true);
  };
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: region.x, width: region.width, bottom: 0, height: RAIL_HEIGHT, zIndex: 10 }}>
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        {...({ onPointerDown: startDrag } as object)}
        style={{
          position: "absolute",
          left: 0,
          bottom: -(GRAB_HEIGHT - RAIL_HEIGHT) / 2,
          height: GRAB_HEIGHT,
          width: geometry.thumbSize,
          justifyContent: "center",
          transform: [{ translateX: geometry.thumbOffset }],
          ...({ cursor: dragging ? "grabbing" : "grab", touchAction: "none", userSelect: "none" } as object),
        }}
      >
        {({ hovered }: { pressed: boolean; hovered?: boolean }) => (
          <View
            pointerEvents="none"
            style={{
              height: THUMB_HEIGHT,
              borderRadius: THUMB_HEIGHT / 2,
              backgroundColor: theme.colors.foregroundMuted,
              opacity: hovered || dragging ? 1 : RESTING_OPACITY,
            }}
          />
        )}
      </Pressable>
    </View>
  );
}

/** Overlay scrollbars along the bottom of the list, under each side's code (both move together). Render inside the list's wrapper. */
export function CodeScrollbars({ theme, scroll }: { theme: PluginTheme; scroll: CodeScroll }): ReactNode {
  if (!scroll.enabled || Platform.OS !== "web") return null;
  return (
    <>
      <Scrollbar theme={theme} region={scroll.regions.left} offset={scroll.offset} onScroll={scroll.set} />
      {scroll.regions.right ? <Scrollbar theme={theme} region={scroll.regions.right} offset={scroll.offset} onScroll={scroll.set} /> : null}
    </>
  );
}
