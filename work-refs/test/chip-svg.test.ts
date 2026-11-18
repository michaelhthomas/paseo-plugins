import { describe, expect, it } from "vitest";
import { chipDataUrl, chipMarkdown, chipSvg, textWidth, truncateTitle } from "../shared/chip-svg";
import { replaceRefs } from "../shared/refs";

const colors = { background: "#111", border: "#333", foreground: "#eee", muted: "#999" };

describe("chipSvg", () => {
  it("draws at the line height and grows with the title", () => {
    const short = chipSvg({ label: "#1", title: "Fix", icon: "GitPullRequest", tint: "#1f883d", colors, height: 21 });
    const long = chipSvg({ label: "#1", title: "Fix the thing that broke", icon: "GitPullRequest", tint: "#1f883d", colors, height: 21 });
    expect(short.height).toBe(21);
    expect(short.svg).toContain('height="21"');
    expect(long.width).toBeGreaterThan(short.width);
  });

  it("escapes XML in titles", () => {
    const { svg } = chipSvg({ label: "AB#2", title: `<script>&"'`, icon: "Bug", tint: "red", colors, height: 21 });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&#60;script&#62;&#38;&#34;&#39;");
  });

  it("makes a data URL Markdown can hold", () => {
    const url = chipDataUrl({ label: "#1", title: "A (b) c", icon: "CircleDot", tint: "#000", colors, height: 21 });
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(url).not.toMatch(/[\s<>]/);
  });
});

describe("text measurement", () => {
  it("uses Helvetica widths", () => {
    expect(textWidth("ii", 10)).toBeCloseTo(4.44);
    expect(textWidth("MM", 10)).toBeCloseTo(16.66);
  });

  it("truncates long titles", () => {
    expect(truncateTitle("x".repeat(80))).toHaveLength(60);
    expect(truncateTitle("x".repeat(80)).endsWith("…")).toBe(true);
    expect(truncateTitle("  short ")).toBe("short");
  });
});

describe("chipMarkdown", () => {
  it("links an image with a tooltip and keeps it off a line of its own", () => {
    const markdown = chipMarkdown({ alt: "#1 [WIP] fix_it", tooltip: 'Issue "#1"', image: "data:x", url: "https://x/1" });
    expect(markdown).toBe('[![#1 \\[WIP\\] fix\\_it](<data:x> "Issue \\"#1\\"")](<https://x/1>)​');
  });

  it("replaces only known references", () => {
    expect(replaceRefs("#1 and #2 and `#1`", (ref) => (ref.number === 1 ? "CHIP" : null))).toBe("CHIP and #2 and `#1`");
  });
});

describe("Azure DevOps icons and states", () => {
  it("embeds the type's icon and a state dot", () => {
    const plain = chipSvg({ label: "AB#1", title: "Bug", icon: "Bug", tint: "red", colors, height: 21 });
    const { svg, width } = chipSvg({
      label: "AB#1",
      title: "Bug",
      icon: "Bug",
      tint: "red",
      colors,
      height: 21,
      iconUrl: "data:image/svg+xml;base64,PHN2Zy8+",
      stateColor: "#43b4d5",
    });
    expect(svg).toContain('<image x="6"');
    expect(svg).toContain('href="data:image/svg+xml;base64,PHN2Zy8+"');
    expect(svg).toContain('fill="#43b4d5"');
    expect(svg).not.toContain("stroke-linecap");
    expect(width).toBeGreaterThan(plain.width);
  });
});
