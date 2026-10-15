/** Keyboard navigation in the Diff panel: Vim keys and arrows between changes and files. */

export type DiffCommand = "next-change" | "previous-change" | "next-file" | "previous-file" | "toggle-change";

const KEYS: Record<string, DiffCommand> = {
  j: "next-change",
  ArrowDown: "next-change",
  k: "previous-change",
  ArrowUp: "previous-change",
  l: "next-file",
  ArrowRight: "next-file",
  h: "previous-file",
  ArrowLeft: "previous-file",
  s: "toggle-change",
};

type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };

/** The command a key press means, or null to leave it alone (modified keys stay with the app and the browser). */
export function commandForKey(event: KeyLike): DiffCommand | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  return KEYS[event.key] ?? null;
}

/**
 * Where the cursor is: a block id in a file, and its position among the file's blocks, so the cursor stays in
 * place when its block is staged away. A null id means "the block at `position`", clamped to the file's blocks.
 */
export type DiffCursor = { path: string | null; id: string | null; position: number };

/** The last block, whatever the file has. */
export const LAST = Number.MAX_SAFE_INTEGER;

/** The block the cursor is on among the shown file's blocks. */
export function resolveCursor(cursor: DiffCursor, path: string | null, blockIds: readonly string[]): string | null {
  if (blockIds.length === 0) return null;
  if (cursor.path !== path) return blockIds[0];
  if (cursor.id && blockIds.includes(cursor.id)) return cursor.id;
  return blockIds[Math.min(cursor.position, blockIds.length - 1)];
}

/**
 * The cursor after a move. Stepping past the first or last block goes to the neighbouring file (to its last block when
 * going back), and stops at the ends of the list. Returns null when there's nowhere to go.
 */
export function moveCursor(
  command: Exclude<DiffCommand, "toggle-change">,
  state: { paths: readonly string[]; path: string | null; blockIds: readonly string[]; active: string | null },
): DiffCursor | null {
  const fileIndex = state.path === null ? -1 : state.paths.indexOf(state.path);
  const file = (offset: number, position: number): DiffCursor | null => {
    const next = state.paths[fileIndex + offset];
    return next === undefined || fileIndex < 0 ? null : { path: next, id: null, position };
  };
  const at = state.active === null ? -1 : state.blockIds.indexOf(state.active);
  switch (command) {
    case "next-file":
      return file(1, 0);
    case "previous-file":
      return file(-1, 0);
    case "next-change":
      return at + 1 < state.blockIds.length ? { path: state.path, id: state.blockIds[at + 1], position: at + 1 } : file(1, 0);
    case "previous-change":
      return at > 0 ? { path: state.path, id: state.blockIds[at - 1], position: at - 1 } : file(-1, LAST);
  }
}
