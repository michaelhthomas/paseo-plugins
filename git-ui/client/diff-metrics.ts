/** Diff row measurements, and where the code sits in a row for scrolling unwrapped lines. */

/** Paseo's terminal font size, which diffs use. */
export const TERMINAL_FONT_SIZE = 13;
export const LINE_HEIGHT = 19;
/** Width of one monospace column. */
export const COLUMN_WIDTH = TERMINAL_FONT_SIZE * 0.62;
export const SIGN_WIDTH = 16;
export const CODE_PADDING_RIGHT = 12;
/** The border between the two sides of a split row. */
export const SPLIT_DIVIDER = 1;

export const gutterWidth = (digits: number) => Math.ceil(digits * COLUMN_WIDTH) + 12;

/** Where one side's code is in a row (`x`, `width`) and how wide its longest line is (`content`). */
export type CodeRegion = { x: number; width: number; content: number };

/** The code regions of a row `viewport` wide: one in unified view, a left and a right one in split view. */
export function codeRegions({
  split,
  viewport,
  digits,
  columns,
}: {
  split: boolean;
  viewport: number;
  digits: number;
  columns: { left: number; right: number };
}): { left: CodeRegion; right: CodeRegion | null } {
  const content = (count: number) => Math.ceil(count * COLUMN_WIDTH) + CODE_PADDING_RIGHT;
  const gutter = gutterWidth(digits);
  if (!split) {
    const x = gutter * 2 + SIGN_WIDTH;
    return { left: { x, width: Math.max(0, viewport - x), content: content(columns.left) }, right: null };
  }
  const half = viewport / 2;
  const lead = gutter + SIGN_WIDTH;
  return {
    left: { x: lead, width: Math.max(0, half - lead), content: content(columns.left) },
    right: { x: half + SPLIT_DIVIDER + lead, width: Math.max(0, half - SPLIT_DIVIDER - lead), content: content(columns.right) },
  };
}

/**
 * Split sides that scroll together: both as wide as the wider side's longest line, so one offset (and matching
 * scrollbars) serves both, and the shorter side scrolls into blank space.
 */
export function syncRegions(regions: { left: CodeRegion; right: CodeRegion | null }) {
  const { left, right } = regions;
  if (!right) return regions;
  const content = Math.max(left.content, right.content);
  return { left: { ...left, content }, right: { ...right, content } };
}

/** A scroll offset kept within the region's overflow. */
export function clampOffset(offset: number, region: CodeRegion) {
  return Math.min(Math.max(0, region.content - region.width), Math.max(0, offset));
}
