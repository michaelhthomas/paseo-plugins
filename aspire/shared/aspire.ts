import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ansiSegmentSchema } from "./ansi";

export const appHostSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  language: z.enum(["csharp", "single-file", "typescript"]),
  source: z.enum(["config", "scan"]),
});

export const aspireStatusSchema = z.object({
  state: z.enum(["idle", "starting", "running", "stopping"]),
  appHostPath: z.string().nullable(),
  dashboardUrl: z.string().nullable(),
  pid: z.number().nullable(),
  error: z.string().nullable(),
  logFilePath: z.string().nullable(),
});

export const aspireResourceSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  type: z.string(),
  state: z.string().nullable(),
  health: z.string().nullable(),
  exitCode: z.number().nullable(),
  urls: z.array(z.object({ name: z.string(), url: z.string() })),
  dashboardUrl: z.string().nullable(),
  /**
   * The lifecycle commands the resource currently offers, as the dashboard decides them: a running resource offers
   * `stop`, a stopped or finished one `start`, and some offer neither. A listed command may be temporarily disabled.
   */
  commands: z.object({
    start: z.object({ enabled: z.boolean() }).optional(),
    stop: z.object({ enabled: z.boolean() }).optional(),
  }),
});

export const resourceCommandSchema = z.enum(["start", "stop"]);
export type ResourceCommand = z.infer<typeof resourceCommandSchema>;

export const aspireResourcesSchema = z.object({
  resources: z.array(aspireResourceSchema),
  error: z.string().nullable(),
});

export type AppHost = z.infer<typeof appHostSchema>;
export type AspireStatus = z.infer<typeof aspireStatusSchema>;
export type AspireResource = z.infer<typeof aspireResourceSchema>;
export type AspireResources = z.infer<typeof aspireResourcesSchema>;

const workspaceInput = z.object({ workspaceId: z.string() });

export const detectAspireRpc = defineRpc({
  name: "aspire.detect",
  input: workspaceInput,
  output: z.object({
    appHosts: z.array(appHostSchema),
    selected: z.string().nullable(),
    cliAvailable: z.boolean(),
  }),
});

export const selectAppHostRpc = defineRpc({
  name: "aspire.select",
  input: z.object({ workspaceId: z.string(), path: z.string() }),
  output: aspireStatusSchema,
});

export const aspireStatusRpc = defineRpc({
  name: "aspire.status",
  input: workspaceInput,
  output: aspireStatusSchema,
});

export const startAspireRpc = defineRpc({
  name: "aspire.start",
  input: workspaceInput,
  output: aspireStatusSchema,
});

export const stopAspireRpc = defineRpc({
  name: "aspire.stop",
  input: workspaceInput,
  output: aspireStatusSchema,
});

export const restartAspireRpc = defineRpc({
  name: "aspire.restart",
  input: workspaceInput,
  output: aspireStatusSchema,
});

export const aspireResourcesRpc = defineRpc({
  name: "aspire.resources",
  input: workspaceInput,
  output: aspireResourcesSchema,
});

export const resourceCommandRpc = defineRpc({
  name: "aspire.resource-command",
  input: z.object({
    workspaceId: z.string(),
    /** Resource `name` from `aspire.resources`. */
    resource: z.string(),
    command: resourceCommandSchema,
  }),
  output: z.object({ ok: z.literal(true) }),
});

export const logLineSchema = z.object({
  seq: z.number(),
  resource: z.string(),
  timestamp: z.string().nullable(),
  /** Plain text with escapes removed, for filtering and copying. */
  text: z.string(),
  /** The same text split into ANSI-styled runs, as the resource wrote it. */
  segments: z.array(ansiSegmentSchema),
  stderr: z.boolean(),
});

export const aspireLogsSchema = z.object({
  running: z.boolean(),
  /** True while the server is still collecting the initial backlog; no lines are returned until it's complete. */
  loading: z.boolean(),
  /** Changes whenever the server restarts its log stream; clients must drop what they have and re-read from 0. */
  generation: z.number(),
  lines: z.array(logLineSchema),
  /** Pass back as `after` on the next call. */
  cursor: z.number(),
  error: z.string().nullable(),
});

export type LogLine = z.infer<typeof logLineSchema>;
export type AspireLogs = z.infer<typeof aspireLogsSchema>;

export const aspireLogsRpc = defineRpc({
  name: "aspire.logs",
  /** Every resource's output in one stream; clients filter it per resource. */
  input: z.object({
    workspaceId: z.string(),
    generation: z.number().nullable(),
    after: z.number(),
  }),
  output: aspireLogsSchema,
});

export const IDLE_STATUS: AspireStatus = {
  state: "idle",
  appHostPath: null,
  dashboardUrl: null,
  pid: null,
  error: null,
  logFilePath: null,
};
