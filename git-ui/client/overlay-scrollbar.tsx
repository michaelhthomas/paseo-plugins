import type { PluginTheme } from "@getpaseo/plugin";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { Platform, Pressable, View } from "react-native";
import { offsetForDrag, thumbGeometry, type ScrollMetrics } from "./scrollbar-geometry";

// The plugin typechecks without the DOM library; declare just what dragging uses.
type PointerLike = { clientY: number };
declare const window: {
  addEventListener(type: "pointermove" | "pointerup" | "pointercancel", listener: (event: PointerLike) => void): void;
  removeEventListener(type: "pointermove" | "pointerup" | "pointercancel", listener: (event: PointerLike) => void): void;
};

// Paseo's scrollbar (packages/app/src/styles/web-scrollbar.ts, components/ui/overlay-scrollbar): an 8px rail with a
// 4px rounded thumb, a 12px grab area, resting at 40% opacity and fully opaque while hovered or dragged.
const RAIL_WIDTH = 8;
const THUMB_WIDTH = RAIL_WIDTH - 4;
const GRAB_WIDTH = 12;
const RESTING_OPACITY = 0.4;

type Scrollable = { scrollToOffset(params: { offset: number; animated?: boolean }): void };

/**
 * An overlay scrollbar for a list on web, drawn over the content instead of beside it, so rows never shift when the
 * list starts or stops overflowing. Spread `listProps` onto the list and render `overlay` beside it inside a wrapper.
 * iOS and Android keep their native indicators, which already overlay.
 */
export function useOverlayScrollbar(list: RefObject<Scrollable | null>, theme: PluginTheme): { listProps: object; overlay: ReactNode } {
  const [metrics, setMetrics] = useState<ScrollMetrics>({ offset: 0, viewportSize: 0, contentSize: 0 });
  const [dragging, setDragging] = useState(false);
  const geometry = useMemo(() => thumbGeometry(metrics), [metrics]);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const dragStart = useRef({ clientY: 0, offset: 0 });

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    setMetrics({ offset: Math.max(0, contentOffset.y), viewportSize: layoutMeasurement.height, contentSize: contentSize.height });
  }, []);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    setMetrics((current) => ({ ...current, viewportSize: height }));
  }, []);
  const onContentSizeChange = useCallback((_width: number, height: number) => setMetrics((current) => ({ ...current, contentSize: height })), []);

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerLike) => {
      const offset = offsetForDrag(dragStart.current.offset, event.clientY - dragStart.current.clientY, geometryRef.current);
      list.current?.scrollToOffset({ offset, animated: false });
    };
    const stop = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging, list]);

  // The same object while nothing changes, so a memoized list taking it doesn't re-render.
  const listProps = useMemo(
    () => (Platform.OS === "web" ? { onScroll, onLayout, onContentSizeChange, scrollEventThrottle: 16, showsVerticalScrollIndicator: false } : {}),
    [onScroll, onLayout, onContentSizeChange],
  );
  if (Platform.OS !== "web") return { listProps, overlay: null };

  const startDrag = (event: { nativeEvent?: { clientY?: number }; clientY?: number; preventDefault?: () => void }) => {
    const clientY = event.nativeEvent?.clientY ?? event.clientY;
    if (typeof clientY !== "number") return;
    event.preventDefault?.();
    dragStart.current = { clientY, offset: metrics.offset };
    setDragging(true);
  };

  const overlay = geometry.visible ? (
    <View pointerEvents="box-none" style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: RAIL_WIDTH, zIndex: 10 }}>
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        {...({ onPointerDown: startDrag } as object)}
        style={{
          position: "absolute",
          top: 0,
          right: -(GRAB_WIDTH - RAIL_WIDTH) / 2,
          width: GRAB_WIDTH,
          height: geometry.thumbSize,
          alignItems: "center",
          transform: [{ translateY: geometry.thumbOffset }],
          ...({ cursor: dragging ? "grabbing" : "grab", touchAction: "none", userSelect: "none" } as object),
        }}
      >
        {({ hovered }: { pressed: boolean; hovered?: boolean }) => (
          <View
            pointerEvents="none"
            style={{
              width: THUMB_WIDTH,
              height: "100%",
              borderRadius: THUMB_WIDTH / 2,
              backgroundColor: theme.colors.foregroundMuted,
              opacity: hovered || dragging ? 1 : RESTING_OPACITY,
            }}
          />
        )}
      </Pressable>
    </View>
  ) : null;
  return { listProps, overlay };
}
