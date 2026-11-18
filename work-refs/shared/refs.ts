/** A reference to a GitHub issue or pull request (`#123`) or an Azure Boards work item (`AB#123`). */
export type RefKind = "github" | "ado";

export interface WorkRef {
  kind: RefKind;
  number: number;
}

export interface RefMatch extends WorkRef {
  /** Offset of the match in the source text. */
  start: number;
  /** Offset just past the match. */
  end: number;
  /** The matched text, e.g. "AB#123". */
  text: string;
}

/**
 * Spans that never contain references: fenced code blocks, inline code, Markdown links and images, autolinks and bare
 * URLs. Fences are matched up to the closing fence or the end of the text, so an unterminated fence protects the rest.
 */
const PROTECTED = new RegExp(
  [
    // Strings, because TypeScript checks each regex literal's backreferences on its own.
    "(^|\\n)[ \\t]*(`{3,}|~{3,})[^\\n]*(?:\\n[\\s\\S]*?\\n[ \\t]*\\2[^\\n]*(?=\\n|$)|[\\s\\S]*$)",
    "(`+)[\\s\\S]*?\\3",
    /!?\[[^\]\n]*\]\([^)\n]*\)/.source,
    /<[a-z][a-z0-9+.-]*:[^>\s]*>/.source,
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]+/.source,
  ].join("|"),
  "gi",
);

/**
 * `#123` or `AB#123`, not preceded by a word character, `&` (an HTML entity), `#`, or `/` (a URL fragment), and not
 * followed by a word character. Up to 9 digits, so a number never exceeds 32 bits.
 */
const REF = /(?<![\w&#/])(AB)?#(\d{1,9})(?!\w)/gi;

/** Calls `visit` for each run of text outside protected spans, with its offset. */
function forEachUnprotected(text: string, visit: (segment: string, offset: number) => void) {
  let last = 0;
  for (const match of text.matchAll(PROTECTED)) {
    const start = match.index!;
    if (start > last) visit(text.slice(last, start), last);
    last = start + match[0].length;
  }
  if (last < text.length) visit(text.slice(last), last);
}

/** Finds every reference in Markdown text, in order, ignoring code and links. */
export function findRefs(text: string): RefMatch[] {
  const matches: RefMatch[] = [];
  forEachUnprotected(text, (segment, offset) => {
    for (const match of segment.matchAll(REF)) {
      const number = Number(match[2]);
      if (number <= 0) continue;
      const start = offset + match.index!;
      matches.push({ kind: match[1] ? "ado" : "github", number, start, end: start + match[0].length, text: match[0] });
    }
  });
  return matches;
}

/** Whether the text contains at least one reference. Cheap enough to run on every timeline item. */
export function hasRefs(text: string): boolean {
  if (!text.includes("#")) return false;
  return findRefs(text).length > 0;
}

export function refKey(ref: WorkRef): string {
  return `${ref.kind}:${ref.number}`;
}

/** Each distinct reference once, in order of first appearance. */
export function uniqueRefs(matches: readonly WorkRef[]): WorkRef[] {
  const seen = new Set<string>();
  const result: WorkRef[] = [];
  for (const { kind, number } of matches) {
    const key = refKey({ kind, number });
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind, number });
  }
  return result;
}

/** Replaces each reference `replace` returns Markdown for. Others are left as written. */
export function replaceRefs(text: string, replace: (ref: RefMatch) => string | null): string {
  let result = "";
  let last = 0;
  for (const match of findRefs(text)) {
    const replacement = replace(match);
    if (replacement === null) continue;
    result += text.slice(last, match.start) + replacement;
    last = match.end;
  }
  return result + text.slice(last);
}

/** Turns each reference `urlFor` knows into a Markdown link. Others are left as written. */
export function linkifyRefs(text: string, urlFor: (ref: WorkRef) => string | null): string {
  return replaceRefs(text, (match) => {
    const url = urlFor(match);
    return url ? `[${match.text}](<${url}>)` : null;
  });
}
