import { Platform } from "react-native";

// Web-only DOM helpers. The plugin typechecks without the DOM library, so declare just what's used.
export type ScrollElement = {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly children: ArrayLike<ScrollElement>;
  addEventListener(type: string, listener: (event: DomEvent) => void, options?: { passive?: boolean }): void;
  removeEventListener(type: string, listener: (event: DomEvent) => void): void;
};
type DomEvent = { deltaY?: number; key?: string };
declare const ResizeObserver: new (callback: () => void) => { observe(node: ScrollElement): void; disconnect(): void };
declare function getComputedStyle(element: ScrollElement): { overflowY: string };

const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

const isWeb = Platform.OS === "web";

/** The first element at or under `root` that scrolls vertically (react-native-web renders FlatList as nested divs). */
export function findScrollElement(root: unknown): ScrollElement | null {
  if (!isWeb || !root || typeof (root as ScrollElement).children !== "object") return null;
  const queue: ScrollElement[] = [root as ScrollElement];
  while (queue.length) {
    const element = queue.shift()!;
    const overflow = getComputedStyle(element).overflowY;
    if (overflow === "auto" || overflow === "scroll") return element;
    for (let i = 0; i < element.children.length; i++) queue.push(element.children[i]);
  }
  return null;
}

/** Calls `onHide` when the element stops rendering (e.g. an ancestor gets `display: none`) and `onShow` when it comes back. */
export function observeVisibility(element: ScrollElement, onHide: () => void, onShow: () => void) {
  if (typeof ResizeObserver === "undefined") return () => {};
  let visible = element.clientHeight > 0;
  const observer = new ResizeObserver(() => {
    const now = element.clientHeight > 0;
    if (now === visible) return;
    visible = now;
    if (now) onShow();
    else onHide();
  });
  observer.observe(element);
  return () => observer.disconnect();
}

/**
 * Calls `onIntent` whenever the user does something that scrolls up (wheel, keyboard, scrollbar drag), and
 * `onTouchStart`/`onTouchEnd` around touch drags so callers can hold off auto-scrolling while a finger is down.
 */
export function listenForUserScroll(element: ScrollElement, onIntent: () => void, onTouchStart: () => void, onTouchEnd: () => void) {
  const onWheel = (event: DomEvent) => {
    if ((event.deltaY ?? 0) < 0) onIntent();
  };
  const onKey = (event: DomEvent) => {
    if (event.key && SCROLL_UP_KEYS.has(event.key)) onIntent();
  };
  element.addEventListener("wheel", onWheel, { passive: true });
  element.addEventListener("keydown", onKey);
  element.addEventListener("pointerdown", onIntent);
  element.addEventListener("touchstart", onTouchStart, { passive: true });
  element.addEventListener("touchend", onTouchEnd, { passive: true });
  element.addEventListener("touchcancel", onTouchEnd, { passive: true });
  return () => {
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("keydown", onKey);
    element.removeEventListener("pointerdown", onIntent);
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchend", onTouchEnd);
    element.removeEventListener("touchcancel", onTouchEnd);
  };
}
