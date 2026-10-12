import { dirname } from "node:path";
import type { AspireResource, AspireResources, AspireStatus } from "../shared/aspire";
import { IDLE_STATUS } from "../shared/aspire";
import { followAspire, runAspire } from "./cli";
import { normalizePath } from "./state";

const START_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 2 * 60_000;
const DESCRIBE_TIMEOUT_MS = 30_000;
const RESOURCES_CACHE_MS = 2_000;
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
const resourceCache = new Map<string, { at: number; value: Promise<AspireResources> }>();

let disposeFollow: (() => void) | null = null;

// One-shot `aspire ps` stops "orphaned" app hosts as a side effect, so only ever use `--follow`.
function ensureFollowing() {
  disposeFollow ??= followAspire(["ps", "--format", "Json", "--follow"], onPsObject, () => running.clear());
}

function onPsObject(value: unknown) {
  if (!value || typeof value !== "object") return;
  const entry = value as Record<string, unknown>;
  if (typeof entry.appHostPath !== "string") return;
  const key = normalizePath(entry.appHostPath);
  if (entry.status === "stopped") {
    running.delete(key);
    loginUrls.delete(key);
    resourceCache.delete(key);
    return;
  }
  running.set(key, {
    appHostPath: entry.appHostPath,
    appHostPid: typeof entry.appHostPid === "number" ? entry.appHostPid : null,
    dashboardUrl: typeof entry.dashboardUrl === "string" ? entry.dashboardUrl : null,
    logFilePath: typeof entry.logFilePath === "string" ? entry.logFilePath : null,
  });
  failures.delete(key);
}

export function isRunning(appHostPath: string) {
  ensureFollowing();
  return running.has(normalizePath(appHostPath));
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
    running.delete(key);
    loginUrls.delete(key);
    resourceCache.delete(key);
  } finally {
    stopping.delete(key);
  }
  return statusFor(appHostPath);
}

export async function restart(appHostPath: string): Promise<AspireStatus> {
  if (running.has(normalizePath(appHostPath))) await stop(appHostPath);
  return start(appHostPath);
}

export function resources(appHostPath: string): Promise<AspireResources> {
  ensureFollowing();
  const key = normalizePath(appHostPath);
  const entry = running.get(key);
  if (!entry) return Promise.resolve({ resources: [], error: null });
  const cached = resourceCache.get(key);
  if (cached && Date.now() - cached.at < RESOURCES_CACHE_MS) return cached.value;
  const value = describe(entry.appHostPath);
  resourceCache.set(key, { at: Date.now(), value });
  return value;
}

async function describe(appHostPath: string): Promise<AspireResources> {
  try {
    const { code, stdout, stderr } = await runAspire(["describe", "--apphost", appHostPath, "--format", "Json"], {
      cwd: dirname(appHostPath),
      timeoutMs: DESCRIBE_TIMEOUT_MS,
    });
    if (code !== 0) return { resources: [], error: summarize(`${stdout}\n${stderr}`, code) };
    const json = stdout.slice(stdout.indexOf("{"));
    const parsed = JSON.parse(json) as { resources?: unknown };
    const list = Array.isArray(parsed.resources) ? parsed.resources : [];
    return { resources: list.map(toResource).filter((r): r is AspireResource => r !== null && r.state !== "Hidden"), error: null };
  } catch (error) {
    return { resources: [], error: error instanceof Error ? error.message : String(error) };
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
  };
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
  running.clear();
}
