import { describe, expect, it } from "vitest";
import { offsetForDrag, thumbGeometry } from "../client/scrollbar-geometry";

describe("thumbGeometry", () => {
  it("hides the thumb when nothing overflows", () => {
    expect(thumbGeometry({ offset: 0, viewportSize: 400, contentSize: 300 }).visible).toBe(false);
  });

  it("sizes the thumb to the visible fraction and places it by scroll position", () => {
    const geometry = thumbGeometry({ offset: 300, viewportSize: 400, contentSize: 1000 });
    expect(geometry).toMatchObject({ visible: true, maxScrollOffset: 600, thumbSize: 160, maxThumbOffset: 240, thumbOffset: 120 });
  });

  it("keeps a minimum thumb size for long content", () => {
    expect(thumbGeometry({ offset: 0, viewportSize: 400, contentSize: 100_000 }).thumbSize).toBe(36);
  });
});

describe("offsetForDrag", () => {
  it("scales thumb movement to content movement and clamps", () => {
    const geometry = thumbGeometry({ offset: 0, viewportSize: 400, contentSize: 1000 });
    expect(offsetForDrag(0, 120, geometry)).toBe(300);
    expect(offsetForDrag(0, 10_000, geometry)).toBe(600);
    expect(offsetForDrag(300, -10_000, geometry)).toBe(0);
  });
});
