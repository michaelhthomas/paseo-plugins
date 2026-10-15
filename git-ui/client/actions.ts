import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo, useRef } from "react";
import type { FileDiff, MutationResult, StatusEntry } from "../shared/git";
import type { Block } from "./diff-rows";
import type { FileAction, HunkAction, RepoStore } from "./repo-store";

/** Store mutations that report failures as toasts. */
export function useRepoActions(store: RepoStore, workspaceId: string) {
  const toastApi = useToast();
  const toast = useRef(toastApi);
  toast.current = toastApi;
  // Stable across renders, so memoized rows that take these callbacks don't re-render.
  return useMemo(() => {
    const report = (result: MutationResult) => {
      if (result.ok) return;
      if (result.reason === "stale") toast.current.show(result.message ?? "The file changed. The diff has been refreshed.", { variant: "warning" });
      else toast.current.error(result.message ?? "git failed");
    };
    return {
      async files(entries: readonly StatusEntry[], action: FileAction) {
        if (entries.length) report(await store.files(workspaceId, entries, action));
      },
      async block(block: Block, action: HunkAction) {
        report(await store.block(workspaceId, block, action));
      },
      async expand(diff: FileDiff, start: number, end: number) {
        try {
          await store.expand(workspaceId, diff, start, end);
        } catch (error) {
          toast.current.error(error instanceof Error ? error.message : "Couldn't load lines");
        }
      },
      async commit() {
        const result = await store.commit(workspaceId);
        if (result.ok) toast.current.show(`Committed ${result.sha?.slice(0, 7) ?? ""}`.trim(), { variant: "success" });
        else toast.current.error(result.message ?? "Commit failed");
        return result.ok;
      },
    };
  }, [store, workspaceId]);
}

/** Confirmation text for discarding files. */
export function discardMessage(entries: readonly StatusEntry[]) {
  const untracked = entries.filter((entry) => entry.kind === "untracked").length;
  const subject = entries.length === 1 ? entries[0].path : `${entries.length} files`;
  const deletion =
    untracked === 0
      ? ""
      : untracked === entries.length
        ? " Untracked files will be deleted."
        : ` ${untracked} untracked ${untracked === 1 ? "file" : "files"} will be deleted.`;
  return `Discard all unstaged changes to ${subject}? This can't be undone.${deletion}`;
}
