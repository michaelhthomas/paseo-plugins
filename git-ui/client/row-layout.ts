import { CODE_PADDING_RIGHT, codeRegions, LINE_HEIGHT } from "./diff-metrics";
import type { Row } from "./diff-rows";

/**
 * Every diff row's height, worked out rather than measured, so the list can place any row (and scroll straight to it)
 * without rendering the rows before it. Header rows have fixed heights; a line is `LINE_HEIGHT` per visual line, and
 * wrapped code breaks on a strict character grid (diff-line.tsx), so its visual lines follow from its length.
 */

export const SECTION_HEIGHT = 36;
export const GAP_HEIGHT = 26;
export const NOTICE_HEIGHT = 44;

export type RowLayout = {
  wrap: boolean;
  split: boolean;
  /** The list's width. */
  viewport: number;
  /** One monospace character's width, as the browser draws it. */
  columnWidth: number;
};

const TAB_SIZE = 8;
const NO_NEWLINE_SUFFIX = 14; // "  ⊘ no newline"
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

/** How many monospace columns a line of code takes: tabs to the next tab stop, CJK and astral characters two. */
export function textColumns(text: string) {
  let columns = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\t") columns += TAB_SIZE - (columns % TAB_SIZE);
    else columns += WIDE.test(char) ? 2 : 1; // a surrogate pair counts its two halves
  }
  return columns;
}

/** Visual lines of one cell of code in `width` pixels. */
export function visualLines(cell: { content: string; noNewline: boolean }, width: number, columnWidth: number) {
  const perLine = Math.floor((width - CODE_PADDING_RIGHT + 0.01) / columnWidth);
  if (perLine <= 0) return 1;
  const columns = textColumns(cell.content) + (cell.noNewline ? NO_NEWLINE_SUFFIX : 0);
  return Math.max(1, Math.ceil(columns / perLine));
}

export function rowHeight(row: Row, layout: RowLayout) {
  switch (row.kind) {
    case "section":
      return SECTION_HEIGHT;
    case "gap":
      return GAP_HEIGHT;
    case "notice":
      return NOTICE_HEIGHT;
    case "line":
    case "split": {
      if (!layout.wrap || !layout.viewport) return LINE_HEIGHT;
      const regions = codeRegions({ split: layout.split, viewport: layout.viewport, digits: row.digits, columns: { left: 0, right: 0 } });
      if (row.kind === "line") return LINE_HEIGHT * visualLines(row, regions.left.width, layout.columnWidth);
      const left = row.left ? visualLines(row.left, regions.left.width, layout.columnWidth) : 1;
      const right = row.right && regions.right ? visualLines(row.right, regions.right.width, layout.columnWidth) : 1;
      return LINE_HEIGHT * Math.max(left, right);
    }
  }
}

/** Each row's top, plus the total height at the end. */
export function rowOffsets(rows: readonly Row[], layout: RowLayout) {
  const offsets = new Float64Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) offsets[i + 1] = offsets[i] + rowHeight(rows[i], layout);
  return offsets;
}
