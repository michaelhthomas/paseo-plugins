/**
 * Parses one file's `git diff` output, keeping the raw text of the header and of each hunk so a single hunk can be
 * fed back to `git apply` byte for byte. Line endings (including CRLF) and "\ No newline at end of file" markers
 * survive untouched in the raw slices; only the display `content` drops them.
 */

export type ParsedLine = {
  type: "context" | "add" | "remove";
  content: string;
  oldNo: number | null;
  newNo: number | null;
  noNewline: boolean;
};

export type ParsedHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: ParsedLine[];
  /** The `@@` line through the hunk's last line, terminators included. */
  raw: string;
  /** Each line's raw text, aligned with `lines`, with any " No newline" marker after it included. */
  rawLines: string[];
};

export type ParsedFileDiff = {
  /** Everything before the first hunk: `diff --git`, mode, rename and index lines, `---` and `+++`. */
  rawHeader: string;
  headerLines: string[];
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  isRename: boolean;
  /** Mode 160000 on either side. */
  isSubmodule: boolean;
  hunks: ParsedHunk[];
  additions: number;
  deletions: number;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Splits text into lines that keep their terminators. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    if (end < 0) {
      lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, end + 1));
    start = end + 1;
  }
  return lines;
}

function stripTerminator(line: string) {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  if (line.endsWith("\n")) return line.slice(0, -1);
  return line;
}

/** Returns null for empty output (no changes). Only the first file section is parsed. */
export function parseFileDiff(raw: string): ParsedFileDiff | null {
  if (!raw.trim()) return null;
  const lines = splitLines(raw);
  let i = 0;
  const headerLines: string[] = [];
  let rawHeader = "";
  while (i < lines.length && !lines[i].startsWith("@@")) {
    // A second file section ends this one.
    if (headerLines.length > 0 && lines[i].startsWith("diff --git ")) break;
    headerLines.push(stripTerminator(lines[i]));
    rawHeader += lines[i];
    i++;
  }
  const has = (pattern: RegExp) => headerLines.some((line) => pattern.test(line));
  const diff: ParsedFileDiff = {
    rawHeader,
    headerLines,
    isNew: has(/^new file mode /) || has(/^--- \/dev\/null$/),
    isDeleted: has(/^deleted file mode /) || has(/^\+\+\+ \/dev\/null$/),
    isBinary: has(/^Binary files .* differ$/) || has(/^GIT binary patch$/),
    isRename: has(/^rename (from|to) /) || has(/^copy (from|to) /),
    isSubmodule: has(/^(new file |deleted file |old |new )?mode 160000$/) || has(/^index \S+ 160000$/),
    hunks: [],
    additions: 0,
    deletions: 0,
  };

  while (i < lines.length) {
    const match = HUNK_HEADER.exec(lines[i]);
    if (!match) break;
    const hunk: ParsedHunk = {
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
      header: stripTerminator(lines[i]),
      lines: [],
      raw: lines[i],
      rawLines: [],
    };
    i++;
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    let oldLeft = hunk.oldCount;
    let newLeft = hunk.newCount;
    // Consume exactly the lines the header counts, plus any "\ No newline" markers among or right after them.
    while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i].startsWith("\\"))) {
      const line = lines[i];
      hunk.raw += line;
      i++;
      const marker = line[0];
      const content = stripTerminator(line).slice(1);
      if (marker === "\\") {
        const previous = hunk.lines.at(-1);
        if (previous) previous.noNewline = true;
        if (hunk.rawLines.length) hunk.rawLines[hunk.rawLines.length - 1] += line;
        continue;
      }
      hunk.rawLines.push(line);
      if (marker === "+") {
        hunk.lines.push({ type: "add", content, oldNo: null, newNo: newNo++, noNewline: false });
        newLeft--;
        diff.additions++;
      } else if (marker === "-") {
        hunk.lines.push({ type: "remove", content, oldNo: oldNo++, newNo: null, noNewline: false });
        oldLeft--;
        diff.deletions++;
      } else {
        // " " context, or an empty line when diff.suppressBlankEmpty is set.
        hunk.lines.push({ type: "context", content: marker === " " ? content : "", oldNo: oldNo++, newNo: newNo++, noNewline: false });
        oldLeft--;
        newLeft--;
      }
    }
    diff.hunks.push(hunk);
  }
  return diff;
}

/**
 * A patch containing only hunk `index`, for `git apply`. For modified files the header is reduced to the new path
 * on both sides, so applying a hunk of a renamed or mode-changed file touches only that hunk's content.
 */
export function buildHunkPatch(diff: ParsedFileDiff, index: number): string {
  const hunk = diff.hunks[index];
  if (!hunk) throw new Error(`No hunk ${index}`);
  const header = diff.isNew || diff.isDeleted ? diff.rawHeader : contentOnlyHeader(diff);
  return header + hunk.raw;
}

/** The hunk with only `selected` (indices into its lines) changed; see `buildSelectionPatch`. */
function partialHunk(hunk: ParsedHunk, selected: ReadonlySet<number>, reverse: boolean) {
  const changed = hunk.lines.flatMap((line, i) => (line.type === "context" ? [] : [i]));
  if (changed.every((i) => selected.has(i))) return hunk.raw;
  const kept = reverse ? "add" : "remove";
  let body = "";
  hunk.lines.forEach((line, i) => {
    const raw = hunk.rawLines[i];
    if (line.type === "context" || selected.has(i)) body += raw;
    else if (line.type === kept) body += ` ${raw.slice(1)}`;
  });
  return hunk.raw.slice(0, hunk.raw.indexOf("\n") + 1) + body;
}

/**
 * A patch applying only some changed lines: `selection` maps hunk indices to indices into their lines. The other
 * changes are left as they are: for a forward patch (stage) an unselected removal stays as context and an unselected
 * addition is left out; for a patch applied with `--reverse` (unstage, restore) it's the other way round. Apply with
 * `--recount`: hunk headers keep their original counts.
 */
export function buildSelectionPatch(diff: ParsedFileDiff, selection: ReadonlyMap<number, ReadonlySet<number>>, reverse: boolean): string {
  const header = diff.isNew || diff.isDeleted ? diff.rawHeader : contentOnlyHeader(diff);
  let patch = header;
  for (const index of [...selection.keys()].sort((a, b) => a - b)) {
    const hunk = diff.hunks[index];
    if (!hunk) throw new Error(`No hunk ${index}`);
    patch += partialHunk(hunk, selection.get(index)!, reverse);
  }
  return patch;
}

/**
 * Where line `n` of one side of a diff (`from`) is on the other side, or null if the diff changes it. Lines
 * outside hunks shift by the lines added and removed before them.
 */
export function mapLine(diff: ParsedFileDiff | null, n: number, from: "old" | "new"): number | null {
  if (!diff) return n;
  // The first line after a hunk; a zero-count hunk's start is the line before it.
  const next = (start: number, count: number) => (count === 0 ? start + 1 : start + count);
  let offset = 0;
  for (const hunk of diff.hunks) {
    const [fromStart, fromCount, toStart, toCount] =
      from === "old" ? [hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount] : [hunk.newStart, hunk.newCount, hunk.oldStart, hunk.oldCount];
    if (n < (fromCount === 0 ? fromStart + 1 : fromStart)) return n + offset;
    const line = hunk.lines.find((candidate) => (from === "old" ? candidate.oldNo : candidate.newNo) === n);
    if (line) return line.type === "context" ? (from === "old" ? line.newNo : line.oldNo) : null;
    offset = next(toStart, toCount) - next(fromStart, fromCount);
  }
  return n + offset;
}

function contentOnlyHeader(diff: ParsedFileDiff): string {
  const plus = diff.headerLines.find((line) => line.startsWith("+++ "));
  if (!plus) throw new Error("Diff has no +++ line");
  // `+++ b/path` or, when git quotes the name, `+++ "b/path"`. Any trailing tab stays as git wrote it.
  const target = plus.slice(4);
  const quoted = target.startsWith('"');
  const name = quoted ? target.slice(3) : target.slice(2);
  const a = quoted ? `"a/${name}` : `a/${name}`;
  const b = quoted ? `"b/${name}` : `b/${name}`;
  return `diff --git ${a.trimEnd()} ${b.trimEnd()}\n--- ${a}\n+++ ${b}\n`;
}

/** Number of lines in file content, counting a final line without a newline. */
export function countLines(content: string): number {
  if (!content) return 0;
  let count = 0;
  for (let i = content.indexOf("\n"); i >= 0; i = content.indexOf("\n", i + 1)) count++;
  return content.endsWith("\n") ? count : count + 1;
}

/** File content as display lines, without terminators. */
export function contentLines(content: string): string[] {
  return splitLines(content).map(stripTerminator);
}
