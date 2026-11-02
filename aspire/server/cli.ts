import { spawn, type ChildProcess } from "node:child_process";

const BASE_ARGS = ["--nologo", "--non-interactive"];
const MIN_VERSION = [13, 5];
const MAX_OUTPUT = 256 * 1024;
const MAX_BACKOFF_MS = 30_000;

const children = new Set<ChildProcess>();

export type AspireResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function spawnAspire(args: readonly string[], cwd: string | undefined) {
  const child = spawn("aspire", [...args, ...BASE_ARGS], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

function append(buffer: string, chunk: Buffer) {
  const next = buffer + chunk.toString("utf8");
  return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next;
}

export function runAspire(args: readonly string[], { cwd, timeoutMs }: { cwd?: string; timeoutMs: number }) {
  return new Promise<AspireResult>((resolve, reject) => {
    const child = spawnAspire(args, cwd);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr!.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Runs a `--follow` command until disposed, reconnecting with backoff. Each JSON line goes to `onObject`; `onRestart`
 * runs before a reconnect, which replays the command's initial output.
 */
export function followAspire(args: readonly string[], onObject: (value: unknown) => void, onRestart: () => void, cwd?: string) {
  let disposed = false;
  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1_000;

  const connect = () => {
    if (disposed) return;
    const startedAt = Date.now();
    let pending = "";
    child = spawnAspire(args, cwd);
    child.stdout!.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        if (!line.startsWith("{")) continue;
        try {
          onObject(JSON.parse(line));
        } catch {
          console.error(`[aspire] ignoring unparseable line from aspire ${args[0]}`);
        }
      }
    });
    child.stderr!.on("data", () => {});
    const reconnect = (reason: string) => {
      child = null;
      if (disposed) return;
      if (Date.now() - startedAt > 60_000) backoff = 1_000;
      console.error(`[aspire] aspire ${args[0]} --follow ${reason}; reconnecting in ${backoff}ms`);
      onRestart();
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };
    child.once("error", (error) => reconnect(`failed (${error.message})`));
    child.once("close", (code) => reconnect(`exited with code ${code}`));
  };

  connect();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    child?.kill();
  };
}

let cliCheck: Promise<boolean> | null = null;

export function checkCli() {
  cliCheck ??= runAspire(["--version"], { timeoutMs: 30_000 })
    .then(({ code, stdout }) => {
      const match = /(\d+)\.(\d+)/.exec(stdout.split("+")[0]);
      if (code !== 0 || !match) return false;
      const [major, minor] = [Number(match[1]), Number(match[2])];
      const ok = major > MIN_VERSION[0] || (major === MIN_VERSION[0] && minor >= MIN_VERSION[1]);
      if (!ok) console.error(`[aspire] Aspire CLI ${stdout.trim()} is older than ${MIN_VERSION.join(".")}`);
      return ok;
    })
    .catch(() => false)
    .then((ok) => {
      // Let a later call retry, e.g. after the CLI is installed.
      if (!ok) setTimeout(() => (cliCheck = null), 60_000);
      return ok;
    });
  return cliCheck;
}

export function killAll() {
  for (const child of children) child.kill();
  children.clear();
}
