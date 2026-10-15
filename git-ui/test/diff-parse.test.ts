import { describe, expect, it } from "vitest";
import { buildHunkPatch, contentLines, countLines, parseFileDiff } from "../server/diff-parse";

const TWO_HUNKS = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@ function top()",
  " one",
  "-two",
  "+TWO",
  " three",
  "@@ -10,2 +10,3 @@",
  " ten",
  "+ten and a half",
  " eleven",
  "",
].join("\n");

describe("parseFileDiff", () => {
  it("numbers lines on both sides", () => {
    const diff = parseFileDiff(TWO_HUNKS)!;
    expect(diff.hunks).toHaveLength(2);
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);
    expect(diff.hunks[0].header).toBe("@@ -1,3 +1,3 @@ function top()");
    expect(diff.hunks[0].lines).toEqual([
      { type: "context", content: "one", oldNo: 1, newNo: 1, noNewline: false },
      { type: "remove", content: "two", oldNo: 2, newNo: null, noNewline: false },
      { type: "add", content: "TWO", oldNo: null, newNo: 2, noNewline: false },
      { type: "context", content: "three", oldNo: 3, newNo: 3, noNewline: false },
    ]);
    expect(diff.hunks[1].lines.map((line) => [line.oldNo, line.newNo])).toEqual([
      [10, 10],
      [null, 11],
      [11, 12],
    ]);
  });

  it("keeps raw hunk text byte for byte, CRLF included", () => {
    const raw = "diff --git a/x b/x\r\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\r\n+b\r\n";
    const diff = parseFileDiff(raw)!;
    expect(diff.hunks[0].raw).toBe("@@ -1 +1 @@\n-a\r\n+b\r\n");
    expect(diff.hunks[0].lines.map((line) => line.content)).toEqual(["a", "b"]);
  });

  it("attaches no-newline markers to the line before them", () => {
    const raw = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+c",
      "\\ No newline at end of file",
    ].join("\n");
    const diff = parseFileDiff(raw)!;
    expect(diff.hunks[0].lines.map((line) => [line.content, line.noNewline])).toEqual([
      ["a", false],
      ["b", true],
      ["c", true],
    ]);
    expect(diff.hunks[0].raw.endsWith("+c\n\\ No newline at end of file")).toBe(true);
  });

  it("treats a bare empty line inside a hunk as empty context", () => {
    const raw = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n\n-c\n+d\n";
    const diff = parseFileDiff(raw)!;
    expect(diff.hunks[0].lines.map((line) => [line.type, line.content])).toEqual([
      ["context", "a"],
      ["context", ""],
      ["remove", "c"],
      ["add", "d"],
    ]);
  });

  it("recognizes new, deleted, binary, renamed and submodule files", () => {
    expect(parseFileDiff("diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+a\n")!.isNew).toBe(true);
    expect(parseFileDiff("diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n")!.isDeleted).toBe(true);
    expect(parseFileDiff("diff --git a/x b/x\nindex 1..2 100644\nBinary files a/x and b/x differ\n")!.isBinary).toBe(true);
    expect(parseFileDiff("diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n")!.isRename).toBe(true);
    expect(parseFileDiff("diff --git a/m b/m\nindex 1..2 160000\n--- a/m\n+++ b/m\n@@ -1 +1 @@\n-Subproject commit 1\n+Subproject commit 2\n")!.isSubmodule).toBe(true);
  });

  it("returns null for empty output", () => {
    expect(parseFileDiff("")).toBeNull();
  });
});

describe("buildHunkPatch", () => {
  it("keeps the original header for a plain modification", () => {
    const diff = parseFileDiff(TWO_HUNKS)!;
    const patch = buildHunkPatch(diff, 1);
    expect(patch).toBe(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,2 +10,3 @@\n ten\n+ten and a half\n eleven\n",
    );
  });

  it("drops rename and mode lines, targeting the new path", () => {
    const raw = [
      "diff --git a/old name.ts b/new name.ts",
      "old mode 100644",
      "new mode 100755",
      "similarity index 90%",
      "rename from old name.ts",
      "rename to new name.ts",
      "index 1..2",
      "--- a/old name.ts\t",
      "+++ b/new name.ts\t",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(buildHunkPatch(parseFileDiff(raw)!, 0)).toBe(
      "diff --git a/new name.ts b/new name.ts\n--- a/new name.ts\t\n+++ b/new name.ts\t\n@@ -1 +1 @@\n-a\n+b\n",
    );
  });

  it("keeps git's quoting", () => {
    const raw = 'diff --git "a/t\\tb" "b/t\\tb"\n--- "a/t\\tb"\n+++ "b/t\\tb"\n@@ -1 +1 @@\n-a\n+b\n';
    expect(buildHunkPatch(parseFileDiff(raw.replace("--- ", "old mode 100644\nnew mode 100755\n--- "))!, 0)).toBe(
      'diff --git "a/t\\tb" "b/t\\tb"\n--- "a/t\\tb"\n+++ "b/t\\tb"\n@@ -1 +1 @@\n-a\n+b\n',
    );
  });
});

describe("countLines", () => {
  it("counts a final line without a newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\r\nb\r\n")).toBe(2);
  });

  it("matches contentLines", () => {
    expect(contentLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });
});
