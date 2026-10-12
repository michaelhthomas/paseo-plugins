import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeHeaderButtons } from "./client/header-button";
import { createLogsPanel, LOGS_PANEL_ID } from "./client/logs-panel";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: LOGS_PANEL_ID,
    title: "Aspire logs",
    icon: "Logs",
    context: "workspace",
    Component: createLogsPanel(client),
  });
  const removeButtons = contributeHeaderButtons(client);
  return () => {
    removeButtons();
    void removePanel();
  };
}
