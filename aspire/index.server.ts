import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  aspireResources,
  aspireStatus,
  detectAspire,
  restartAspire,
  selectAppHost,
  startAspire,
  stopAspire,
  stopForArchivedWorkspace,
} from "./server/aspire";
import { killAll } from "./server/cli";
import { disposeMonitor } from "./server/monitor";
import {
  aspireResourcesRpc,
  aspireStatusRpc,
  detectAspireRpc,
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
  const offArchived = server.on("workspace.archived", ({ workspace }) => stopForArchivedWorkspace(workspace.cwd));
  return () => {
    offArchived();
    disposeMonitor();
    killAll();
  };
}
