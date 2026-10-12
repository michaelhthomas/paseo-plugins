import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { AppHost } from "../shared/aspire";
import { normalizePath } from "./state";

const SKIP_DIRECTORIES = new Set(["bin", "obj", "node_modules", ".git", ".aspire", ".vs", ".idea"]);
const MAX_DEPTH = 6;
const CACHE_MS = 15_000;
const CSPROJ_MARKER = /Sdk="Aspire\.AppHost\.Sdk|<Sdk\s+Name="Aspire\.AppHost\.Sdk"|<IsAspireHost>\s*true|Aspire\.Hosting\.AppHost/i;
const SINGLE_FILE_MARKER = /#:sdk\s+Aspire\.AppHost\.Sdk/i;
const TS_ENTRY_POINTS = new Set(["apphost.ts", "apphost.mts"]);

type Candidate = { path: string; source: AppHost["source"] };

const cache = new Map<string, { at: number; appHosts: AppHost[] }>();

export async function detectAppHosts(workspaceDir: string): Promise<AppHost[]> {
  const key = normalizePath(workspaceDir);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.appHosts;

  const candidates: Candidate[] = [];
  const configured = await configuredAppHost(workspaceDir);
  if (configured) candidates.push({ path: configured, source: "config" });
  await walk(workspaceDir, 0, false, candidates);

  const seen = new Set<string>();
  const appHosts: AppHost[] = [];
  for (const candidate of candidates) {
    const id = normalizePath(candidate.path);
    if (seen.has(id)) continue;
    seen.add(id);
    appHosts.push({
      path: candidate.path,
      relativePath: relative(workspaceDir, candidate.path) || basename(candidate.path),
      language: languageOf(candidate.path),
      source: candidate.source,
    });
  }
  const depth = (host: AppHost) => host.relativePath.split(/[\\/]/).length;
  appHosts.sort((a, b) => {
    if (a.source !== b.source) return a.source === "config" ? -1 : 1;
    return depth(a) - depth(b) || a.relativePath.localeCompare(b.relativePath);
  });

  cache.set(key, { at: Date.now(), appHosts });
  return appHosts;
}

export function forgetDetection(workspaceDir: string) {
  cache.delete(normalizePath(workspaceDir));
}

function languageOf(path: string): AppHost["language"] {
  const name = basename(path).toLowerCase();
  if (TS_ENTRY_POINTS.has(name)) return "typescript";
  if (name.endsWith(".cs")) return "single-file";
  return "csharp";
}

/** `appHost.path` from the nearest `aspire.config.json`, or the legacy `.aspire/settings.json` `appHostPath`. */
async function configuredAppHost(workspaceDir: string): Promise<string | null> {
  let directory = resolve(workspaceDir);
  for (;;) {
    const config = await readJson(join(directory, "aspire.config.json"));
    const configPath = (config?.appHost as { path?: unknown } | undefined)?.path;
    if (typeof configPath === "string" && configPath) return resolve(directory, configPath);

    const legacy = await readJson(join(directory, ".aspire", "settings.json"));
    const legacyPath = legacy?.appHostPath;
    if (typeof legacyPath === "string" && legacyPath) return resolve(directory, ".aspire", legacyPath);

    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function walk(directory: string, depth: number, underConfig: boolean, out: Candidate[]) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const hasConfig = underConfig || entries.some((entry) => entry.isFile() && entry.name === "aspire.config.json");
  const subdirectories: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name) && depth < MAX_DEPTH) subdirectories.push(path);
    } else if (entry.isFile() && (await isAppHost(path, entry.name.toLowerCase(), hasConfig))) {
      out.push({ path, source: "scan" });
    }
  }
  await Promise.all(subdirectories.map((path) => walk(path, depth + 1, hasConfig, out)));
}

async function isAppHost(path: string, name: string, underConfig: boolean) {
  if (name.endsWith(".csproj")) return matches(path, CSPROJ_MARKER);
  if (name === "apphost.cs") return matches(path, SINGLE_FILE_MARKER);
  if (TS_ENTRY_POINTS.has(name)) return underConfig;
  return false;
}

async function matches(path: string, pattern: RegExp) {
  try {
    return pattern.test(await readFile(path, "utf8"));
  } catch {
    return false;
  }
}
