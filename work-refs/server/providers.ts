import type { ResolvedRef } from "../shared/contracts";
import { adoToken, githubToken } from "./tokens";

const REQUEST_TIMEOUT_MS = 10_000;

export function notFound(kind: ResolvedRef["kind"], number: number): ResolvedRef {
  return { kind, number, found: false, title: null, url: null, state: null, itemType: null, iconUrl: null, stateColor: null };
}

async function request(url: string, token: { get(): Promise<string>; invalidate(): void }, headers: Record<string, string>) {
  const authorization = await token.get();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { ...headers, Authorization: authorization }, signal: controller.signal });
    if (response.status === 401) token.invalidate();
    return response;
  } finally {
    clearTimeout(timer);
  }
}

interface GithubIssue {
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  pull_request?: { merged_at: string | null };
}

/** Reads an issue or pull request; GitHub numbers them together, and the issues endpoint returns both. */
export async function fetchGithub(repo: string, number: number): Promise<ResolvedRef> {
  const response = await request(`https://api.github.com/repos/${repo}/issues/${number}`, githubToken, {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "paseo-work-refs",
  });
  if (response.status === 404 || response.status === 410) return notFound("github", number);
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${repo}#${number}`);
  const issue = (await response.json()) as GithubIssue;
  const pull = issue.pull_request;
  const state = pull?.merged_at ? "merged" : issue.state === "open" && issue.draft ? "draft" : issue.state;
  return {
    kind: "github",
    number,
    found: true,
    title: issue.title.split("\n")[0].trim(),
    url: issue.html_url,
    state,
    itemType: pull ? "pull" : "issue",
    iconUrl: null,
    stateColor: null,
  };
}

const TYPE_TTL_MS = 60 * 60_000;
const TYPE_FAILURE_TTL_MS = 5 * 60_000;
const MAX_ICON_BYTES = 32 * 1024;

interface AdoType {
  /** The type's icon in its color, as a data URL, or null when it couldn't be read. */
  iconUrl: string | null;
  /** State name (lowercased) to "#rrggbb". */
  stateColors: Map<string, string>;
}

const NO_TYPE: AdoType = { iconUrl: null, stateColors: new Map() };
const typeCache = new Map<string, { value: Promise<AdoType>; expiresAt: number }>();

export function clearTypeCache() {
  typeCache.clear();
}

const hexColor = (value: unknown) => (typeof value === "string" && /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : null);

/**
 * An icon from Azure DevOps goes into the chip as an image, where scripts never run; still, accept only a plain SVG
 * document so nothing unexpected is embedded.
 */
function safeSvg(body: string) {
  const svg = body.trim();
  if (svg.length > MAX_ICON_BYTES || !/^<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) return null;
  if (/<script|<foreignObject|\son\w+\s*=|(?:href|src)\s*=\s*["'](?!#)/i.test(svg)) return null;
  return svg;
}

async function loadAdoType(organization: string, project: string, type: string): Promise<AdoType> {
  const org = encodeURIComponent(organization);
  const response = await request(
    `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}?api-version=7.1`,
    adoToken,
    { Accept: "application/json" },
  );
  if (!response.ok) throw new Error(`Azure DevOps returned ${response.status} for work item type ${type}`);
  const body = (await response.json()) as {
    color?: string;
    icon?: { id?: string };
    states?: { name?: string; color?: string }[];
  };
  const stateColors = new Map<string, string>();
  for (const state of body.states ?? []) {
    const color = hexColor(state.color);
    if (state.name && color) stateColors.set(state.name.toLowerCase(), color);
  }
  let iconUrl: string | null = null;
  const color = hexColor(body.color);
  if (body.icon?.id && /^[\w-]+$/.test(body.icon.id)) {
    const query = `${color ? `color=${color.slice(1)}&` : ""}v=2&api-version=7.1-preview.1`;
    const icon = await request(`https://dev.azure.com/${org}/_apis/wit/workItemIcons/${body.icon.id}?${query}`, adoToken, {
      Accept: "image/svg+xml",
    });
    const svg = icon.ok ? safeSvg(await icon.text()) : null;
    if (svg) iconUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }
  return { iconUrl, stateColors };
}

/** A work item type's icon and state colors, cached for an hour; a failure means the chip uses its fallback icon. */
function adoType(organization: string, project: string, type: string): Promise<AdoType> {
  const key = `${organization}|${project}|${type}`.toLowerCase();
  const hit = typeCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const entry = { value: Promise.resolve(NO_TYPE), expiresAt: Number.POSITIVE_INFINITY };
  entry.value = loadAdoType(organization, project, type).then(
    (value) => {
      entry.expiresAt = Date.now() + TYPE_TTL_MS;
      return value;
    },
    (error) => {
      console.warn(`[work-refs] ${error instanceof Error ? error.message : String(error)}`);
      entry.expiresAt = Date.now() + TYPE_FAILURE_TTL_MS;
      return NO_TYPE;
    },
  );
  typeCache.set(key, entry);
  return entry.value;
}

interface AdoWorkItem {
  id: number;
  fields: Record<string, string | undefined>;
}

/** Reads work items in one request; items that don't exist or can't be read come back as not found. */
export async function fetchAdo(organization: string, project: string, numbers: readonly number[]): Promise<ResolvedRef[]> {
  const org = encodeURIComponent(organization);
  const scope = project ? `${org}/${encodeURIComponent(project)}` : org;
  const fields = ["System.Title", "System.State", "System.WorkItemType", "System.TeamProject"].join(",");
  const url = `https://dev.azure.com/${scope}/_apis/wit/workitems?ids=${numbers.join(",")}&fields=${fields}&errorPolicy=omit&api-version=7.1`;
  const response = await request(url, adoToken, { Accept: "application/json" });
  if (response.status === 404) return numbers.map((number) => notFound("ado", number));
  if (!response.ok) throw new Error(`Azure DevOps returned ${response.status} for ${organization}`);
  const body = (await response.json()) as { value: (AdoWorkItem | null)[] };
  const byId = new Map(body.value.filter((item): item is AdoWorkItem => item !== null).map((item) => [item.id, item]));
  const types = new Map<string, Promise<AdoType>>();
  for (const item of byId.values()) {
    const itemProject = item.fields["System.TeamProject"] || project;
    const type = item.fields["System.WorkItemType"];
    if (itemProject && type) types.set(`${itemProject}|${type}`, adoType(organization, itemProject, type));
  }
  return Promise.all(
    numbers.map(async (number) => {
      const item = byId.get(number);
      if (!item) return notFound("ado", number);
      const itemProject = item.fields["System.TeamProject"] || project;
      const type = item.fields["System.WorkItemType"] ?? null;
      const state = item.fields["System.State"] ?? null;
      const typeInfo = (type && types.get(`${itemProject}|${type}`)) || Promise.resolve(NO_TYPE);
      const { iconUrl, stateColors } = await typeInfo;
      const link = itemProject
        ? `https://dev.azure.com/${org}/${encodeURIComponent(itemProject)}/_workitems/edit/${number}`
        : `https://dev.azure.com/${org}/_workitems/edit/${number}`;
      return {
        kind: "ado" as const,
        number,
        found: true,
        title: item.fields["System.Title"] ?? null,
        url: link,
        state,
        itemType: type,
        iconUrl,
        stateColor: (state && stateColors.get(state.toLowerCase())) ?? null,
      };
    }),
  );
}
