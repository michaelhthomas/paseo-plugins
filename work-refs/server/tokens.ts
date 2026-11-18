import { run } from "./exec";

/** Azure DevOps' resource ID for Entra tokens. */
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const GITHUB_TOKEN_TTL_MS = 30 * 60_000;
const EARLY_EXPIRY_MS = 5 * 60_000;
const FAILURE_RETRY_MS = 60_000;

interface CachedToken {
  header: string;
  expiresAt: number;
}

function cachedTokenSource(fetchToken: () => Promise<CachedToken>) {
  let current: CachedToken | null = null;
  let pending: Promise<CachedToken> | null = null;
  let failedAt = 0;
  let failure: Error | null = null;
  return {
    async get(): Promise<string> {
      if (current && current.expiresAt > Date.now()) return current.header;
      // Don't start the CLI on every lookup while it's failing (signed out, not installed).
      if (failure && Date.now() - failedAt < FAILURE_RETRY_MS) throw failure;
      pending ??= fetchToken().finally(() => (pending = null));
      try {
        current = await pending;
        failure = null;
        return current.header;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        failedAt = Date.now();
        throw failure;
      }
    },
    /** Forget the token after the service rejects it. */
    invalidate() {
      current = null;
    },
  };
}

/** `GH_TOKEN` or `GITHUB_TOKEN`, otherwise the GitHub CLI's token. */
export const githubToken = cachedTokenSource(async () => {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const token = fromEnv || (await run("gh", ["auth", "token", "--hostname", "github.com"])).trim();
  if (!token) throw new Error("No GitHub token. Run `gh auth login` on the host.");
  return { header: `Bearer ${token}`, expiresAt: Date.now() + GITHUB_TOKEN_TTL_MS };
});

/** `AZURE_DEVOPS_EXT_PAT` (a personal access token), otherwise an Entra token from the Azure CLI. */
export const adoToken = cachedTokenSource(async () => {
  const pat = process.env.AZURE_DEVOPS_EXT_PAT;
  if (pat) return { header: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`, expiresAt: Number.POSITIVE_INFINITY };
  const output = await run("az", ["account", "get-access-token", "--resource", ADO_RESOURCE, "-o", "json"], {
    shell: process.platform === "win32",
    timeoutMs: 30_000,
  });
  const parsed = JSON.parse(output) as { accessToken?: string; expires_on?: number; expiresOn?: string };
  if (!parsed.accessToken) throw new Error("The Azure CLI returned no token. Run `az login` on the host.");
  const expiresAt = parsed.expires_on ? parsed.expires_on * 1000 : parsed.expiresOn ? Date.parse(parsed.expiresOn) : Date.now() + 30 * 60_000;
  return { header: `Bearer ${parsed.accessToken}`, expiresAt: expiresAt - EARLY_EXPIRY_MS };
});
