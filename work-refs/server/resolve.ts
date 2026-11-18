import type { PluginHandlerContext, PluginSettings } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import type { ProjectConfig, ProjectSummary, ResolvedRef, resolveRefsRpc } from "../shared/contracts";
import { EMPTY_CONFIG, type projectSettings } from "../shared/contracts";
import { run } from "./exec";
import { clearTypeCache, fetchAdo, fetchGithub, notFound } from "./providers";
import { mergeConfig, normalizeOrganization, normalizeRepo, parseRemote } from "./remote";

const FOUND_TTL_MS = 5 * 60_000;
const MISSING_TTL_MS = 60_000;
const REMOTE_TTL_MS = 5 * 60_000;
const MAX_CACHE = 2_000;

interface Entry<T> {
  value: Promise<T>;
  expiresAt: number;
}

const refCache = new Map<string, Entry<ResolvedRef>>();
const remoteCache = new Map<string, Entry<ProjectConfig>>();
/** An agent's workspace, and so its project, never changes. */
const agentProjects = new Map<string, Promise<AgentProject>>();

interface AgentProject {
  projectId: string;
  directory: string;
}

function remember<T>(cache: Map<string, Entry<T>>, key: string, load: () => Promise<T>, ttl: (value: T) => number): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  const entry: Entry<T> = { value: load(), expiresAt: Number.POSITIVE_INFINITY };
  cache.set(key, entry);
  entry.value.then(
    (value) => (entry.expiresAt = Date.now() + ttl(value)),
    () => cache.delete(key),
  );
  return entry.value;
}

export function clearCaches() {
  refCache.clear();
  remoteCache.clear();
  agentProjects.clear();
  clearTypeCache();
}

async function lookUpAgentProject(agentId: string, { paseo }: PluginHandlerContext): Promise<AgentProject> {
  const agent = paseo.agents.ref(agentId);
  if (!agent.workspaceId) await agent.refresh();
  if (!agent.workspaceId) throw new Error(`Agent ${agentId} has no workspace`);
  const workspace = paseo.workspaces.ref(agent.workspaceId);
  if (!workspace.projectId || !workspace.directory) await workspace.refresh();
  if (!workspace.projectId || !workspace.directory) throw new Error(`Workspace ${agent.workspaceId} has no project`);
  return { projectId: workspace.projectId, directory: workspace.directory };
}

function agentProject(agentId: string, context: PluginHandlerContext) {
  let project = agentProjects.get(agentId);
  if (!project) {
    project = lookUpAgentProject(agentId, context);
    agentProjects.set(agentId, project);
    project.catch(() => agentProjects.delete(agentId));
  }
  return project;
}

/** The project's GitHub repo and Azure DevOps organization and project, from its `origin` remote. */
export function detectFromRemote(rootPath: string): Promise<ProjectConfig> {
  return remember(
    remoteCache,
    rootPath,
    async () => {
      try {
        return parseRemote(await run("git", ["-C", rootPath, "remote", "get-url", "origin"], { timeoutMs: 5_000 }));
      } catch {
        return EMPTY_CONFIG;
      }
    },
    () => REMOTE_TTL_MS,
  );
}

type Settings = PluginSettings<(typeof projectSettings)["schema"]>;

async function configFor(settings: Settings, projectId: string, rootPath: string) {
  const current = await settings.read();
  const configured = current.status === "ready" ? current.values.projects[projectId] : undefined;
  return mergeConfig(configured, await detectFromRemote(rootPath));
}

const ttlFor = (ref: ResolvedRef) => (ref.found ? FOUND_TTL_MS : MISSING_TTL_MS);

/** Looks up a failure as not found, so one bad item doesn't hide the rest; it's retried once its entry expires. */
const orMissing = (kind: ResolvedRef["kind"], number: number) => (error: unknown) => {
  console.warn(`[work-refs] ${kind} #${number}: ${error instanceof Error ? error.message : String(error)}`);
  return notFound(kind, number);
};

export function createHandlers(settings: Settings) {
  async function resolve({ agentId, refs }: RpcInput<typeof resolveRefsRpc>, context: PluginHandlerContext) {
    let owner: AgentProject;
    try {
      owner = await agentProject(agentId, context);
    } catch (error) {
      console.warn(`[work-refs] ${error instanceof Error ? error.message : String(error)}`);
      return { refs: refs.map(({ kind, number }) => notFound(kind, number)) };
    }
    const config = await configFor(settings, owner.projectId, owner.directory);
    const repo = normalizeRepo(config.githubRepo);
    const organization = normalizeOrganization(config.adoOrganization);
    const project = config.adoProject.trim();

    const github = refs.filter((ref) => ref.kind === "github");
    const ado = refs.filter((ref) => ref.kind === "ado");

    const githubResults = github.map(({ number }) =>
      repo
        ? remember(refCache, `github|${repo.toLowerCase()}|${number}`, () => fetchGithub(repo, number).catch(orMissing("github", number)), ttlFor)
        : Promise.resolve(notFound("github", number)),
    );

    // Azure DevOps reads many items in one request, so fetch the uncached ones together.
    const adoKey = (number: number) => `ado|${organization?.toLowerCase()}|${project.toLowerCase()}|${number}`;
    let adoResults: Promise<ResolvedRef>[];
    if (!organization) {
      adoResults = ado.map(({ number }) => Promise.resolve(notFound("ado", number)));
    } else {
      const now = Date.now();
      const pending = new Map<number, Promise<ResolvedRef>>();
      for (const { number } of ado) {
        const hit = refCache.get(adoKey(number));
        if (hit && hit.expiresAt > now) pending.set(number, hit.value);
      }
      const missing = ado.map(({ number }) => number).filter((number) => !pending.has(number));
      if (missing.length > 0) {
        const batch = fetchAdo(organization, project, missing).catch((error) => missing.map((number) => orMissing("ado", number)(error)));
        for (const [index, number] of missing.entries()) {
          pending.set(number, remember(refCache, adoKey(number), () => batch.then((results) => results[index]), ttlFor));
        }
      }
      adoResults = ado.map(({ number }) => pending.get(number)!);
    }

    const byKey = new Map<string, ResolvedRef>();
    for (const result of await Promise.all([...githubResults, ...adoResults])) byKey.set(`${result.kind}:${result.number}`, result);
    return { refs: refs.map(({ kind, number }) => byKey.get(`${kind}:${number}`) ?? notFound(kind, number)) };
  }

  async function listProjects(_input: unknown, { paseo }: PluginHandlerContext) {
    const { projects } = await paseo.projects.list();
    const summaries: ProjectSummary[] = await Promise.all(
      projects.map(async (project) => ({
        id: project.projectId,
        name: project.projectCustomName || project.projectDisplayName,
        rootPath: project.projectRootPath,
        detected: await detectFromRemote(project.projectRootPath),
      })),
    );
    summaries.sort((a, b) => a.name.localeCompare(b.name));
    return { projects: summaries };
  }

  return { resolve, listProjects };
}
