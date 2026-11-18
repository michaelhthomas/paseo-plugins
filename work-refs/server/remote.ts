import type { ProjectConfig } from "../shared/contracts";

const GITHUB_REMOTE = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;
const ADO_HTTPS = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\//i;
const ADO_SSH = /ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\//i;
const VSTS_HTTPS = /\/\/(?:[^@/]+@)?([\w-]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\//i;
const VSTS_SSH = /vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\//i;

function decode(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** What a git remote URL says about the project's GitHub repo or Azure DevOps organization and project. */
export function parseRemote(url: string): ProjectConfig {
  const config: ProjectConfig = { githubRepo: "", adoOrganization: "", adoProject: "" };
  const trimmed = url.trim();
  const github = GITHUB_REMOTE.exec(trimmed);
  if (github) config.githubRepo = `${github[1]}/${github[2]}`;
  const ado = ADO_HTTPS.exec(trimmed) ?? ADO_SSH.exec(trimmed) ?? VSTS_HTTPS.exec(trimmed) ?? VSTS_SSH.exec(trimmed);
  if (ado) {
    config.adoOrganization = decode(ado[1]);
    config.adoProject = decode(ado[2]);
  }
  return config;
}

/**
 * Accepts "contoso", "https://dev.azure.com/contoso", or "https://contoso.visualstudio.com" and returns "contoso",
 * or null when the value isn't a usable organization name.
 */
export function normalizeOrganization(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const devAzure = /dev\.azure\.com\/([^/]+)/i.exec(trimmed);
  const vsts = /^(?:https?:\/\/)?([\w-]+)\.visualstudio\.com/i.exec(trimmed);
  const name = devAzure ? decode(devAzure[1]) : vsts ? vsts[1] : trimmed;
  return /^[\w.-]+$/.test(name) ? name : null;
}

/** Accepts "owner/repo" or a GitHub URL and returns "owner/repo", or null. */
export function normalizeRepo(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const fromUrl = GITHUB_REMOTE.exec(trimmed);
  const repo = fromUrl ? `${fromUrl[1]}/${fromUrl[2]}` : trimmed;
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

/** Each field from `configured` when set, otherwise from `detected`. */
export function mergeConfig(configured: ProjectConfig | undefined, detected: ProjectConfig): ProjectConfig {
  return {
    githubRepo: configured?.githubRepo.trim() || detected.githubRepo,
    adoOrganization: configured?.adoOrganization.trim() || detected.adoOrganization,
    adoProject: configured?.adoProject.trim() || detected.adoProject,
  };
}
