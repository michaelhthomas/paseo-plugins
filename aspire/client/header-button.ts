import type { PluginButton, PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { openExternalUrl } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import type { AppHost, AspireResources, AspireStatus } from "../shared/aspire";
import {
  IDLE_STATUS,
  aspireResourcesRpc,
  aspireStatusRpc,
  detectAspireRpc,
  isResourceUnhealthy,
  resourceCommandRpc,
  restartAspireRpc,
  selectAppHostRpc,
  startAspireRpc,
  stopAspireRpc,
} from "../shared/aspire";
import { createAspireIcon } from "./aspire-icon";
import { createAspirePopover, describeError, type PopoverState } from "./aspire-popover";
import { LOGS_PANEL_ID } from "./logs-panel";
import { logsTarget } from "./logs-target";

const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 15_000;
const REDETECT_MS = 60_000;
// While running, re-check resources this often so the button can flag unhealthy ones without the popover open.
const RESOURCE_CHECK_MS = 10_000;

const ICONS = {
  idle: createAspireIcon("idle"),
  busy: createAspireIcon("busy"),
  running: createAspireIcon("running"),
  failed: createAspireIcon("failed"),
};

type Entry = {
  registration: PluginButtonRegistration | null;
  appHosts: AppHost[];
  selected: string | null;
  cliAvailable: boolean;
  status: AspireStatus;
  resources: AspireResources | null;
  resourcesInflight: Promise<void> | null;
  resourcesAt: number;
  /** How many resources are unhealthy, as of the last resource check; drives the button's red dot. */
  unhealthy: number;
  actionError: string | null;
  cancelPoll: (() => void) | null;
  detectedAt: number;
  detecting: boolean;
  version: number;
  listeners: Set<() => void>;
  Content: ComponentType<PluginButtonContentProps> | null;
};

function nameOf(path: string | null) {
  if (!path) return "app host";
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.(csproj|cs|ts|mts)$/i, "");
}

export function contributeHeaderButtons(client: PluginClientContext) {
  const entries = new Map<string, Entry>();
  let stopped = false;

  const entryFor = (workspaceId: string) => {
    let entry = entries.get(workspaceId);
    if (!entry) {
      entry = {
        registration: null,
        appHosts: [],
        selected: null,
        cliAvailable: true,
        status: IDLE_STATUS,
        resources: null,
        resourcesInflight: null,
        resourcesAt: 0,
        unhealthy: 0,
        actionError: null,
        cancelPoll: null,
        detectedAt: 0,
        detecting: false,
        version: 0,
        listeners: new Set(),
        Content: null,
      };
      entries.set(workspaceId, entry);
    }
    return entry;
  };

  const notify = (entry: Entry) => {
    entry.version += 1;
    for (const listener of entry.listeners) listener();
  };

  const describe = (workspaceId: string, entry: Entry): PluginButton => {
    const { status } = entry;
    const error = entry.actionError ?? status.error;
    const name = nameOf(status.appHostPath ?? entry.selected);
    const canStartDirectly = status.state === "idle" && entry.selected !== null && !error && entry.cliAvailable;
    const unhealthy = status.state === "running" ? entry.unhealthy : 0;
    const icon =
      status.state === "running"
        ? unhealthy > 0
          ? ICONS.failed
          : ICONS.running
        : status.state === "idle"
          ? error
            ? ICONS.failed
            : ICONS.idle
          : ICONS.busy;
    const title =
      status.state === "idle"
        ? error
          ? `Aspire: ${name} failed to start`
          : entry.selected
            ? `Start Aspire app host (${name})`
            : "Choose an Aspire app host"
        : `Aspire: ${name} is ${status.state}${unhealthy > 0 ? ` (${unhealthy} unhealthy resource${unhealthy === 1 ? "" : "s"})` : ""}`;
    return {
      title,
      icon,
      label: "Aspire",
      behavior: canStartDirectly
        ? { kind: "action", onPress: () => run(workspaceId, () => client.rpc(startAspireRpc, { workspaceId })) }
        : { kind: "popover", Content: contentFor(workspaceId) },
    };
  };

  const render = (workspaceId: string) => {
    const entry = entries.get(workspaceId);
    if (!entry?.registration) return;
    entry.registration.update(describe(workspaceId, entry));
    notify(entry);
  };

  const applyStatus = (workspaceId: string, status: AspireStatus) => {
    const entry = entries.get(workspaceId);
    if (!entry || stopped) return;
    const previous = entry.status;
    entry.status = status;
    if (status.state === "idle") {
      entry.resources = null;
      entry.unhealthy = 0;
    } else if (status.state === "running" && Date.now() - entry.resourcesAt >= RESOURCE_CHECK_MS) {
      void refreshResources(workspaceId);
    }
    const changed =
      previous.state !== status.state ||
      previous.dashboardUrl !== status.dashboardUrl ||
      previous.error !== status.error ||
      previous.appHostPath !== status.appHostPath;
    if (changed) render(workspaceId);
    schedule(workspaceId, status.state === "idle" ? IDLE_POLL_MS : ACTIVE_POLL_MS);
  };

  /** Runs a start/stop/restart/select call, surfacing failures in the popover. */
  const run = async (workspaceId: string, action: () => Promise<AspireStatus>) => {
    const entry = entryFor(workspaceId);
    entry.actionError = null;
    try {
      applyStatus(workspaceId, await action());
    } catch (error) {
      entry.actionError = describeError(error);
      render(workspaceId);
    }
  };

  const refreshResources = (workspaceId: string) => {
    const entry = entries.get(workspaceId);
    if (!entry || stopped) return Promise.resolve();
    entry.resourcesInflight ??= client
      .rpc(aspireResourcesRpc, { workspaceId })
      .catch((error): AspireResources => ({ resources: entry.resources?.resources ?? [], error: describeError(error) }))
      .then((next) => {
        entry.resourcesInflight = null;
        entry.resourcesAt = Date.now();
        entry.resources = next;
        const unhealthy = next.resources.filter(isResourceUnhealthy).length;
        if (unhealthy !== entry.unhealthy) {
          entry.unhealthy = unhealthy;
          render(workspaceId);
        } else {
          notify(entry);
        }
      });
    return entry.resourcesInflight;
  };

  const contentFor = (workspaceId: string) => {
    const entry = entryFor(workspaceId);
    entry.Content ??= createAspirePopover({
      subscribe: (listener) => {
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      getVersion: () => entry.version,
      getState: (): PopoverState => ({
        status: entry.status,
        appHosts: entry.appHosts,
        selected: entry.selected,
        cliAvailable: entry.cliAvailable,
        resources: entry.resources,
        actionError: entry.actionError,
      }),
      refreshResources: () => refreshResources(workspaceId),
      open: (url) => openExternalUrl(url),
      start: () => run(workspaceId, () => client.rpc(startAspireRpc, { workspaceId })),
      stop: () => run(workspaceId, () => client.rpc(stopAspireRpc, { workspaceId })),
      restart: () => run(workspaceId, () => client.rpc(restartAspireRpc, { workspaceId })),
      resourceCommand: async (resource, command) => {
        await client.rpc(resourceCommandRpc, { workspaceId, resource, command });
        await refreshResources(workspaceId);
      },
      openLogs: (resource) => {
        logsTarget.set(workspaceId, resource);
        client.openPanel(LOGS_PANEL_ID, { workspaceId });
      },
      select: (path) => {
        entry.selected = path;
        entry.resources = null;
        return run(workspaceId, () => client.rpc(selectAppHostRpc, { workspaceId, path }));
      },
    });
    return entry.Content;
  };

  const schedule = (workspaceId: string, delay: number) => {
    const entry = entries.get(workspaceId);
    if (!entry || stopped) return;
    entry.cancelPoll?.();
    const handle = setTimeout(() => {
      entry.cancelPoll = null;
      void poll(workspaceId);
    }, delay);
    entry.cancelPoll = () => clearTimeout(handle);
  };

  const poll = async (workspaceId: string) => {
    const entry = entries.get(workspaceId);
    if (!entry?.registration || stopped) return;
    try {
      applyStatus(workspaceId, await client.rpc(aspireStatusRpc, { workspaceId }));
    } catch (error) {
      if (!stopped) console.error("[aspire] status poll failed", error);
      schedule(workspaceId, IDLE_POLL_MS);
    }
  };

  const sync = async (workspaceId: string, force: boolean) => {
    const entry = entryFor(workspaceId);
    if (entry.detecting || stopped) return;
    if (!force && Date.now() - entry.detectedAt < REDETECT_MS) return;
    entry.detecting = true;
    try {
      const detected = await client.rpc(detectAspireRpc, { workspaceId });
      entry.detectedAt = Date.now();
      if (stopped) return;
      entry.appHosts = detected.appHosts;
      entry.selected = detected.selected;
      entry.cliAvailable = detected.cliAvailable;
      if (detected.appHosts.length === 0) {
        unregister(workspaceId);
      } else if (!entry.registration) {
        entry.registration = client.addHeaderButton({ id: "aspire", workspaceId, button: describe(workspaceId, entry) });
        void poll(workspaceId);
      } else {
        render(workspaceId);
      }
    } catch (error) {
      if (!stopped) console.error(`[aspire] detection failed for ${workspaceId}`, error);
    } finally {
      entry.detecting = false;
    }
  };

  const unregister = (workspaceId: string) => {
    const entry = entries.get(workspaceId);
    if (!entry) return;
    entry.cancelPoll?.();
    entry.registration?.remove();
    entries.delete(workspaceId);
  };

  const unsubscribe = client.paseo.workspaces.subscribe((update) => {
    if (update.kind === "upsert") void sync(update.workspace.id, false);
    else if (update.kind === "remove") unregister(update.id);
  });

  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ entries: workspaces }) => {
      for (const workspace of workspaces) void sync(workspace.id, true);
    })
    .catch((error) => {
      if (!stopped) console.error("[aspire] workspace list failed", error);
    });

  return () => {
    stopped = true;
    unsubscribe();
    for (const workspaceId of [...entries.keys()]) unregister(workspaceId);
  };
}
