import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listProjectsRpc, projectSettings, resolveRefsRpc } from "./shared/contracts";
import { clearCaches, createHandlers } from "./server/resolve";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(projectSettings);
  const handlers = createHandlers(settings);
  server.handle(resolveRefsRpc, handlers.resolve);
  server.handle(listProjectsRpc, handlers.listProjects);
  // A changed repo or project changes what references point at.
  const unsubscribe = settings.subscribe(() => clearCaches());
  return () => {
    unsubscribe();
    clearCaches();
  };
}
