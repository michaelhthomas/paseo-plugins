import { describe, expect, it } from "vitest";
import { findRefs, hasRefs, linkifyRefs, uniqueRefs } from "../shared/refs";

const refs = (text: string) => findRefs(text).map(({ kind, number }) => `${kind}:${number}`);

describe("findRefs", () => {
  it("finds GitHub and Azure Boards references", () => {
    expect(refs("Fixed in #12345, tracked by AB#678 and ab#9.")).toEqual(["github:12345", "ado:678", "ado:9"]);
  });

  it("finds references at line starts, in parentheses and lists", () => {
    expect(refs("#1 first\n- (#2)\n* AB#3: done")).toEqual(["github:1", "github:2", "ado:3"]);
  });

  it("ignores headings, entities, fragments and words", () => {
    expect(refs("# Heading\n&#123; foo#4 issue_#5 #6a ##7 AB#x")).toEqual([]);
  });

  it("ignores URLs, links and autolinks", () => {
    expect(refs("See https://example.com/page#12 and [the PR #3](https://x/pull/3) and <https://x/#4>")).toEqual([]);
  });

  it("ignores inline code and fenced code", () => {
    expect(refs("Use `#1` here\n```\ncolor: #2;\n```\nthen #3\n~~~ts\n#4")).toEqual(["github:3"]);
  });

  it("ignores zero", () => {
    expect(refs("#0 AB#0")).toEqual([]);
  });
});

describe("hasRefs", () => {
  it("is false without a reference", () => {
    expect(hasRefs("no refs, just `#1` code")).toBe(false);
    expect(hasRefs("one: AB#2")).toBe(true);
  });
});

describe("uniqueRefs", () => {
  it("keeps first appearance order", () => {
    expect(uniqueRefs(findRefs("#2 AB#2 #1 #2 AB#2"))).toEqual([
      { kind: "github", number: 2 },
      { kind: "ado", number: 2 },
      { kind: "github", number: 1 },
    ]);
  });
});

describe("linkifyRefs", () => {
  it("links known references and leaves the rest", () => {
    const url = (ref: { kind: string; number: number }) => (ref.number === 1 ? `https://x/${ref.kind}/1` : null);
    expect(linkifyRefs("#1 and AB#1 but not #2 or `#1`", url)).toBe(
      "[#1](<https://x/github/1>) and [AB#1](<https://x/ado/1>) but not #2 or `#1`",
    );
  });
});
