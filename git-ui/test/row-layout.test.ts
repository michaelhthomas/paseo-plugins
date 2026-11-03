import { describe, expect, it } from "vitest";
import { CODE_PADDING_RIGHT, codeRegions, LINE_HEIGHT } from "../client/diff-metrics";
import type { Row } from "../client/diff-rows";
import { GAP_HEIGHT, rowOffsets, SECTION_HEIGHT, textColumns, visualLines } from "../client/row-layout";

const line = (content: string, extra: Partial<Extract<Row, { kind: "line" }>> = {}): Row => ({
  kind: "line",
  id: content,
  type: "context",
  content,
  tokens: null,
  oldNo: 1,
  newNo: 1,
  noNewline: false,
  digits: 3,
  block: null,
  blockStart: false,
  blockEnd: false,
  ...extra,
});

describe("textColumns", () => {
  it("counts tabs to the next tab stop and wide characters twice", () => {
    expect(textColumns("abc")).toBe(3);
    expect(textColumns("\tx")).toBe(9);
    expect(textColumns("ab\tx")).toBe(9);
    expect(textColumns("漢字")).toBe(4);
    expect(textColumns("😀")).toBe(2);
  });
});

describe("visualLines", () => {
  // Ten 7px columns.
  const width = 70 + CODE_PADDING_RIGHT;

  it("breaks on the character grid", () => {
    expect(visualLines({ content: "", noNewline: false }, width, 7)).toBe(1);
    expect(visualLines({ content: "x".repeat(10), noNewline: false }, width, 7)).toBe(1);
    expect(visualLines({ content: "x".repeat(11), noNewline: false }, width, 7)).toBe(2);
    expect(visualLines({ content: "x".repeat(31), noNewline: false }, width, 7)).toBe(4);
  });

  it("counts the no-newline marker", () => {
    expect(visualLines({ content: "x".repeat(5), noNewline: true }, width, 7)).toBe(2);
  });
});

describe("rowOffsets", () => {
  const section: Row = { kind: "section", id: "s", key: "k", side: "unstaged", staged: null, unstaged: null, diff: null };
  const gap = { kind: "gap", id: "g", key: "k", start: 1, end: 40, down: true, up: true, digits: 3 } as unknown as Row;

  it("stacks fixed heights when lines don't wrap", () => {
    const offsets = rowOffsets([section, line("a"), gap, line("x".repeat(500))], { wrap: false, split: false, viewport: 400, columnWidth: 7 });
    expect([...offsets]).toEqual([0, SECTION_HEIGHT, SECTION_HEIGHT + LINE_HEIGHT, SECTION_HEIGHT + LINE_HEIGHT + GAP_HEIGHT, SECTION_HEIGHT + LINE_HEIGHT * 2 + GAP_HEIGHT]);
  });

  it("gives wrapped lines a line height per visual line", () => {
    const viewport = 400;
    const perLine = Math.floor((codeRegions({ split: false, viewport, digits: 3, columns: { left: 0, right: 0 } }).left.width - CODE_PADDING_RIGHT) / 7);
    const offsets = rowOffsets([line("x".repeat(perLine * 2 + 1))], { wrap: true, split: false, viewport, columnWidth: 7 });
    expect(offsets[1]).toBe(LINE_HEIGHT * 3);
  });

  it("makes a split row as tall as its taller side", () => {
    const cell = (content: string) => ({ type: "context" as const, content, tokens: null, no: 1, noNewline: false });
    const row: Row = { kind: "split", id: "p", left: cell("x"), right: cell("x".repeat(200)), digits: 3, block: null, blockStart: false, blockEnd: false };
    const viewport = 600;
    const { right } = codeRegions({ split: true, viewport, digits: 3, columns: { left: 0, right: 0 } });
    const lines = Math.ceil(200 / Math.floor((right!.width - CODE_PADDING_RIGHT) / 7));
    expect(rowOffsets([row], { wrap: true, split: true, viewport, columnWidth: 7 })[1]).toBe(LINE_HEIGHT * lines);
  });
});
