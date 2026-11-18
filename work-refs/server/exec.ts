import { execFile } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /**
   * Run through the shell. Needed on Windows for `.cmd` launchers such as `az`, which Node refuses to start directly.
   * Only pass constant arguments with this set.
   */
  shell?: boolean;
}

/** Runs a command and resolves with its stdout, or rejects with its stderr. */
export function run(command: string, args: readonly string[], { cwd, timeoutMs = 15_000, shell = false }: ExecOptions = {}) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, shell, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
  });
}
