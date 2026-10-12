import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const STATE_DIR = join(homedir(), ".paseo", "plugin-state", "aspire");
const SELECTION_FILE = join(STATE_DIR, "selection.json");

export function normalizePath(path: string) {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

let selections: Record<string, string> | null = null;

function load() {
  if (selections) return selections;
  try {
    selections = JSON.parse(readFileSync(SELECTION_FILE, "utf8")) as Record<string, string>;
  } catch {
    selections = {};
  }
  return selections;
}

/** The app host the user picked for a workspace directory, if any. */
export function getSelection(directory: string): string | null {
  return load()[normalizePath(directory)] ?? null;
}

export function setSelection(directory: string, appHostPath: string) {
  const all = load();
  all[normalizePath(directory)] = appHostPath;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(SELECTION_FILE, JSON.stringify(all, null, 2));
  } catch (error) {
    console.error("[aspire] failed to save app host selection", error);
  }
}
