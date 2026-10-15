import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GestureResponderEvent, View as NativeView } from "react-native";
import { Animated, Easing, Platform, Pressable, Text, View } from "react-native";

export type MenuEntry =
  | { kind: "header"; label: string }
  | { kind: "separator" }
  | { kind: "item"; label: string; icon?: string; checked?: boolean; danger?: boolean; onSelect(): void };

type Anchor = { x: number; y: number; align: "left" | "right" };

type OpenMenu = { id: number; anchor: Anchor; size: { width: number; height: number }; entries: MenuEntry[] };

// Paseo's menu metrics and motion (packages/app/src/components/ui/menu): the surface fades in while scaling up from
// 0.97 over 150ms, from the corner nearest its anchor, and reverses over 100ms when it closes.
const MENU_WIDTH = 200;
const ITEM_HEIGHT = 28;
const HEADER_HEIGHT = 28;
const SEPARATOR_HEIGHT = 9;
const ENTER_MS = 150;
const EXIT_MS = 100;
const START_SCALE = 0.97;
// The native driver doesn't exist on web.
const useNativeDriver = Platform.OS !== "web";

function menuHeight(entries: readonly MenuEntry[]) {
  return 10 + entries.reduce((sum, entry) => sum + (entry.kind === "item" ? ITEM_HEIGHT : entry.kind === "header" ? HEADER_HEIGHT : SEPARATOR_HEIGHT), 0);
}

/** Pointer position of a press or right-click event, in window coordinates. */
function eventPoint(event: unknown): { x: number; y: number } | null {
  const native = (event as { nativeEvent?: Record<string, unknown> })?.nativeEvent ?? (event as Record<string, unknown>);
  const x = native?.clientX ?? native?.pageX;
  const y = native?.clientY ?? native?.pageY;
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

function MenuItemRow({ theme, entry, onPress }: { theme: PluginTheme; entry: Extract<MenuEntry, { kind: "item" }>; onPress(): void }) {
  const color = entry.danger ? theme.colors.statusDanger : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={entry.checked === undefined ? undefined : { checked: entry.checked }}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        height: ITEM_HEIGHT,
        marginHorizontal: 4,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      {entry.icon ? <Icon name={entry.icon} size={14} color={entry.danger ? color : theme.colors.foregroundMuted} /> : null}
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color }}>
        {entry.label}
      </Text>
      {entry.checked ? <Icon name="Check" size={14} color={theme.colors.foreground} /> : null}
    </Pressable>
  );
}

/**
 * A popover menu owned by a panel. Put `rootRef` on the panel's root view and render `element` last inside it.
 * `contextMenuProps(entries)` gives a row right-click (web) and long-press (touch) handlers that open the menu at the
 * pointer; `openBelow(button, entries)` opens it under a button, right-aligned with it.
 *
 * Positions and the panel's size are measured in the window when the menu opens, rather than tracked with onLayout,
 * so the menu lands in the right place however the host lays the panel out.
 */
export function usePanelMenu(theme: PluginTheme) {
  const root = useRef<NativeView>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const nextId = useRef(0);
  const closing = useRef(false);

  const show = useCallback((next: Omit<OpenMenu, "id">) => {
    closing.current = false;
    setMenu({ ...next, id: ++nextId.current });
  }, []);

  // Animate in whenever a menu opens, including one replacing another.
  useEffect(() => {
    if (!menu) return;
    progress.setValue(0);
    const animation = Animated.timing(progress, { toValue: 1, duration: ENTER_MS, easing: Easing.linear, useNativeDriver });
    animation.start();
    return () => animation.stop();
  }, [menu?.id, progress]);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    Animated.timing(progress, { toValue: 0, duration: EXIT_MS, easing: Easing.linear, useNativeDriver }).start(() => {
      if (closing.current) setMenu(null);
    });
  }, [progress]);

  const openAtWindowPoint = useCallback(
    (point: { x: number; y: number }, entries: MenuEntry[]) => {
      if (entries.length === 0) return;
      const node = root.current;
      if (!node) return;
      node.measureInWindow((left, top, width, height) => show({ anchor: { x: point.x - left, y: point.y - top, align: "left" }, size: { width, height }, entries }));
    },
    [show],
  );

  const openBelow = useCallback(
    (button: NativeView | null, entries: MenuEntry[]) => {
      const node = root.current;
      if (!node || !button || entries.length === 0) return;
      node.measureInWindow((left, top, width, height) =>
        button.measureInWindow((x, y, buttonWidth, buttonHeight) =>
          show({ anchor: { x: x - left + buttonWidth, y: y - top + buttonHeight + 4, align: "right" }, size: { width, height }, entries }),
        ),
      );
    },
    [show],
  );

  const contextMenuProps = useCallback(
    (entries: () => MenuEntry[]) => {
      const open = (event: unknown) => {
        const point = eventPoint(event);
        if (point) openAtWindowPoint(point, entries());
      };
      return Platform.OS === "web"
        ? {
            // Web-only; react-native-web passes it through to the element.
            onContextMenu: (event: { preventDefault?: () => void }) => {
              event.preventDefault?.();
              open(event);
            },
          }
        : { onLongPress: (event: GestureResponderEvent) => open(event) };
    },
    [openAtWindowPoint],
  );

  let element: ReactNode = null;
  if (menu) {
    const height = menuHeight(menu.entries);
    const { size, anchor } = menu;
    const rawLeft = anchor.align === "right" ? anchor.x - MENU_WIDTH : anchor.x;
    const left = Math.max(4, Math.min(rawLeft, size.width - MENU_WIDTH - 4));
    const above = anchor.y + height > size.height - 4 && anchor.y - height >= 4;
    const top = above ? anchor.y - height : Math.max(4, Math.min(anchor.y, size.height - height - 4));
    element = (
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 }}>
        <Pressable
          accessibilityLabel="Close menu"
          onPress={close}
          {...(Platform.OS === "web" ? { onContextMenu: (event: { preventDefault?: () => void }) => (event.preventDefault?.(), close()) } : {})}
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <Animated.View
          accessibilityRole="menu"
          style={{
            position: "absolute",
            left,
            top,
            width: MENU_WIDTH,
            paddingVertical: 4,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            overflow: "hidden",
            shadowColor: "rgba(0, 0, 0, 0.2)",
            shadowOpacity: 1,
            shadowOffset: { width: 0, height: 4 },
            shadowRadius: 8,
            elevation: 8,
            transformOrigin: `${above ? "bottom" : "top"} ${anchor.align}`,
            opacity: progress,
            transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [START_SCALE, 1] }) }],
          }}
        >
          {menu.entries.map((entry, i) => {
            if (entry.kind === "separator") {
              return <View key={i} style={{ height: 1, marginVertical: 4, backgroundColor: theme.colors.border }} />;
            }
            if (entry.kind === "header") {
              return (
                <Text
                  key={i}
                  style={{ height: HEADER_HEIGHT, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, fontSize: 12, color: theme.colors.foregroundMuted }}
                >
                  {entry.label}
                </Text>
              );
            }
            return (
              <MenuItemRow
                key={i}
                theme={theme}
                entry={entry}
                onPress={() => {
                  close();
                  entry.onSelect();
                }}
              />
            );
          })}
        </Animated.View>
      </View>
    );
  }

  return { rootRef: root, element, openBelow, contextMenuProps, close };
}
