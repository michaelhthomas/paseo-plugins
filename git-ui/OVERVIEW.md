Git UI adds a staging area, commits, and a reviewable diff to every git workspace. It works alongside Paseo's built-in Changes panel and does not replace it.

## Git changes panel

A side panel in the explorer shows your changes as file trees laid out like Paseo's own Changes panel, with file icons, line counts per file and folder, and change badges. Each file, folder and group has a checkbox: checked means staged, a dash means partly staged, and pressing it stages or unstages everything it covers. Right-click a row (long-press on touch) to open its diff, stage or unstage, copy its path, or discard changes. Changes appear straight away and are corrected if git disagrees. Pressing a file opens it in the diff. Merge conflicts get their own group at the top; checking one marks it resolved.

The view options button in the header switches between a tree and a flat list, and groups files by nothing, by tracked and untracked, or by staged and unstaged (where a partly staged file appears in both). The choice is saved in the plugin's settings.

The commit box sits below the trees and can be expanded to fill the panel. Its button commits staged changes; the menu next to it switches to Commit All (stage everything, untracked files included, then commit) or Amend (which fills in the last message when the box is empty). On desktop and web, Ctrl+Enter commits.

## Git diff panel

A workspace tab shows one file at a time: the file you pressed in the Changes panel, or the first changed file. The header shows its name, line counts and change badge, its place in the list, and previous and next buttons. Files come in the order the Changes panel lists them.

What a file shows depends on how the Changes panel groups files:

- Grouped by staged and unstaged, opening a file under Staged shows only its staged changes, and opening it under Unstaged only its unstaged ones. Previous and next step through the groups as listed.
- Grouped any other way, the diff shows all of the file's changes against the last commit in one view. Staged changes are outlined and lightly shaded, with a hollow bar in the gutter. Unstaged changes are shaded more strongly, with a solid bar.

The header row above the code has a checkbox for the whole file, like the Changes panel: checked when everything is staged, a dash when only part is. Pressing it stages whatever isn't staged yet, or unstages the file if it's all staged.

Every run of changed lines is a change you can stage on its own, even when git would group it with nearby changes into one hunk. A bar in the gutter marks each change: green for added lines, red for removed lines, amber for lines that were replaced. Hover over a change (or move to it with the keyboard) and a small toolbar appears at its top right: Stage and Restore for unstaged changes, Unstage for staged ones. Restore asks for confirmation first. Right-click a change (long-press on touch) for the same actions, and right-click the header row to stage, unstage or copy the path of the whole file, or to discard its unstaged changes. A change shows as done as soon as you act on it and comes back if git refuses. The unchanged lines git leaves out can be revealed 20 at a time above or below a change, or all at once. Code is highlighted with Paseo's highlighter.

The keyboard moves around the diff once the panel has focus (open a file from the Changes panel, or click in the diff):

- j or ↓, k or ↑: next or previous change, continuing into the next or previous file at either end.
- l or →, h or ←: next or previous file.
- s: stage or unstage the current change.

The current change is shaded more strongly and shows its toolbar. Clicking a change makes it current.

The diff options button in the header has the same options as Paseo's own diff:

- Split view: removed lines on the left, added lines on the right.
- Collapse unchanged lines: on by default. When off, the diff shows the whole file, and changes are staged the same way.
- Hide whitespace: diffs ignore changes in whitespace, and a file whose only changes are whitespace says so. Individual changes can't be staged in this mode because they don't match the file byte for byte; whole files still can.
- Wrap long lines: when off, long lines scroll sideways while line numbers and headers stay in place. In split view the two sides scroll together. Use a horizontal scroll or Shift+wheel, or drag the scrollbar along the bottom of either side. This option is on desktop and web only; iOS and Android always wrap.

The choices are saved in the plugin's settings.

Individual changes can't be staged for untracked files, binary files, submodules or files that aren't UTF-8; stage those as whole files. Diffs with more than 5,000 changed lines are hidden until you choose Load anyway.

## How it works

Everything runs through the git installed on the daemon host, in the workspace's repository, so your git config, hooks and commit signing apply. The panels check for changes every two seconds while they are open. Before staging or restoring a change, the plugin recomputes the file's diff and applies the change only if a hunk with exactly the lines you saw is still there, so it never applies a change you haven't seen. Discarding asks for confirmation first, and discarding an untracked file deletes it.

## Settings

Settings, Plugins, Git UI holds the Changes panel's view and grouping, the diff's layout, whitespace and wrapping options, and the syntax theme for diffs. Match Paseo (the default) follows Paseo's own syntax theme on desktop and web by reading the app's stored settings; on iOS and Android, or if that can't be read, it uses One, Paseo's default. You can also pick a theme.

## Requirements

Paseo 0.11.2 or newer and git 2.28 or newer on the daemon host.
