import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangedLine, DiffSide, FileDiff, Hunk, Side } from "../shared/git";
import { applyChange, fileDiff, readLines } from "../server/diff";
import { fileDiffs, readBlobs } from "../server/diff-batch";
import { disposeRepos, openRepo, type Repo } from "../server/git";
import { applyFiles, commitChanges } from "../server/handlers";
import { readStatus } from "../server/status";

let dir: string;
let repo: Repo;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function write(path: string, content: string) {
  writeFileSync(join(dir, path), content);
}

const lines = (count: number, label = "line") => Array.from({ length: count }, (_, i) => `${label} ${i + 1}\n`).join("");

/** A 30-line file with edits at lines 2 and 25, far enough apart to make two hunks. */
const TWO_HUNK_EDIT = (content: string) => content.replace("line 2\n", "line two\n").replace("line 25\n", "line twenty-five\n");

const changedLines = (lines: Hunk["lines"]): ChangedLine[] =>
  lines.flatMap((line) => (line.type === "context" ? [] : [{ type: line.type, no: (line.type === "add" ? line.newNo : line.oldNo)!, content: line.content }]));

/** Applies a hunk's changed lines (or those in `range`) the way the Diff panel does. */
function applyHunk(
  repo: Repo,
  { hunk, range, side, ...rest }: { path: string; origPath: string | null; side: Side; hunk: Hunk; range?: [number, number]; action: "stage" | "unstage" | "discard" },
) {
  const lines = range ? hunk.lines.slice(range[0], range[1] + 1) : hunk.lines;
  return applyChange(repo, { ...rest, view: side, origin: side, lines: changedLines(lines) });
}

async function diffOf(path: string, side: DiffSide, untracked = false, origPath: string | null = null): Promise<FileDiff> {
  return fileDiff(repo, { path, side, origPath, untracked, stamp: "test" });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "git-ui-test-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  write("a.txt", lines(30));
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  repo = await openRepo(dir);
});

afterEach(() => {
  disposeRepos();
  rmSync(dir, { recursive: true, force: true });
});

describe("status", () => {
  it("reports staged, unstaged and untracked files", async () => {
    write("a.txt", TWO_HUNK_EDIT(lines(30)));
    write("new file.txt", "hello\n");
    git("add", "a.txt");
    write("a.txt", TWO_HUNK_EDIT(lines(30)) + "extra\n");
    const status = await readStatus(repo);
    expect(status.branch).toBe("main");
    expect(status.staged.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(status.unstaged.map((entry) => [entry.path, entry.kind])).toEqual([
      ["a.txt", "modified"],
      ["new file.txt", "untracked"],
    ]);
  });

  it("counts changed lines per entry, staged and unstaged", async () => {
    write("a.txt", TWO_HUNK_EDIT(lines(30)));
    git("add", "a.txt");
    write("a.txt", TWO_HUNK_EDIT(lines(30)) + "extra\nmore\n");
    write("new.txt", "one\ntwo\nthree");
    write("blob.bin", "a\0b");
    git("mv", "a.txt", "renamed a.txt");
    const status = await readStatus(repo);
    expect(status.staged[0]).toMatchObject({ path: "renamed a.txt", origPath: "a.txt", additions: 2, deletions: 2 });
    expect(status.unstaged.map((entry) => [entry.path, entry.additions, entry.deletions])).toEqual([
      ["blob.bin", null, null],
      ["new.txt", 3, 0],
      ["renamed a.txt", 2, 0],
    ]);
  });

  it("changes an entry's stamp when an already-modified file is edited again", async () => {
    write("a.txt", lines(30) + "x\n");
    const before = (await readStatus(repo)).unstaged[0].stamp;
    write("a.txt", lines(30) + "xy\n");
    expect((await readStatus(repo)).unstaged[0].stamp).not.toBe(before);
  });

  it("leaves other files' stamps alone when one file is staged", async () => {
    write("b.txt", "b\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "b");
    write("a.txt", lines(30) + "x\n");
    write("b.txt", "b2\n");
    const stampOf = async (path: string) => (await readStatus(repo)).unstaged.find((entry) => entry.path === path)?.stamp;
    const before = await stampOf("b.txt");
    git("add", "a.txt");
    expect(await stampOf("b.txt")).toBe(before);
    expect((await readStatus(repo)).staged.map((entry) => entry.path)).toEqual(["a.txt"]);
  });
});

describe("diff", () => {
  it("splits distant edits into hunks with line counts", async () => {
    write("a.txt", TWO_HUNK_EDIT(lines(30)));
    const diff = await diffOf("a.txt", "unstaged");
    expect(diff.status).toBe("ok");
    expect(diff.patchable).toBe(true);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.newLineCount).toBe(30);
  });

  it("ignores whitespace on request, without hunk staging", async () => {
    write("a.txt", TWO_HUNK_EDIT(lines(30)).replace("line 10\n", "line  10\n"));
    const target = { path: "a.txt", side: "unstaged" as const, origPath: null, untracked: false, stamp: "test", ignoreWhitespace: true };
    const diff = await fileDiff(repo, target);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks.flatMap((hunk) => hunk.lines).some((line) => line.type !== "context" && line.content.includes("10"))).toBe(false);
    expect(diff.patchable).toBe(false);

    write("a.txt", lines(30).replace("line 10\n", "line  10\n"));
    const whitespaceOnly = await fileDiff(repo, target);
    expect([whitespaceOnly.status, whitespaceOnly.message]).toEqual(["empty", "Only whitespace changed."]);
  });

  it("shows untracked files as all additions, file-level only", async () => {
    write("u.txt", "one\ntwo\n");
    const diff = await diffOf("u.txt", "unstaged", true);
    expect(diff.status).toBe("ok");
    expect(diff.isNew).toBe(true);
    expect(diff.patchable).toBe(false);
    expect(diff.hunks[0].lines.map((line) => line.content)).toEqual(["one", "two"]);
  });

  it("shows untracked files even when git warns about line endings", async () => {
    git("config", "core.autocrlf", "true");
    write("lf.txt", "one\ntwo");
    write("blob.bin", "a\0b");
    write("empty.txt", "");
    const text = await diffOf("lf.txt", "unstaged", true);
    expect(text.status).toBe("ok");
    expect(text.hunks[0].lines.map((line) => [line.content, line.noNewline])).toEqual([
      ["one", false],
      ["two", true],
    ]);
    expect((await diffOf("blob.bin", "unstaged", true)).status).toBe("binary");
    expect(await diffOf("empty.txt", "unstaged", true)).toMatchObject({ status: "empty", isNew: true });
  });

  it("reports a failing file as an error diff instead of throwing", async () => {
    const diff = await diffOf("missing.txt", "unstaged", true);
    expect(diff.status).toBe("error");
    expect(diff.message).toBeTruthy();
  });

  it("reads context lines from the new side", async () => {
    write("a.txt", TWO_HUNK_EDIT(lines(30)));
    const result = await readLines(repo, "a.txt", "unstaged", 10, 12);
    expect(result.lines.map((line) => line.content)).toEqual(["line 10", "line 11", "line 12"]);
  });

  it("highlights supported languages", async () => {
    write("code.ts", "const a = 1;\n");
    git("add", "code.ts");
    git("commit", "-q", "-m", "code");
    write("code.ts", "const a = 2;\n");
    const diff = await diffOf("code.ts", "unstaged");
    const added = diff.hunks[0].lines.find((line) => line.type === "add")!;
    expect(added.tokens?.some(([text, role]) => text === "const" && role === "keyword")).toBe(true);
  });
});

describe("hunks", () => {
  it("stages, unstages and discards a single hunk", async () => {
    write("a.txt", TWO_HUNK_EDIT(lines(30)));

    let diff = await diffOf("a.txt", "unstaged");
    expect(await applyHunk(repo, { path: "a.txt", origPath: null, side: "unstaged", hunk: diff.hunks[1], action: "stage" })).toMatchObject({ ok: true });
    expect(git("diff", "--cached")).toContain("+line twenty-five");
    expect(git("diff", "--cached")).not.toContain("+line two\n");
    expect(git("diff")).toContain("+line two\n");

    diff = await diffOf("a.txt", "staged");
    expect(await applyHunk(repo, { path: "a.txt", origPath: null, side: "staged", hunk: diff.hunks[0], action: "unstage" })).toMatchObject({ ok: true });
    expect(git("diff", "--cached")).toBe("");

    diff = await diffOf("a.txt", "unstaged");
    expect(await applyHunk(repo, { path: "a.txt", origPath: null, side: "unstaged", hunk: diff.hunks[0], action: "discard" })).toMatchObject({ ok: true });
    const content = readFileSync(join(dir, "a.txt"), "utf8");
    expect(content).toContain("line 2\n");
    expect(content).toContain("line twenty-five\n");
  });

  it("stages, unstages and discards one block of changes inside a hunk", async () => {
    // Line 5 replaced and a line added after line 8: close enough for one hunk with two blocks.
    write("a.txt", lines(30).replace("line 5\n", "line five\n").replace("line 8\n", "line 8\nextra\n"));
    const blockOf = (diff: FileDiff, text: string): [number, number] => {
      const lines = diff.hunks[0].lines;
      const at = lines.findIndex((line) => line.content === text);
      let start = at;
      while (start > 0 && lines[start - 1].type !== "context") start--;
      return [start, at];
    };
    let diff = await diffOf("a.txt", "unstaged");
    expect(diff.hunks).toHaveLength(1);
    const apply = (side: Side, action: "stage" | "unstage" | "discard", range: [number, number]) =>
      applyHunk(repo, { path: "a.txt", origPath: null, side, hunk: diff.hunks[0], range, action });

    expect(await apply("unstaged", "stage", blockOf(diff, "extra"))).toMatchObject({ ok: true });
    expect(git("show", ":a.txt")).toBe(lines(30).replace("line 8\n", "line 8\nextra\n"));

    diff = await diffOf("a.txt", "unstaged");
    expect(await apply("unstaged", "stage", blockOf(diff, "line five"))).toMatchObject({ ok: true });
    diff = await diffOf("a.txt", "staged");
    expect(await apply("staged", "unstage", blockOf(diff, "extra"))).toMatchObject({ ok: true });
    expect(git("show", ":a.txt")).toBe(lines(30).replace("line 5\n", "line five\n"));

    diff = await diffOf("a.txt", "unstaged");
    expect(await apply("unstaged", "discard", blockOf(diff, "extra"))).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe(lines(30).replace("line 5\n", "line five\n"));
  });

  it("marks each line of the combined diff staged or unstaged, and applies changes from it", async () => {
    // Staged: line 5 replaced. Unstaged: line 20 removed and a line added at the end.
    write("a.txt", lines(30).replace("line 5\n", "line five\n"));
    git("add", "a.txt");
    write("a.txt", lines(30).replace("line 5\n", "line five\n").replace("line 20\n", "") + "tail\n");
    let diff = await diffOf("a.txt", "combined");
    const changes = () => diff.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.type !== "context").map((line) => `${line.origin} ${line.type} ${line.content}`));
    expect(changes()).toEqual(["staged remove line 5", "staged add line five", "unstaged remove line 20", "unstaged add tail"]);
    const pick = (content: string) => changedLines(diff.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.content === content && line.type !== "context")));
    const apply = (origin: Side, action: "stage" | "unstage" | "discard", content: string[]) =>
      applyChange(repo, { path: "a.txt", origPath: null, view: "combined", origin, action, lines: content.flatMap(pick) });

    // The removal of line 20 is found in the unstaged diff through the staged one, which moved nothing above it.
    expect(await apply("unstaged", "stage", ["line 20"])).toMatchObject({ ok: true });
    expect(git("show", ":a.txt")).toBe(lines(30).replace("line 5\n", "line five\n").replace("line 20\n", ""));
    diff = await diffOf("a.txt", "combined");
    expect(changes()).toContain("staged remove line 20");

    expect(await apply("staged", "unstage", ["line 5", "line five"])).toMatchObject({ ok: true });
    expect(git("show", ":a.txt")).toBe(lines(30).replace("line 20\n", ""));
    diff = await diffOf("a.txt", "combined");
    expect(changes()).toEqual(["unstaged remove line 5", "unstaged add line five", "staged remove line 20", "unstaged add tail"]);

    expect(await apply("unstaged", "discard", ["tail"])).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe(lines(30).replace("line 5\n", "line five\n").replace("line 20\n", ""));

    // A line the user hasn't seen: refused.
    expect(await applyChange(repo, { path: "a.txt", origPath: null, view: "combined", origin: "unstaged", action: "stage", lines: [{ type: "add", no: 5, content: "other" }] })).toMatchObject({ ok: false, reason: "stale" });
  });

  it("gives the same diffs in a batch as one file at a time", async () => {
    write("b.txt", lines(10, "b"));
    write("gone.txt", "bye\n");
    write("with space.txt", lines(5, "s"));
    git("add", ".");
    git("commit", "-q", "-m", "more");
    write("a.txt", TWO_HUNK_EDIT(lines(30)));
    git("add", "a.txt");
    write("a.txt", TWO_HUNK_EDIT(lines(30)) + "tail\n");
    git("mv", "b.txt", "b2.txt");
    write("b2.txt", lines(10, "b").replace("b 9\n", "b nine\n"));
    git("add", "b2.txt");
    git("rm", "-q", "gone.txt");
    write("with space.txt", lines(5, "s").replace("s 3\n", "s three\n"));
    write("new.txt", "fresh\n");
    const target = (path: string, side: DiffSide, extra: { origPath?: string; untracked?: boolean } = {}) => ({
      path,
      side,
      origPath: extra.origPath ?? null,
      untracked: extra.untracked ?? false,
      stamp: "s",
    });
    const targets = [
      target("a.txt", "combined"),
      target("a.txt", "staged"),
      target("a.txt", "unstaged"),
      target("b2.txt", "combined", { origPath: "b.txt" }),
      target("b2.txt", "staged", { origPath: "b.txt" }),
      target("gone.txt", "combined"),
      target("with space.txt", "combined"),
      target("new.txt", "combined", { untracked: true }),
    ];
    const batched = await fileDiffs(repo, targets);
    const single = await Promise.all(targets.map((one) => fileDiff(repo, one)));
    expect(batched).toEqual(single);
    expect(batched.map((diff) => diff.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
  });

  it("reads many blobs with one process, missing ones as null", async () => {
    write("b.txt", "b\n");
    git("add", "b.txt");
    const blobs = await readBlobs(repo, [":a.txt", "HEAD:a.txt", ":b.txt", "HEAD:b.txt", ":nope"]);
    expect([...blobs]).toEqual([
      [":a.txt", lines(30)],
      ["HEAD:a.txt", lines(30)],
      [":b.txt", "b\n"],
      ["HEAD:b.txt", null],
      [":nope", null],
    ]);
  });

  it("keeps CRLF line endings when staging a hunk", async () => {
    const crlf = (text: string) => text.replace(/\n/g, "\r\n");
    write("crlf.txt", crlf(lines(30)));
    git("add", "crlf.txt");
    git("commit", "-q", "-m", "crlf");
    write("crlf.txt", crlf(TWO_HUNK_EDIT(lines(30))));
    const diff = await diffOf("crlf.txt", "unstaged");
    expect(await applyHunk(repo, { path: "crlf.txt", origPath: null, side: "unstaged", hunk: diff.hunks[0], action: "stage" })).toMatchObject({ ok: true });
    const staged = git("show", ":crlf.txt");
    expect(staged).toContain("line two\r\n");
    expect(staged).toContain("line 25\r\n");
  });

  it("stages and discards hunks with core.autocrlf=true", async () => {
    git("config", "core.autocrlf", "true");
    // LF in the repository, CRLF in the worktree, as Git for Windows checks files out.
    write("a.txt", TWO_HUNK_EDIT(lines(30)).replace(/\n/g, "\r\n"));
    let diff = await diffOf("a.txt", "unstaged");
    expect(diff.hunks).toHaveLength(2);
    expect(await applyHunk(repo, { path: "a.txt", origPath: null, side: "unstaged", hunk: diff.hunks[0], action: "stage" })).toMatchObject({ ok: true });
    expect(git("show", ":a.txt")).toContain("line two\nline 3\n");
    diff = await diffOf("a.txt", "unstaged");
    expect(await applyHunk(repo, { path: "a.txt", origPath: null, side: "unstaged", hunk: diff.hunks[0], action: "discard" })).toMatchObject({ ok: true });
    const content = readFileSync(join(dir, "a.txt"), "utf8");
    expect(content).toContain("line 25\r\n");
    expect(content).toContain("line two\r\n");
  });

  it("handles a file without a trailing newline", async () => {
    write("eof.txt", "a\nb");
    git("add", "eof.txt");
    git("commit", "-q", "-m", "eof");
    write("eof.txt", "a\nc");
    const diff = await diffOf("eof.txt", "unstaged");
    expect(diff.hunks[0].lines.filter((line) => line.noNewline)).toHaveLength(2);
    expect(await applyHunk(repo, { path: "eof.txt", origPath: null, side: "unstaged", hunk: diff.hunks[0], action: "stage" })).toMatchObject({ ok: true });
    expect(git("show", ":eof.txt")).toBe("a\nc");
  });

  it("unstages a hunk of a staged rename without undoing the rename", async () => {
    git("mv", "a.txt", "b.txt");
    write("b.txt", TWO_HUNK_EDIT(lines(30)));
    git("add", "b.txt");
    const status = await readStatus(repo);
    expect(status.staged[0]).toMatchObject({ path: "b.txt", origPath: "a.txt", kind: "renamed" });
    const diff = await diffOf("b.txt", "staged", false, "a.txt");
    expect(diff.hunks).toHaveLength(2);
    expect(await applyHunk(repo, { path: "b.txt", origPath: "a.txt", side: "staged", hunk: diff.hunks[0], action: "unstage" })).toMatchObject({ ok: true });
    const index = git("show", ":b.txt");
    expect(index).toContain("line 2\n");
    expect(index).toContain("line twenty-five\n");
    expect(git("diff", "--cached", "--name-status", "-M")).toMatch(/^R\d+\ta\.txt\tb\.txt/m);
  });

  it("applies only the changes that were seen when nearby lines changed since", async () => {
    write("a.txt", TWO_HUNK_EDIT(lines(30)));
    const diff = await diffOf("a.txt", "unstaged");
    // Line 4 is context in the first hunk; its new edit wasn't seen, so it stays unstaged.
    write("a.txt", TWO_HUNK_EDIT(lines(30)).replace("line 4\n", "line four\n"));
    expect(await applyHunk(repo, { path: "a.txt", origPath: null, side: "unstaged", hunk: diff.hunks[0], action: "stage" })).toMatchObject({ ok: true });
    expect(git("show", ":a.txt")).toBe(lines(30).replace("line 2\n", "line two\n"));
  });

  it("rejects changed lines that are no longer there", async () => {
    write("a.txt", TWO_HUNK_EDIT(lines(30)));
    const diff = await diffOf("a.txt", "unstaged");
    write("a.txt", TWO_HUNK_EDIT(lines(30)).replace("line two\n", "line 2!\n"));
    expect(await applyHunk(repo, { path: "a.txt", origPath: null, side: "unstaged", hunk: diff.hunks[0], action: "stage" })).toMatchObject({ ok: false, reason: "stale" });
    expect(git("diff", "--cached")).toBe("");
  });

  it("still applies a hunk when only other parts of the file changed", async () => {
    write("a.txt", TWO_HUNK_EDIT(lines(30)));
    const diff = await diffOf("a.txt", "unstaged");
    write("a.txt", TWO_HUNK_EDIT(lines(30)).replace("line 14\n", "line fourteen\n"));
    expect(await applyHunk(repo, { path: "a.txt", origPath: null, side: "unstaged", hunk: diff.hunks[1], action: "stage" })).toMatchObject({ ok: true });
    expect(git("diff", "--cached")).toContain("+line twenty-five");
    expect(git("diff", "--cached")).not.toContain("fourteen");
  });

  it("stages several hunks in a row from one diff", async () => {
    write("a.txt", TWO_HUNK_EDIT(lines(30)));
    const diff = await diffOf("a.txt", "unstaged");
    for (const index of [1, 0]) {
      expect(await applyHunk(repo, { path: "a.txt", origPath: null, side: "unstaged", hunk: diff.hunks[index], action: "stage" })).toMatchObject({ ok: true });
    }
    expect(git("diff")).toBe("");
  });

  it("treats glob characters in file names literally", async () => {
    write("a[1].txt", "x\n");
    write("a1.txt", "y\n");
    expect(await applyFiles(repo, ["a[1].txt"], "stage")).toMatchObject({ ok: true });
    expect(git("diff", "--cached", "--name-only").trim()).toBe("a[1].txt");
  });
});

describe("files and commits", () => {
  it("stages, unstages and discards whole files", async () => {
    write("a.txt", lines(31));
    write("u.txt", "untracked\n");
    expect(await applyFiles(repo, ["a.txt"], "stage")).toMatchObject({ ok: true });
    expect(git("diff", "--cached", "--name-only").trim()).toBe("a.txt");
    expect(await applyFiles(repo, ["a.txt"], "unstage")).toMatchObject({ ok: true });
    expect(git("diff", "--cached")).toBe("");
    expect(await applyFiles(repo, ["a.txt", "u.txt"], "discard")).toMatchObject({ ok: true });
    expect(git("status", "--porcelain")).toBe("");
  });

  it("unstages before the first commit", async () => {
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    git("init", "-q", "-b", "main");
    disposeRepos();
    repo = await openRepo(dir);
    git("add", "a.txt");
    expect(await applyFiles(repo, ["a.txt"], "unstage")).toMatchObject({ ok: true });
    expect(git("status", "--porcelain").trim()).toBe("?? a.txt");
  });

  it("commits, amends, and refuses an empty commit", async () => {
    expect(await commitChanges(repo, "nothing")).toMatchObject({ ok: false });
    write("a.txt", lines(31));
    git("add", "a.txt");
    const first = await commitChanges(repo, "Add line 31\n\nWith a body.");
    expect(first).toMatchObject({ ok: true });
    expect(git("log", "-1", "--format=%B").trim()).toBe("Add line 31\n\nWith a body.");
    const amended = await commitChanges(repo, "Add line thirty-one", { amend: true });
    expect(amended).toMatchObject({ ok: true });
    expect(git("log", "-1", "--format=%s").trim()).toBe("Add line thirty-one");
    expect(git("rev-list", "--count", "HEAD").trim()).toBe("2");
  });

  it("commits everything, untracked files included, with all", async () => {
    write("a.txt", lines(31));
    write("new.txt", "new\n");
    expect(await commitChanges(repo, "Everything", { all: true })).toMatchObject({ ok: true });
    expect(git("status", "--porcelain")).toBe("");
    expect(git("show", "--name-only", "--format=").trim().split("\n").sort()).toEqual(["a.txt", "new.txt"]);
  });

  it("reports a failing commit hook", async () => {
    write(".git/hooks/pre-commit", "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");
    execFileSync("git", ["update-index", "--chmod=+x", "a.txt"], { cwd: dir });
    git("config", "core.hooksPath", ".git/hooks");
    try {
      execFileSync("chmod", ["+x", join(dir, ".git/hooks/pre-commit")]);
    } catch {
      // Windows: git for Windows runs hooks without the executable bit.
    }
    const result = await commitChanges(repo, "blocked");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("lint failed");
  });
});
