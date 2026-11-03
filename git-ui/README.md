# git-ui

A [Paseo](https://paseo.sh) plugin with a staging area, commits, and a diff you can stage individual changes from. See [OVERVIEW.md](OVERVIEW.md) for what it does.

- **Git changes** (explorer panel): files as a tree or list matching Paseo's Changes panel, grouped by nothing, tracked/untracked or staged/unstaged; tri-state checkboxes stage and unstage files, folders and groups; a right-click (long-press) menu for open, stage, unstage, copy path and discard; a commit box with Commit, Commit All and Amend.
- **Git diff** (workspace panel): one file at a time with previous/next navigation, stage, unstage and restore for each run of changed lines (from a hover toolbar, the keyboard or a right-click), expandable context, and syntax highlighting. It has split view, collapsible unchanged lines, hide whitespace (`git diff -w`) and line wrapping, like Paseo's diff, and keyboard navigation: j/k or ↓/↑ for changes, h/l or ←/→ for files, s to stage or unstage a change.
- **Command Center:** "Git: Changes" and "Git: Diff" open the panels.
- **Settings → Plugins → Git UI:** Changes panel view and grouping, diff layout, whitespace and wrapping, and syntax theme.

## Requirements

- Paseo 0.11.2 or newer, with plugins enabled on the daemon.
- git 2.28 or newer on the daemon's `PATH` (`git restore`, `--no-relative`).

## Install

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-plugins/git-ui
```

Directory installs use the plugin's own `node_modules`, so run `npm install` first. After editing, `paseo plugin reload git-ui`.

## How it works

The daemon side runs the user's `git` through [simple-git](https://github.com/steveukx/git-js), one reader and one writer per repository:

- **Reader** (four processes at a time) runs status, diffs and `cat-file` with `GIT_OPTIONAL_LOCKS=0`, so polling never takes `index.lock` from agents.
- **Writer** (one process at a time) runs every mutation, so stage, unstage, discard and commit never overlap.
- Both set `GIT_LITERAL_PATHSPECS=1`, so file names with `*` or `[` aren't globs. simple-git strips other `GIT_*` variables and `EDITOR`/`PAGER`-style keys from git's environment.

**Status** comes from `git status --porcelain=v2`, plus `git diff --numstat` (staged and unstaged) for line counts, rerun only when the status changes. Each entry carries a stamp built from its status code, its HEAD and index objects (which v2 reports), and the working-tree file's mtime and size. Those are everything its diffs depend on, so staging one file doesn't change any other file's stamp. The client refetches a diff only when its stamp changes.

**Optimistic updates.** File operations change the shown status at once (`client/optimistic.ts` predicts the result) and run one at a time in the order made. Each stays applied until a status request started after it finished comes back; a failure removes it and shows a toast. Change operations show the change as applied (`pendingBlocks`) and update the status with it, either moving part of a file's line counts (`stage-part`, `unstage-part`, `discard-part`) or the whole side when it was the last change. Only a diff requested after the change finished ends the pending display, so a refresh already in flight can't flip it back. The refetched diff then replaces the old one in place: revealed context is kept while the diff's `newSideHash` (the new side's content) is unchanged. Staging from the unstaged view also reveals the lines that become unchanged, so nothing on screen collapses or moves.

**The tree** is built like Paseo's (`packages/app/src/git/diff-tree.ts`): folders first, ASCII order, single-child folders compressed, folder line counts summed, collapse state keyed by full path. File icons are material-icon-theme SVGs, toned the way Paseo tones them; `npm run generate:icons` regenerates `client/file-icons.ts`. iOS and Android can't show SVG images, so they get Lucide icons instead.

**Diffs** load in batches (`server/diff-batch.ts`). Starting git costs a few hundred milliseconds a process on Windows, and one file's combined diff used to take five. A batch runs one `git diff` per side for all its files and splits the output by `diff --git` header. It reads every blob the files may need with a single `git cat-file --batch`, started alongside the diffs, and checks for HEAD once per repository. Files with unusual names (quotes, backslashes, control characters) and renames git doesn't pair fall back to one diff each. The client loads every diff the Diff panel can show, nearest the shown file first in the panel's order. A file that isn't loaded when it's opened is fetched on its own straight away. Diffs are parsed while keeping the raw text of the header and each hunk. Untracked files are built from their contents. Paseo's own highlighter, [`@getpaseo/highlight`](https://www.npmjs.com/package/@getpaseo/highlight), highlights whole old-side and new-side files, the same way the daemon does for the built-in diff. A batch yields to other requests between files while highlighting, so it can't hold up the file just opened.

**Single-file diff.** The Diff panel steps through items in the Changes panel's order (`navigationItems`). Grouped by staged and unstaged, each side of a file is its own item and shows that side's diff. Otherwise an item is a whole file and shows its combined diff. The server computes the combined diff with `git diff -M HEAD` (the empty tree before the first commit). Each changed line is marked with its origin: an added line is unstaged if the unstaged diff adds it, and a removed line is staged if the staged diff removes it (`lineOrigins`). Every diff the current mode can show loads in the background, the shown file first, so moving between files is instant. Split rows pair each run of removed lines with the added lines after it. With wrapping off (`client/code-scroll.tsx`), the list never scrolls sideways. Rows stay as wide as the panel and only the code is shifted, by an `Animated` translation inside a clipped region, so gutters, headers and the change toolbar never move. In split view each side keeps its half, so a long line on one side can't push the other out of view, and the sides scroll together: both take the wider side's longest line as their width (`syncRegions` in `client/diff-metrics.ts`) and share one offset. Horizontal wheel input (or Shift+wheel) scrolls, and each side gets an overlay scrollbar. Wrapped code is a flex child with `minWidth: 0` that breaks on a strict character grid (`white-space: break-spaces`, `word-break: break-all`), so long tokens break instead of overflowing and a line's height follows from its length. Keys reach the panel through `onKeyDown` on its focusable root; typing in inputs and keys with modifiers pass through. Hide whitespace reloads every diff with `-w` and marks them not patchable. Turning off Collapse unchanged lines reveals every gap in the shown file through `git.lines` (2,000 lines per request) rather than asking git for more context, so hunks and change staging stay the same; turning it back on hides revealed lines again.

**Rendering.** Rows render once per file shown, and the rest of the panel can change without touching them. The list (`DiffList`) is memoized and takes a deferred copy of the rows (`useDeferredValue`), so a file switch first updates just the header, then renders the new file in an interruptible pass. Its callbacks are single objects that call the latest handlers. The cursor and hover state live in a small external store (`client/block-focus.ts`) that each row subscribes to for its own block, so `j`/`k` and hovering re-render only the rows that change. Split rows' cells are compared by value. Unwrapped code is shifted by one CSS variable on the list (`--gitui-shift`) rather than an animated value per row. Line rows reuse cached style objects (plain objects, not `StyleSheet.create`, whose CSS classes lose to Paseo's UI font on Text), and neighbouring tokens of the same color share one element. The list keeps a couple of screens either side mounted. It never measures rows: `client/row-layout.ts` works out every row's height up front (fixed header heights, `LINE_HEIGHT` per visual line, wrapped lines from their character count and the font's measured character width, `client/column-width.ts`) and passes them as `getItemLayout`. So scrolling anywhere in a long file renders the right rows straight away, and jumping to a change scrolls straight to it. A file opens on its cursor's change: its first, from the Changes panel or stepping forward, or its last, stepping back with `k`. A file is only drawn once it's complete (its diff loaded and, with Collapse unchanged lines off, every hidden line revealed); until then the list keeps the previous file. The list is then made afresh for the file with `initialScrollIndex` at that change, so its first paint shows the change: no scroll, and no blank frame while rows render at a scrolled-to position. Later moves animate, except rapid ones (a held key), which jump so they don't pile up. On iOS and Android, where text can't be measured up front, the list measures as usual. Opening a file from the Changes panel only asks Paseo to show the Diff panel when it isn't already on screen; Paseo keeps background tabs mounted at zero size, which the panel reports.

**Changes.** The client splits each hunk into blocks: runs of consecutive changed lines with the same origin (`blocksOf`). Staging a block sends its lines (type, number and content) to `git.change`. The server recomputes the staged or unstaged diff the block belongs to and finds each line there by number and content, refusing with `stale` if any has gone. Lines from the combined diff are numbered on HEAD and the working tree, but the two diffs meet at the index. So removals still to stage are mapped through the staged diff, and additions already staged through the unstaged diff (`mapLine`). The server then builds a patch that changes only those lines, across however many hunks they're in (`buildSelectionPatch`). For a forward patch (stage), the other removals stay as context and the other additions are dropped. For a reversed patch (unstage, restore), it's the other way round. The patch is applied with `--recount`. When every change in a hunk is selected, the raw hunk is used as is. In the combined view, a block being staged or unstaged moves to the other origin at once; a restored one shows as restored.

**Patches** are built from the raw file header and raw hunk lines, sliced from git's own output. They are applied with `git apply --cached` (stage), `--cached --reverse` (unstage) or `--reverse` (restore) from a temp file. Slicing git's output keeps CRLF and "No newline at end of file" exact. For renamed or mode-changed files the header is reduced to the new path, so unstaging a change doesn't undo the rename.

**Syntax colors.** Paseo doesn't give plugins its syntax theme. "Match Paseo" reads `syntaxTheme` from the app's `@paseo:app-settings` entry in `localStorage`, which exists on desktop and web only. If Paseo adds `theme.colors.syntax` to the plugin theme, the plugin uses it instead.

## Layout

- `shared/git.ts`: RPC contracts, schemas and the settings definition.
- `server/git.ts`: repository discovery and the simple-git reader and writer.
- `server/status.ts`: status sections and stamps.
- `server/diff-parse.ts`: diff parser, hunk and partial-hunk patches.
- `server/diff.ts`: per-file diffs, context lines, applying changes.
- `server/diff-batch.ts`: batched diffs and blob reads.
- `server/highlight.ts`: highlighting cache and syntax colors.
- `server/handlers.ts`: RPC handlers, file operations and commits.
- `client/repo-store.ts`: per-workspace state shared by both panels: polling, optimistic operations, diffs, expansions, drafts.
- `client/optimistic.ts`: predicted status after a file operation.
- `client/changes-tree.ts`, `client/tree-parts.tsx`: the Changes panel's groups, trees, lists and checkbox logic, and their row parts.
- `client/menu.tsx`: the animated panel popover used for right-click, view options and the commit mode.
- `client/overlay-scrollbar.tsx`, `client/scrollbar-geometry.ts`: web overlay scrollbar for the tree and diff lists.

Paseo's own menu and overlay scrollbar components aren't available to plugins (client code can only import React, React Native, React Query, zod and the plugin SDK), so these re-implement them to Paseo's measurements and timings.
- `client/commit-box.tsx`: commit message editor and Commit split button.
- `client/file-icons.ts`: generated by `scripts/generate-file-icons.mjs`.
- `client/diff-rows.ts`: one file's diff rows (unified or split), gaps, expansion ranges, file navigation order.
- `client/diff-line.tsx`: diff row components.
- `client/diff-metrics.ts`, `client/code-scroll.tsx`: row measurements, and sideways scrolling of unwrapped code.
- `client/row-layout.ts`, `client/column-width.ts`: every row's height, worked out up front for the list.
- `client/block-focus.ts`: the cursor's and the pointer's change, which rows subscribe to.
- `client/diff-keys.ts`: keyboard commands and change/file cursor movement.
- `client/display-settings.ts`: the panels' saved view options.
- `client/diff-panel.tsx`, `client/changes-panel.tsx`: the panels.
- `client/syntax-theme.ts`, `client/settings-screen.tsx`: syntax theme resolution and settings.
- `test/`: unit tests, and integration tests against throwaway repositories.
