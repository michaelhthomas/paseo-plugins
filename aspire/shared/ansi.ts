import { z } from "zod";

/** 0–255 is an xterm palette index (resolved against the client's theme); a string is a `#rrggbb` truecolor. */
export const ansiColorSchema = z.union([z.number(), z.string()]);

export const ansiSegmentSchema = z.object({
  text: z.string(),
  fg: ansiColorSchema.optional(),
  bg: ansiColorSchema.optional(),
  bold: z.literal(true).optional(),
  dim: z.literal(true).optional(),
  italic: z.literal(true).optional(),
  underline: z.literal(true).optional(),
  strike: z.literal(true).optional(),
  inverse: z.literal(true).optional(),
});

export type AnsiColor = z.infer<typeof ansiColorSchema>;
export type AnsiSegment = z.infer<typeof ansiSegmentSchema>;

type Style = Omit<AnsiSegment, "text">;

// CSI sequences (SGR and everything else), OSC sequences such as hyperlinks, and stray single-character escapes.
const ESCAPE = /\u001b\[([0-9;:?]*)([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");

/** Reads a `38;5;n` / `38;2;r;g;b` extended color starting at `codes[i]` (the 5 or 2). Returns the color and how many codes it used. */
function extendedColor(codes: number[], i: number): [AnsiColor | undefined, number] {
  if (codes[i] === 5) return [codes[i + 1], 2];
  if (codes[i] === 2) return [`#${hex(codes[i + 1] ?? 0)}${hex(codes[i + 2] ?? 0)}${hex(codes[i + 3] ?? 0)}`, 4];
  return [undefined, 0];
}

function applySgr(style: Style, params: string): Style {
  const next: Style = { ...style };
  const codes = params === "" ? [0] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) {
      for (const key of Object.keys(next) as (keyof Style)[]) delete next[key];
    } else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code === 29) delete next.strike;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const [color, used] = extendedColor(codes, i + 1);
      if (color !== undefined) next[code === 38 ? "fg" : "bg"] = color;
      i += used;
    }
  }
  return next;
}

/** Splits text containing ANSI escapes into styled segments plus the plain text. */
export function parseAnsi(raw: string): { text: string; segments: AnsiSegment[] } {
  const segments: AnsiSegment[] = [];
  let style: Style = {};
  let text = "";
  let last = 0;
  const push = (chunk: string) => {
    if (!chunk) return;
    text += chunk;
    const previous = segments[segments.length - 1];
    if (previous && sameStyle(previous, style)) previous.text += chunk;
    else segments.push({ text: chunk, ...style });
  };
  for (const match of raw.matchAll(ESCAPE)) {
    push(raw.slice(last, match.index));
    last = match.index! + match[0].length;
    if (match[2] === "m") style = applySgr(style, match[1]);
  }
  push(raw.slice(last));
  return { text, segments };
}

function sameStyle(a: Style, b: Style) {
  const keys: (keyof Style)[] = ["fg", "bg", "bold", "dim", "italic", "underline", "strike", "inverse"];
  return keys.every((key) => a[key] === b[key]);
}
