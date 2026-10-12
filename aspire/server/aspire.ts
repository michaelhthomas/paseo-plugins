import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AppHost } from "../shared/aspire";
import {
  aspireLogsRpc,
  aspireResourcesRpc,
  aspireStatusRpc,
  detectAspireRpc,
  restartAspireRpc,
  selectAppHostRpc,
  startAspireRpc,
  stopAspireRpc,
} from "../shared/aspire";
import { checkCli } from "./cli";
import { detectAppHosts, forgetDetection } from "./detect";
import { readLogs } from "./logs";
import { isRunning, resources, restart, runningPath, start, statusFor, stop } from "./monitor";
import { getSelection, normalizePath, setSelection } from "./state";

async function workspaceDirectory(workspaceId: string, { paseo }: PluginHandlerContext) {
  const workspace = paseo.workspaces.ref(workspaceId);
  await workspace.refresh();
  const directory = workspace.directory;
  if (!directory) throw new Error(`Workspace ${workspaceId} has no directory`);
  return directory;
}

/** Remembered pick, then `aspire.config.json`, then the only one, then whichever is running. */
function choose(directory: string, appHosts: AppHost[]): AppHost | null {
  const remembered = getSelection(directory);
  if (remembered) {
    const match = appHosts.find((host) => normalizePath(host.path) === normalizePath(remembered));
    if (match) return match;
  }
  const configured = appHosts.find((host) => host.source === "config");
  if (configured) return configured;
  if (appHosts.length === 1) return appHosts[0];
  return appHosts.find((host) => isRunning(host.path)) ?? null;
}

async function resolveAppHost(workspaceId: string, context: PluginHandlerContext) {
  const directory = await workspaceDirectory(workspaceId, context);
  const appHosts = await detectAppHosts(directory);
  return { directory, appHosts, selected: choose(directory, appHosts) };
}

async function requireAppHost(workspaceId: string, context: PluginHandlerContext) {
  const { selected, appHosts } = await resolveAppHost(workspaceId, context);
  if (selected) return selected.path;
  throw new Error(appHosts.length ? "Choose an app host first" : "No Aspire app host found in this workspace");
}

export async function detectAspire({ workspaceId }: RpcInput<typeof detectAspireRpc>, context: PluginHandlerContext) {
  const { appHosts, selected } = await resolveAppHost(workspaceId, context);
  return { appHosts, selected: selected?.path ?? null, cliAvailable: appHosts.length ? await checkCli() : false };
}

export async function selectAppHost({ workspaceId, path }: RpcInput<typeof selectAppHostRpc>, context: PluginHandlerContext) {
  const { directory, appHosts } = await resolveAppHost(workspaceId, context);
  const match = appHosts.find((host) => normalizePath(host.path) === normalizePath(path));
  if (!match) throw new Error(`Not an app host in this workspace: ${path}`);
  setSelection(directory, match.path);
  return statusFor(match.path);
}

export async function aspireStatus({ workspaceId }: RpcInput<typeof aspireStatusRpc>, context: PluginHandlerContext) {
  const { selected } = await resolveAppHost(workspaceId, context);
  return statusFor(selected?.path ?? null);
}

export async function startAspire({ workspaceId }: RpcInput<typeof startAspireRpc>, context: PluginHandlerContext) {
  if (!(await checkCli())) throw new Error("The Aspire CLI (13.5 or newer) was not found on the Paseo daemon's PATH");
  return start(await requireAppHost(workspaceId, context));
}

export async function stopAspire({ workspaceId }: RpcInput<typeof stopAspireRpc>, context: PluginHandlerContext) {
  return stop(await requireAppHost(workspaceId, context));
}

export async function restartAspire({ workspaceId }: RpcInput<typeof restartAspireRpc>, context: PluginHandlerContext) {
  return restart(await requireAppHost(workspaceId, context));
}

export async function aspireResources({ workspaceId }: RpcInput<typeof aspireResourcesRpc>, context: PluginHandlerContext) {
  const { selected } = await resolveAppHost(workspaceId, context);
  return selected ? resources(selected.path) : { resources: [], error: null };
}

export async function aspireLogs(
  { workspaceId, generation, after }: RpcInput<typeof aspireLogsRpc>,
  context: PluginHandlerContext,
) {
  const { selected } = await resolveAppHost(workspaceId, context);
  const path = selected ? runningPath(selected.path) : null;
  if (!path) return readLogs(selected?.path ?? "", false, generation, after);
  return readLogs(path, true, generation, after);
}

/** Stops whatever app host this workspace was running when it is archived. */
export async function stopForArchivedWorkspace(directory: string) {
  forgetDetection(directory);
  const appHosts = await detectAppHosts(directory);
  forgetDetection(directory);
  for (const host of appHosts) {
    if (isRunning(host.path)) await stop(host.path).catch((error) => console.error(`[aspire] failed to stop ${host.path}`, error));
  }
}
