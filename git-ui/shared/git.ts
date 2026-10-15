import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const sideSchema = z.enum(["unstaged", "staged"]);
export type Side = z.infer<typeof sideSchema>;

/**
 * Which diff of a file: staged (HEAD to index), unstaged (index to working tree), or combined (HEAD to working tree,
 * each changed line marked with the side it's on).
 */
export const diffSideSchema = z.enum(["unstaged", "staged", "combined"]);
export type DiffSide = z.infer<typeof diffSideSchema>;

export const entryKindSchema = z.enum(["modified", "added", "deleted", "renamed", "copied", "typechange", "untracked", "conflict"]);
export type EntryKind = z.infer<typeof entryKindSchema>;

export const statusEntrySchema = z.object({
  path: z.string(),
  /** The path before a rename or copy. */
  origPath: z.string().nullable(),
  kind: entryKindSchema,
  /** Changes whenever this file's diff might have changed. */
  stamp: z.string(),
  /** Changed line counts; null for binary files or when unknown. */
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
});
export type StatusEntry = z.infer<typeof statusEntrySchema>;

export const statusSchema = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  detached: z.boolean(),
  ahead: z.number(),
  behind: z.number(),
  staged: z.array(statusEntrySchema),
  /** Tracked changes and untracked files. */
  unstaged: z.array(statusEntrySchema),
  conflicted: z.array(statusEntrySchema),
  revision: z.string(),
});
export type GitStatus = z.infer<typeof statusSchema>;

/** `[text, role]`, where role is a `@getpaseo/highlight` style such as "keyword", or null for plain text. */
export const tokenSchema = z.tuple([z.string(), z.string().nullable()]);
export type Token = z.infer<typeof tokenSchema>;

export const diffLineSchema = z.object({
  type: z.enum(["context", "add", "remove"]),
  content: z.string(),
  oldNo: z.number().nullable(),
  newNo: z.number().nullable(),
  /** Followed by git's "\ No newline at end of file". */
  noNewline: z.boolean(),
  tokens: z.array(tokenSchema).nullable(),
  /** Whether a changed line is staged or not; null for context. */
  origin: sideSchema.nullable(),
});
export type DiffLine = z.infer<typeof diffLineSchema>;

export const hunkSchema = z.object({
  oldStart: z.number(),
  oldCount: z.number(),
  newStart: z.number(),
  newCount: z.number(),
  header: z.string(),
  /** Identifies the hunk by its lines, not its position, so staging one hunk doesn't invalidate the others. */
  hash: z.string(),
  lines: z.array(diffLineSchema),
});
export type Hunk = z.infer<typeof hunkSchema>;

export const fileDiffSchema = z.object({
  path: z.string(),
  side: diffSideSchema,
  oldPath: z.string().nullable(),
  /** The status entry stamp this diff was computed for. */
  stamp: z.string(),
  status: z.enum(["ok", "binary", "too_large", "unsupported", "empty", "error"]),
  /** Why the diff couldn't be read, for `error`, or why it's `empty` when that isn't obvious. */
  message: z.string().nullable(),
  isNew: z.boolean(),
  isDeleted: z.boolean(),
  /**
   * Hunk operations are allowed. False for untracked files, submodules, output that isn't valid UTF-8 and diffs that
   * ignore whitespace.
   */
  patchable: z.boolean(),
  fingerprint: z.string(),
  /**
   * Identifies the new side's content (working tree, or index for staged diffs); "" when it wasn't read. Revealed
   * context lines stay valid while it doesn't change.
   */
  newSideHash: z.string(),
  additions: z.number(),
  deletions: z.number(),
  hunks: z.array(hunkSchema),
  /** Line count of the new side, for expanding context below the last hunk. */
  newLineCount: z.number(),
});
export type FileDiff = z.infer<typeof fileDiffSchema>;

export const contextLineSchema = z.object({ content: z.string(), tokens: z.array(tokenSchema).nullable() });
export type ContextLine = z.infer<typeof contextLineSchema>;

const workspace = { workspaceId: z.string() };

export const statusRpc = defineRpc({
  name: "git.status",
  input: z.object(workspace),
  output: statusSchema,
});

export const diffRpc = defineRpc({
  name: "git.diff",
  input: z.object({
    ...workspace,
    /** `git diff -w`: whitespace-only changes don't show, and hunks can't be staged. */
    ignoreWhitespace: z.boolean().optional(),
    files: z
      .array(
        z.object({
          path: z.string(),
          side: diffSideSchema,
          /** The path before a staged rename. */
          origPath: z.string().nullable(),
          untracked: z.boolean(),
          stamp: z.string(),
          /** Load a diff that would otherwise be `too_large`. */
          force: z.boolean().optional(),
        }),
      )
      .max(50),
  }),
  output: z.object({ files: z.array(fileDiffSchema) }),
});

export const linesRpc = defineRpc({
  name: "git.lines",
  input: z.object({ ...workspace, path: z.string(), side: diffSideSchema, start: z.number().int().min(1), end: z.number().int().min(1) }),
  output: z.object({ start: z.number(), lines: z.array(contextLineSchema) }),
});

const mutationResultSchema = z.object({
  ok: z.boolean(),
  /** "stale": the file changed since the client's diff was computed. */
  reason: z.enum(["stale", "error"]).nullable(),
  message: z.string().nullable(),
});
export type MutationResult = z.infer<typeof mutationResultSchema>;

export const changedLineSchema = z.object({
  type: z.enum(["add", "remove"]),
  /** The line's number in the diff it was shown in: old side for removals, new side for additions. */
  no: z.number().int().min(1),
  content: z.string(),
});
export type ChangedLine = z.infer<typeof changedLineSchema>;

/**
 * Stages, unstages or restores some changed lines of a file. The daemon finds them in the file's current staged
 * (`origin` staged) or unstaged diff and refuses with `stale` unless every one is still there, unchanged.
 */
export const changeRpc = defineRpc({
  name: "git.change",
  input: z.object({
    ...workspace,
    path: z.string(),
    /** The path before a staged rename. */
    origPath: z.string().nullable(),
    /** The diff the lines were shown in, which their numbers refer to. */
    view: diffSideSchema,
    origin: sideSchema,
    action: z.enum(["stage", "unstage", "discard"]),
    lines: z.array(changedLineSchema).min(1).max(20_000),
  }),
  output: mutationResultSchema,
});

export const filesRpc = defineRpc({
  name: "git.files",
  input: z.object({
    ...workspace,
    paths: z.array(z.string()).min(1),
    action: z.enum(["stage", "unstage", "discard", "resolve"]),
  }),
  output: mutationResultSchema,
});

export const commitRpc = defineRpc({
  name: "git.commit",
  input: z.object({
    ...workspace,
    message: z.string().min(1),
    /** Amend the last commit instead of creating one. */
    amend: z.boolean(),
    /** Stage every change, untracked files included, before committing. */
    all: z.boolean(),
  }),
  output: z.object({ ok: z.boolean(), sha: z.string().nullable(), message: z.string().nullable() }),
});

export const lastCommitMessageRpc = defineRpc({
  name: "git.last-commit-message",
  input: z.object(workspace),
  output: z.object({ message: z.string().nullable() }),
});

export const syntaxColorsRpc = defineRpc({
  name: "git.syntax-colors",
  input: z.object({ theme: z.string() }),
  output: z.object({ light: z.record(z.string(), z.string()), dark: z.record(z.string(), z.string()) }),
});

/** Mirrors `SYNTAX_THEME_OPTIONS` in `@getpaseo/highlight`, which client code can't import. */
export const SYNTAX_THEMES = [
  { id: "github", label: "GitHub" },
  { id: "catppuccin", label: "Catppuccin" },
  { id: "dracula", label: "Dracula" },
  { id: "tokyo-night", label: "Tokyo Night" },
  { id: "one", label: "One" },
  { id: "nord", label: "Nord" },
  { id: "gruvbox", label: "Gruvbox" },
  { id: "solarized", label: "Solarized" },
] as const;

/** Paseo's default syntax theme. */
export const DEFAULT_SYNTAX_THEME = "one";
export const MATCH_PASEO = "match";

export const displaySettings = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({
    syntaxTheme: z.string().default(MATCH_PASEO),
    /** Changes panel layout. */
    changesView: z.enum(["tree", "list"]).default("tree"),
    changesGroupBy: z.enum(["none", "tracked", "staged"]).default("tracked"),
    /** Diff panel options, matching Paseo's own diff. */
    diffLayout: z.enum(["unified", "split"]).default("unified"),
    hideWhitespace: z.boolean().default(false),
    wrapLines: z.boolean().default(true),
    /** Hide the unchanged lines between hunks behind expanders; off shows whole files. */
    collapseUnchanged: z.boolean().default(true),
  }),
});

export function fileKey(side: DiffSide, path: string) {
  return `${side}:${path}`;
}
