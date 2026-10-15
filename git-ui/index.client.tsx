import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CHANGES_PANEL_ID, createChangesPanel } from "./client/changes-panel";
import { createDiffPanel, DIFF_PANEL_ID } from "./client/diff-panel";
import { createRepoStore } from "./client/repo-store";
import { GitUiSettings } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  const store = createRepoStore(client);
  const removals = [
    client.addWorkspacePanel({
      id: CHANGES_PANEL_ID,
      title: "Git changes",
      icon: "GitBranch",
      context: "workspace",
      locations: ["explorer"],
      Component: createChangesPanel(store, client),
    }),
    client.addWorkspacePanel({
      id: DIFF_PANEL_ID,
      title: "Git diff",
      icon: "FileDiff",
      context: "workspace",
      locations: ["workspace"],
      Component: createDiffPanel(store),
    }),
    client.addCommandCenterItem({
      id: "open-changes",
      title: "Git: Changes",
      icon: "GitBranch",
      keywords: ["git", "stage", "commit", "changes"],
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel(CHANGES_PANEL_ID, { location: "explorer" }),
    }),
    client.addCommandCenterItem({
      id: "open-diff",
      title: "Git: Diff",
      icon: "FileDiff",
      keywords: ["git", "diff", "hunk", "review"],
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel(DIFF_PANEL_ID),
    }),
    client.addSettingsScreen({ id: "display", title: "Git UI", icon: "GitBranch", Component: GitUiSettings }),
  ];
  return () => {
    for (const remove of removals) void remove();
  };
}
