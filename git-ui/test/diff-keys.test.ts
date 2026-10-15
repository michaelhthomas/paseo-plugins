import { describe, expect, it } from "vitest";
import { commandForKey, LAST, moveCursor, resolveCursor } from "../client/diff-keys";

describe("commandForKey", () => {
  it("maps Vim keys and arrows, and leaves modified keys alone", () => {
    expect(commandForKey({ key: "j" })).toBe("next-change");
    expect(commandForKey({ key: "ArrowUp" })).toBe("previous-change");
    expect(commandForKey({ key: "ArrowLeft" })).toBe("previous-file");
    expect(commandForKey({ key: "l" })).toBe("next-file");
    expect(commandForKey({ key: "s" })).toBe("toggle-change");
    expect(commandForKey({ key: "j", ctrlKey: true })).toBeNull();
    expect(commandForKey({ key: "J", shiftKey: true })).toBeNull();
    expect(commandForKey({ key: "x" })).toBeNull();
  });
});

describe("resolveCursor", () => {
  const ids = ["h0", "h1", "h2"];

  it("starts a newly shown file at its first change", () => {
    expect(resolveCursor({ path: "a", id: "h2", position: 2 }, "b", ids)).toBe("h0");
  });

  it("keeps its place when its change goes away, and clamps to the last change", () => {
    expect(resolveCursor({ path: "a", id: "gone", position: 1 }, "a", ids)).toBe("h1");
    expect(resolveCursor({ path: "a", id: null, position: LAST }, "a", ids)).toBe("h2");
    expect(resolveCursor({ path: "a", id: null, position: 0 }, "a", [])).toBeNull();
  });
});

describe("moveCursor", () => {
  const state = { paths: ["a", "b", "c"], path: "b", blockIds: ["h0", "h1"], active: "h0" };

  it("moves between changes", () => {
    expect(moveCursor("next-change", state)).toEqual({ path: "b", id: "h1", position: 1 });
    expect(moveCursor("previous-change", { ...state, active: "h1" })).toEqual({ path: "b", id: "h0", position: 0 });
  });

  it("crosses into the next file's first change and the previous file's last", () => {
    expect(moveCursor("next-change", { ...state, active: "h1" })).toEqual({ path: "c", id: null, position: 0 });
    expect(moveCursor("previous-change", state)).toEqual({ path: "a", id: null, position: LAST });
    expect(moveCursor("next-change", { ...state, blockIds: [], active: null })).toEqual({ path: "c", id: null, position: 0 });
  });

  it("moves between files and stops at the ends", () => {
    expect(moveCursor("previous-file", state)).toEqual({ path: "a", id: null, position: 0 });
    expect(moveCursor("next-file", { ...state, path: "c" })).toBeNull();
    expect(moveCursor("previous-change", { ...state, path: "a" })).toBeNull();
  });
});
