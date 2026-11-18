import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const refKindSchema = z.enum(["github", "ado"]);

export const projectConfigSchema = z.object({
  /** "owner/repo". Empty: detected from the project's `origin` remote. */
  githubRepo: z.string().default(""),
  /** The Azure DevOps organization, e.g. "contoso". Empty: detected from the `origin` remote. */
  adoOrganization: z.string().default(""),
  /** The Azure DevOps project. Empty: detected from the `origin` remote. */
  adoProject: z.string().default(""),
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

/**
 * Paseo settings are host- or device-scoped, so per-project values live in one host document keyed by project ID.
 */
export const projectSettings = defineSettings({
  id: "projects",
  scope: "host",
  version: 1,
  schema: z.object({
    projects: z.record(z.string(), projectConfigSchema).default({}),
  }),
});

export const EMPTY_CONFIG: ProjectConfig = { githubRepo: "", adoOrganization: "", adoProject: "" };

export const resolvedRefSchema = z.object({
  kind: refKindSchema,
  number: z.number().int(),
  /** False when the item doesn't exist, couldn't be read, or the project has no repo or ADO project. */
  found: z.boolean(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  /** GitHub: "open", "closed", "merged" or "draft". ADO: the work item's state, e.g. "Active". */
  state: z.string().nullable(),
  /** GitHub: "pull" or "issue". ADO: the work item type, e.g. "Bug". */
  itemType: z.string().nullable(),
  /** ADO: the work item type's own icon, as an SVG data URL in the type's color. Null for GitHub or when unavailable. */
  iconUrl: z.string().nullable().default(null),
  /** ADO: the state's color from the process, e.g. "#43b4d5". Null for GitHub or when unavailable. */
  stateColor: z.string().nullable().default(null),
});
export type ResolvedRef = z.infer<typeof resolvedRefSchema>;

export const resolveRefsRpc = defineRpc({
  name: "work-refs.resolve",
  input: z.object({
    /** The agent whose reply mentions the references; its workspace's project picks the repo and ADO project. */
    agentId: z.string().min(1),
    refs: z.array(z.object({ kind: refKindSchema, number: z.number().int().positive() })).max(100),
  }),
  output: z.object({ refs: z.array(resolvedRefSchema) }),
});

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  /** What the project's `origin` remote implies, used where a setting is empty. */
  detected: projectConfigSchema,
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const listProjectsRpc = defineRpc({
  name: "work-refs.projects",
  input: z.object({}),
  output: z.object({ projects: z.array(projectSummarySchema) }),
});

/** The timeline item that replaces an assistant message containing references. */
export const MESSAGE_KIND = "work-refs-message";
export const MESSAGE_VERSION = 1;
export const messageDataSchema = z.object({ text: z.string() });
