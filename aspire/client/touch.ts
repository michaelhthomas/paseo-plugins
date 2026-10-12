import { createContext, useContext } from "react";

/**
 * True in the native phone apps, where controls need finger-sized tap targets (~44pt, Apple's minimum). Desktop and
 * web keep the compact sizes. Provided at the root of the popover and the logs panel from `layout.platform`.
 */
export const TouchContext = createContext(false);

export function useTouch() {
  return useContext(TouchContext);
}

export function isTouchLayout(layout: { platform: "ios" | "android" | "web" }) {
  return layout.platform !== "web";
}
