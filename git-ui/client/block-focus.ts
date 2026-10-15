import { useSyncExternalStore } from "react";
import type { Block } from "./diff-rows";

/**
 * Which change the keyboard cursor is on and which one the pointer is over, outside React state. Rows subscribe to
 * just their own block's part of it, so moving the cursor or the pointer re-renders the rows that change and nothing
 * else: not the panel, and not the list's other cells.
 */
export function createBlockFocus() {
  let state: { active: string | null; hovered: string | null } = { active: null, hovered: null };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<typeof state>) {
      const next = { ...state, ...patch };
      if (next.active === state.active && next.hovered === state.hovered) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type BlockFocus = ReturnType<typeof createBlockFocus>;

const ACTIVE = 1;
const TOOLBAR = 2;

/**
 * A row's part in the focus: whether its block is the cursor's, and whether to show the block's toolbar on it (its
 * first row, while the block is hovered or the cursor's, if it can be applied).
 */
export function useBlockFocus(focus: BlockFocus, block: Block | null, blockStart: boolean) {
  const snapshot = () => {
    if (!block) return 0;
    const { active, hovered } = focus.get();
    const isActive = active === block.id;
    const toolbar = blockStart && block.diff.patchable && !block.pending && (isActive || hovered === block.id);
    return (isActive ? ACTIVE : 0) | (toolbar ? TOOLBAR : 0);
  };
  const bits = useSyncExternalStore(focus.subscribe, snapshot, snapshot);
  return { active: (bits & ACTIVE) !== 0, toolbar: (bits & TOOLBAR) !== 0 };
}
