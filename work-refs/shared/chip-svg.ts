/**
 * Draws a reference chip as an SVG data URL. Paseo's Markdown shows an image that shares a line with text inline at
 * line height, and a linked image stays inline, so `[![alt](data:image/svg+xml…)](url)` puts a clickable chip in the
 * text while Paseo renders everything else. Native apps can't show SVG images and show the alt text, still linked.
 */

/** Lucide icons (ISC license), 24×24 with a 2px round stroke. */
const ICONS: Record<string, string> = {
  GitPullRequest: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
  GitPullRequestClosed:
    '<path d="m15.5 3.5 5 5"/><path d="m15.5 8.5 5-5"/><path d="M18 11.62V15"/><path d="M6 9v12"/><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>',
  GitPullRequestDraft:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 6V5"/><path d="M18 11v-1"/><path d="M6 9v12"/>',
  GitMerge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  CircleDot: '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="12" r="10"/>',
  CircleCheck: '<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>',
  Bug: '<path d="M12 20v-9"/><path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/><path d="M14.12 3.88 16 2"/><path d="M21 21a4 4 0 0 0-3.81-4"/><path d="M21 5a4 4 0 0 1-3.55 3.97"/><path d="M22 13h-4"/><path d="M3 21a4 4 0 0 1 3.81-4"/><path d="M3 5a4 4 0 0 0 3.55 3.97"/><path d="M6 13H2"/><path d="m8 2 1.88 1.88"/><path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>',
  ClipboardCheck:
    '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  BookOpen:
    '<path d="M12 5v16"/><path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"/>',
  Trophy:
    '<path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2"/><path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2"/><path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3"/>',
  Crown:
    '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
  FlaskConical:
    '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>',
  SquareKanban: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 7v7"/><path d="M12 7v4"/><path d="M16 7v9"/>',
};
export type ChipIcon = keyof typeof ICONS;

/**
 * Helvetica/Arial advance widths per 1000 units for printable ASCII (32–126). An SVG image can't measure text, so the
 * chip is sized from these, with the font pinned to Arial/Helvetica (metrically identical) and `textLength` absorbing
 * any difference.
 */
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD_SCALE = 1.08;
const OTHER = 600;

export function textWidth(text: string, fontSize: number, bold = false) {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    units += code >= 32 && code <= 126 ? REGULAR[code - 32] : code > 0x2e80 ? 1000 : OTHER;
  }
  return (units / 1000) * fontSize * (bold ? BOLD_SCALE : 1);
}

const MAX_TITLE = 60;

export function truncateTitle(title: string) {
  const chars = [...title.trim()];
  return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE - 1).join("").trimEnd()}…` : chars.join("");
}

function escapeXml(text: string) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export interface ChipColors {
  background: string;
  border: string;
  foreground: string;
  muted: string;
}

export interface ChipInput {
  /** "#123" or "AB#123". */
  label: string;
  title: string;
  icon: ChipIcon;
  /** The icon's color, from the item's state. */
  tint: string;
  /** An image to draw instead of `icon`, such as Azure DevOps' own icon for the work item type, as a data URL. */
  iconUrl?: string | null;
  /** Draws a dot in this color before the title, the way Azure Boards shows state. */
  stateColor?: string | null;
  colors: ChipColors;
  /** The text's line height; the chip is drawn at this height so it shows at 1:1. */
  height: number;
}

const FONT = "Arial, Helvetica, sans-serif";
const FONT_SIZE = 12;
const ICON = 12;
const PAD_LEFT = 6;
const PAD_RIGHT = 8;
const GAP = 4;
const TITLE_GAP = 5;
const DOT = 7;

/** The chip's SVG markup and size. */
export function chipSvg({ label, title, icon, tint, colors, height, iconUrl, stateColor }: ChipInput) {
  const shown = truncateTitle(title);
  const labelWidth = Math.ceil(textWidth(label, FONT_SIZE, true));
  const titleWidth = shown ? Math.ceil(textWidth(shown, FONT_SIZE)) : 0;
  const labelX = PAD_LEFT + ICON + GAP;
  const dotX = labelX + labelWidth + TITLE_GAP;
  const titleX = stateColor ? dotX + DOT + TITLE_GAP - 1 : dotX;
  const width = (shown ? titleX + titleWidth : labelX + labelWidth) + PAD_RIGHT;
  const pill = height - 3;
  const top = (height - pill) / 2;
  const middle = height / 2;
  // Baseline for 12px Arial centered on the pill: cap height is about 0.716em.
  const baseline = (middle + FONT_SIZE * 0.716 * 0.5).toFixed(2);
  const iconScale = ICON / 24;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0.5" y="${top}" width="${width - 1}" height="${pill}" rx="${pill / 2}" fill="${escapeXml(colors.background)}" stroke="${escapeXml(colors.border)}"/>`,
    iconUrl
      ? `<image x="${PAD_LEFT}" y="${(middle - ICON / 2).toFixed(2)}" width="${ICON}" height="${ICON}" href="${escapeXml(iconUrl)}"/>`
      : `<g transform="translate(${PAD_LEFT} ${(middle - ICON / 2).toFixed(2)}) scale(${iconScale})" fill="none" stroke="${escapeXml(tint)}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</g>`,
    `<text x="${labelX}" y="${baseline}" font-family="${FONT}" font-size="${FONT_SIZE}" font-weight="700" fill="${escapeXml(colors.muted)}" textLength="${labelWidth}" lengthAdjust="spacingAndGlyphs">${escapeXml(label)}</text>`,
  ];
  if (stateColor) {
    // Outlined, so light states such as white "Removed" still show on a light chip.
    parts.push(
      `<circle cx="${dotX + DOT / 2}" cy="${middle}" r="${DOT / 2 - 0.5}" fill="${escapeXml(stateColor)}" stroke="${escapeXml(colors.muted)}" stroke-opacity="0.6" stroke-width="0.75"/>`,
    );
  }
  if (shown) {
    parts.push(
      `<text x="${titleX}" y="${baseline}" font-family="${FONT}" font-size="${FONT_SIZE}" fill="${escapeXml(colors.foreground)}" textLength="${titleWidth}" lengthAdjust="spacingAndGlyphs">${escapeXml(shown)}</text>`,
    );
  }
  parts.push("</svg>");
  return { svg: parts.join(""), width, height };
}

export function chipDataUrl(input: ChipInput) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(chipSvg(input).svg)}`;
}

/** Escapes text for Markdown image alt text or link text. */
export function escapeMarkdownLabel(text: string) {
  return text.replace(/[\\[\]*_`<>]/g, "\\$&");
}

/**
 * The Markdown for a chip: a linked image. A zero-width space follows it so a reference alone on its line still shares
 * the line with text; Paseo renders an image alone on its line as a full-size block image.
 */
export function chipMarkdown({ alt, tooltip, image, url }: { alt: string; tooltip: string; image: string; url: string }) {
  return `[![${escapeMarkdownLabel(alt)}](<${image}> ${JSON.stringify(tooltip)})](<${url}>)​`;
}
