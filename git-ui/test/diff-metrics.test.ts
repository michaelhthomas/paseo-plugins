import { describe, expect, it } from "vitest";
import { clampOffset, codeRegions, syncRegions, COLUMN_WIDTH, CODE_PADDING_RIGHT, gutterWidth, SIGN_WIDTH } from "../client/diff-metrics";

describe("codeRegions", () => {
  const gutter = gutterWidth(3);

  it("puts unified code after both gutters, across the rest of the row", () => {
    const { left, right } = codeRegions({ split: false, viewport: 800, digits: 3, columns: { left: 100, right: 0 } });
    expect(left).toEqual({ x: gutter * 2 + SIGN_WIDTH, width: 800 - gutter * 2 - SIGN_WIDTH, content: Math.ceil(100 * COLUMN_WIDTH) + CODE_PADDING_RIGHT });
    expect(right).toBeNull();
  });

  it("gives each side of a split row its own half, whatever the other side's lines", () => {
    const { left, right } = codeRegions({ split: true, viewport: 800, digits: 3, columns: { left: 500, right: 10 } });
    expect(left.x).toBe(gutter + SIGN_WIDTH);
    expect(left.x + left.width).toBe(400);
    expect(right!.x + right!.width).toBe(800);
    expect(right!.content).toBeLessThan(right!.width);
  });
});

describe("clampOffset", () => {
  it("keeps an offset within the overflow", () => {
    const region = { x: 0, width: 300, content: 500 };
    expect(clampOffset(-20, region)).toBe(0);
    expect(clampOffset(150, region)).toBe(150);
    expect(clampOffset(900, region)).toBe(200);
    expect(clampOffset(50, { x: 0, width: 300, content: 200 })).toBe(0);
  });
});

describe("syncRegions", () => {
  it("gives both split sides the wider side's content, and leaves unified alone", () => {
    const split = codeRegions({ split: true, viewport: 800, digits: 3, columns: { left: 500, right: 10 } });
    const synced = syncRegions(split);
    expect(synced.left.content).toBe(split.left.content);
    expect(synced.right!.content).toBe(split.left.content);
    const unified = codeRegions({ split: false, viewport: 800, digits: 3, columns: { left: 10, right: 0 } });
    expect(syncRegions(unified)).toBe(unified);
  });
});
