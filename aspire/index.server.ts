import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  aspireLogs,
  aspireResources,
  aspireStatus,
  detectAspire,
  resourceCommand,
  restartAspire,
  selectAppHost,
  startAspire,
  stopAspire,
  stopForArchivedWorkspace,
} from "./server/aspire";
import { killAll } from "./server/cli";
import { disposeLogs } from "./server/logs";
import { disposeMonitor } from "./server/monitor";
import {
  aspireLogsRpc,
  aspireResourcesRpc,
  aspireStatusRpc,
  detectAspireRpc,
  resourceCommandRpc,
  restartAspireRpc,
  selectAppHostRpc,
  startAspireRpc,
  stopAspireRpc,
} from "./shared/aspire";

export default function contribute(server: PluginServerContext) {
  server.handle(detectAspireRpc, detectAspire);
  server.handle(selectAppHostRpc, selectAppHost);
  server.handle(aspireStatusRpc, aspireStatus);
  server.handle(startAspireRpc, startAspire);
  server.handle(stopAspireRpc, stopAspire);
  server.handle(restartAspireRpc, restartAspire);
  server.handle(aspireResourcesRpc, aspireResources);
  server.handle(aspireLogsRpc, aspireLogs);
  server.handle(resourceCommandRpc, resourceCommand);
  const offArchived = server.on("workspace.archived", ({ workspace }) => stopForArchivedWorkspace(workspace.cwd));
  return () => {
    offArchived();
    disposeLogs();
    disposeMonitor();
    killAll();
  };
}
