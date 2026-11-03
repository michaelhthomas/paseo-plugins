import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { COLUMN_WIDTH, TERMINAL_FONT_SIZE } from "./diff-metrics";
import { MONO } from "./terminal-font";

// The plugin typechecks without the DOM library; declare just what measuring uses.
declare const document: {
  createElement(tag: "canvas"): { getContext(kind: "2d"): { font: string; measureText(text: string): { width: number } } | null };
  fonts?: { ready: Promise<unknown>; status: string };
};

const SAMPLE = "x".repeat(100);
let measured: number | null = null;

function measure() {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return COLUMN_WIDTH;
  context.font = `${TERMINAL_FONT_SIZE}px ${MONO}`;
  return context.measureText(SAMPLE).width / SAMPLE.length || COLUMN_WIDTH;
}

/**
 * One character's width in the diff font, as the browser draws it, for working out how wrapped lines break. Measured
 * once the fonts have loaded (a fallback font measures differently). Elsewhere, the estimate.
 */
export function useColumnWidth() {
  const [width, setWidth] = useState(() => measured ?? (Platform.OS === "web" && document.fonts?.status === "loaded" ? (measured = measure()) : COLUMN_WIDTH));
  useEffect(() => {
    if (Platform.OS !== "web" || measured !== null) return;
    let live = true;
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      measured = measure();
      if (live) setWidth(measured);
    });
    return () => {
      live = false;
    };
  }, []);
  return width;
}
