import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { ChipIcon } from "../shared/chip-svg";
import type { ResolvedRef } from "../shared/contracts";

export type Colors = PluginHostProps["theme"]["colors"];

/** GitHub's own colors for issue and pull request states, which read the same in light and dark themes. */
const GITHUB_STATE = { open: "#1f883d", draft: "#8c959f", merged: "#8250df", closed: "#cf222e" } as const;
const CLOSED_ISSUE = "#8250df";

const ADO_TYPE_ICONS: Record<string, ChipIcon> = {
  bug: "Bug",
  task: "ClipboardCheck",
  "user story": "BookOpen",
  "product backlog item": "BookOpen",
  feature: "Trophy",
  epic: "Crown",
  issue: "CircleDot",
  "test case": "FlaskConical",
};

export function chipIcon(ref: ResolvedRef): ChipIcon {
  if (ref.kind === "ado") return ADO_TYPE_ICONS[ref.itemType?.toLowerCase() ?? ""] ?? "SquareKanban";
  if (ref.itemType === "pull") {
    if (ref.state === "merged") return "GitMerge";
    if (ref.state === "closed") return "GitPullRequestClosed";
    if (ref.state === "draft") return "GitPullRequestDraft";
    return "GitPullRequest";
  }
  return ref.state === "closed" ? "CircleCheck" : "CircleDot";
}

/** GitHub's state colors; Azure Boards' state categories by the state names its process templates use. */
export function chipTint(ref: ResolvedRef, colors: Colors) {
  if (ref.kind === "github") {
    if (ref.itemType === "issue" && ref.state === "closed") return CLOSED_ISSUE;
    return GITHUB_STATE[ref.state as keyof typeof GITHUB_STATE] ?? GITHUB_STATE.open;
  }
  const name = ref.state?.toLowerCase() ?? "";
  if (["done", "closed", "resolved", "completed", "removed"].includes(name)) return colors.statusSuccess;
  if (["active", "in progress", "committed", "doing", "open"].includes(name)) return colors.accent;
  return colors.foregroundMuted;
}

export function refLabel(ref: ResolvedRef) {
  return ref.kind === "ado" ? `AB#${ref.number}` : `#${ref.number}`;
}

/** The chip's tooltip: its type and state, which the chip only shows as an icon and color. */
export function describeRef(ref: ResolvedRef) {
  const type = ref.kind === "ado" ? (ref.itemType ?? "Work item") : ref.itemType === "pull" ? "Pull request" : "Issue";
  return `${type} ${refLabel(ref)}: ${ref.title ?? ""}${ref.state ? ` (${ref.state})` : ""}`;
}
