import { dirname } from "node:path";
import type { AspireResource, AspireResources, AspireStatus, ResourceCommand } from "../shared/aspire";
import { IDLE_STATUS } from "../shared/aspire";
import { followAspire, runAspire } from "./cli";
import { normalizePath } from "./state";

const START_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 2 * 60_000;
const RESOURCE_COMMAND_TIMEOUT_MS = 2 * 60_000;
// Resource watches outlive a closed popover, but not a client that stopped asking.
const RESOURCE_WATCH_IDLE_MS = 5 * 60_000;
// `describe --follow` sends the snapshot as a burst; resources() waits for it rather than returning a partial list.
const SNAPSHOT_QUIET_MS = 150;
const SNAPSHOT_MAX_MS = 3_000;
const LOGIN_URL = /https?:\/\/[^\s"'<>]+\/login\?t=[^\s"'<>]+/i;
const LOG_PATH = /(?:[A-Za-z]:\\|\/)[^\s"'<>]+\.log\b/;

type PsEntry = { appHostPath: string; appHostPid: number | null; dashboardUrl: string | null; logFilePath: string | null };
type Launch = { cancelled: boolean };
type Failure = { error: string; logFilePath: string | null };

/** Running app hosts as reported by the single shared `aspire ps --follow` stream. */
const running = new Map<string, PsEntry>();
const launches = new Map<string, Launch>();
const failures = new Map<string, Failure>();
const stopping = new Set<string>();
const loginUrls = new Map<string, string>();

let disposeFollow: (() => void) | null = null;

// One-shot `aspire ps` stops "orphaned" app hosts as a side effect, so only ever use `--follow`.
function ensureFollowing() {
  disposeFollow ??= followAspire(["ps", "--format", "Json", "--follow"], onPsObject, () => {
    // A reconnected stream re-reports every running app host, so start from nothing.
    processes.clear();
    running.clear();
  });
}

/**
 * Every app host process `ps` has reported as running, per app host path, keyed by PID. One path can have more than
 * one process over time (watch mode relaunches the app host; a restart overlaps the old and new one), and `ps` may
 * report the new process before the old one's "stopped" — so a "stopped" only removes its own process, and the path
 * counts as running while any process remains. `running` holds the newest remaining process for each path.
 */
const processes = new Map<string, Map<string, PsEntry>>();

function forget(key: string) {
  processes.delete(key);
  running.delete(key);
  loginUrls.delete(key);
  stopWatchingResources(key);
}

function onPsObject(value: unknown) {
  if (!value || typeof value !== "object") return;
  const entry = value as Record<string, unknown>;
  if (typeof entry.appHostPath !== "string") return;
  const key = normalizePath(entry.appHostPath);
  const appHostPid = typeof entry.appHostPid === "number" ? entry.appHostPid : null;
  const cliPid = typeof entry.cliPid === "number" ? entry.cliPid : null;
  const pid = appHostPid ?? cliPid;
  if (entry.status === "stopped") {
    const live = processes.get(key);
    // Without a PID there's no telling which process stopped, so fall back to treating the app host as stopped.
    if (pid === null || !live) return forget(key);
    live.delete(String(pid));
    const newest = [...live.values()].pop();
    if (!newest) return forget(key);
    running.set(key, newest);
    return;
  }
  const report: PsEntry = {
    appHostPath: entry.appHostPath,
    appHostPid,
    dashboardUrl: typeof entry.dashboardUrl === "string" ? entry.dashboardUrl : null,
    logFilePath: typeof entry.logFilePath === "string" ? entry.logFilePath : null,
  };
  let live = processes.get(key);
  if (!live) processes.set(key, (live = new Map()));
  // Re-insert so the newest report is last.
  live.delete(String(pid));
  live.set(String(pid), report);
  running.set(key, report);
  failures.delete(key);
}

export function isRunning(appHostPath: string) {
  ensureFollowing();
  return running.has(normalizePath(appHostPath));
}

/** The app host path exactly as `aspire ps` printed it, or null when it isn't running. */
export function runningPath(appHostPath: string) {
  ensureFollowing();
  return running.get(normalizePath(appHostPath))?.appHostPath ?? null;
}

export function statusFor(appHostPath: string | null): AspireStatus {
  ensureFollowing();
  if (!appHostPath) return IDLE_STATUS;
  const key = normalizePath(appHostPath);
  const entry = running.get(key);
  if (entry) {
    return {
      state: stopping.has(key) ? "stopping" : "running",
      appHostPath,
      dashboardUrl: loginUrls.get(key) ?? entry.dashboardUrl,
      pid: entry.appHostPid,
      error: null,
      logFilePath: entry.logFilePath,
    };
  }
  if (launches.has(key)) return { ...IDLE_STATUS, state: stopping.has(key) ? "stopping" : "starting", appHostPath };
  const failure = failures.get(key);
  return { ...IDLE_STATUS, appHostPath, error: failure?.error ?? null, logFilePath: failure?.logFilePath ?? null };
}

export function start(appHostPath: string): AspireStatus {
  ensureFollowing();
  const key = normalizePath(appHostPath);
  if (running.has(key) || launches.has(key)) return statusFor(appHostPath);
  const launch: Launch = { cancelled: false };
  launches.set(key, launch);
  failures.delete(key);
  console.log(`[aspire] starting ${appHostPath}`);
  void runAspire(["start", "--apphost", appHostPath, "--format", "Json"], { cwd: dirname(appHostPath), timeoutMs: START_TIMEOUT_MS })
    .then(({ code, stdout, stderr, timedOut }) => {
      const output = `${stdout}\n${stderr}`;
      const loginUrl = LOGIN_URL.exec(output)?.[0];
      if (loginUrl) loginUrls.set(key, loginUrl);
      if (launch.cancelled) return;
      if (timedOut) failures.set(key, { error: "Timed out waiting for the app host to start", logFilePath: LOG_PATH.exec(output)?.[0] ?? null });
      else if (code !== 0) failures.set(key, { error: summarize(output, code), logFilePath: LOG_PATH.exec(output)?.[0] ?? null });
      console.log(`[aspire] aspire start exited with code ${code} for ${appHostPath}`);
    })
    .catch((error: Error) => {
      failures.set(key, { error: `Could not run the Aspire CLI: ${error.message}`, logFilePath: null });
    })
    .finally(() => launches.delete(key));
  return statusFor(appHostPath);
}

export async function stop(appHostPath: string): Promise<AspireStatus> {
  ensureFollowing();
  const key = normalizePath(appHostPath);
  const launch = launches.get(key);
  if (launch) launch.cancelled = true;
  if (stopping.has(key)) return statusFor(appHostPath);
  stopping.add(key);
  try {
    const target = running.get(key)?.appHostPath ?? appHostPath;
    const { code, stdout, stderr } = await runAspire(["stop", "--apphost", target], { cwd: dirname(appHostPath), timeoutMs: STOP_TIMEOUT_MS });
    if (code !== 0) throw new Error(summarize(`${stdout}\n${stderr}`, code));
    // `ps --follow` reports the exit shortly after; drop the entry now so the UI doesn't flash "running".
    forget(key);
  } finally {
    stopping.delete(key);
  }
  return statusFor(appHostPath);
}

export async function restart(appHostPath: string): Promise<AspireStatus> {
  if (running.has(normalizePath(appHostPath))) await stop(appHostPath);
  return start(appHostPath);
}

/**
 * The app host's resources, from one long-lived `aspire describe --follow` per running app host. Every CLI call
 * leaves a log file in `~/.aspire/logs` and a connection in the app host's log, so resources are never polled: the
 * stream sends each resource once, then the resource again whenever it changes.
 */
export async function resources(appHostPath: string): Promise<AspireResources> {
  ensureFollowing();
  const key = normalizePath(appHostPath);
  const entry = running.get(key);
  if (!entry) return { resources: [], error: null };
  let watch = resourceWatches.get(key);
  if (!watch) resourceWatches.set(key, (watch = watchResources(entry.appHostPath)));
  watch.lastRead = Date.now();
  sweeper ??= setInterval(sweepResourceWatches, RESOURCE_WATCH_IDLE_MS / 2);
  await watch.ready;
  return { resources: [...watch.resources.values()], error: null };
}

type ResourceWatch = {
  resources: Map<string, AspireResource>;
  /** Resolves once the initial snapshot has arrived (or the wait for it gave up). */
  ready: Promise<void>;
  lastRead: number;
  dispose(): void;
};

const resourceWatches = new Map<string, ResourceWatch>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function watchResources(appHostPath: string): ResourceWatch {
  let markReady!: () => void;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  // The snapshot arrives as one burst with no end marker; take a short pause after it as the end.
  const empty = setTimeout(markReady, SNAPSHOT_MAX_MS);
  const watch: ResourceWatch = { resources: new Map(), ready, lastRead: Date.now(), dispose: () => {} };
  const stop = followAspire(
    ["describe", "--apphost", appHostPath, "--format", "Json", "--follow"],
    (value) => {
      const resource = toResource(value);
      if (!resource) return;
      if (resource.state === "Hidden") watch.resources.delete(resource.name);
      else watch.resources.set(resource.name, resource);
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(markReady, SNAPSHOT_QUIET_MS);
    },
    // A reconnect replays every resource, so start from nothing.
    () => watch.resources.clear(),
    dirname(appHostPath),
  );
  watch.dispose = () => {
    clearTimeout(empty);
    if (quiet) clearTimeout(quiet);
    markReady();
    stop();
  };
  return watch;
}

function stopWatchingResources(key: string) {
  resourceWatches.get(key)?.dispose();
  resourceWatches.delete(key);
}

function sweepResourceWatches() {
  for (const [key, watch] of resourceWatches) {
    if (Date.now() - watch.lastRead > RESOURCE_WATCH_IDLE_MS) stopWatchingResources(key);
  }
}

function toResource(value: unknown): AspireResource | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.name !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const urls = Array.isArray(r.urls) ? r.urls : [];
  return {
    name: r.name,
    displayName: str(r.displayName) ?? r.name,
    type: str(r.resourceType) ?? "",
    state: str(r.state),
    health: str(r.healthStatus),
    exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
    urls: urls
      .filter((u): u is { name?: unknown; url: string; isInternal?: unknown } => !!u && typeof u === "object" && typeof (u as { url?: unknown }).url === "string")
      .filter((u) => u.isInternal !== true)
      .map((u) => ({ name: typeof u.name === "string" ? u.name : "", url: u.url })),
    dashboardUrl: str(r.dashboardUrl),
    commands: { start: commandState(r.commands, "start"), stop: commandState(r.commands, "stop") },
  };
}

/** `describe` lists each available command with a state; hidden ones are left out, as the dashboard does. */
function commandState(commands: unknown, name: ResourceCommand) {
  const command = commands && typeof commands === "object" ? (commands as Record<string, unknown>)[name] : undefined;
  if (!command || typeof command !== "object") return undefined;
  const state = (command as { state?: unknown }).state;
  if (state === "Hidden") return undefined;
  return { enabled: state === "Enabled" };
}

/** Runs `aspire resource <name> start|stop` against a running app host. */
export async function runResourceCommand(appHostPath: string, resource: string, command: ResourceCommand) {
  ensureFollowing();
  const key = normalizePath(appHostPath);
  const entry = running.get(key);
  if (!entry) throw new Error("The app host isn't running");
  const { code, stdout, stderr } = await runAspire(["resource", resource, command, "--apphost", entry.appHostPath], {
    cwd: dirname(appHostPath),
    timeoutMs: RESOURCE_COMMAND_TIMEOUT_MS,
  });
  if (code !== 0) throw new Error(summarize(`${stdout}\n${stderr}`, code));
}

function summarize(output: string, code: number | null) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const text = lines.slice(-6).join("\n");
  return text ? text.slice(-800) : `Aspire CLI exited with code ${code}`;
}

export function disposeMonitor() {
  disposeFollow?.();
  disposeFollow = null;
  processes.clear();
  running.clear();
  for (const key of [...resourceWatches.keys()]) stopWatchingResources(key);
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
