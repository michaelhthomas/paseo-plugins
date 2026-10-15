import { createHash } from "node:crypto";
import { highlightCode, isLanguageSupported, isSyntaxThemeId, resolveSyntaxColors } from "@getpaseo/highlight";
import { DEFAULT_SYNTAX_THEME, type Token } from "../shared/git";

const MAX_HIGHLIGHT_BYTES = 1024 * 1024;
// Same per-line cap as Paseo's own diff highlighter (MAX_DIFF_HIGHLIGHT_LINE_CHARS).
const MAX_LINE_CHARS = 10_000;
const CACHE_SIZE = 64;

const cache = new Map<string, Token[][] | null>();

/**
 * Tokens for every line of `content` (index 0 is line 1), or null when the language isn't supported or the file is
 * too large. Highlights whole files, as Paseo does, so strings and comments spanning lines come out right.
 */
export function highlightFile(content: string, path: string): Token[][] | null {
  if (!isLanguageSupported(path) || content.length > MAX_HIGHLIGHT_BYTES) return null;
  const key = createHash("sha1").update(path.slice(path.lastIndexOf("."))).update("\0").update(content).digest("hex");
  if (cache.has(key)) {
    const hit = cache.get(key)!;
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const normalized = content.replace(/\r\n/g, "\n");
  let result: Token[][] | null = null;
  if (!normalized.split("\n").some((line) => line.length > MAX_LINE_CHARS)) {
    try {
      result = highlightCode(normalized, path).map((line) =>
        line.filter((token) => token.text).map((token): Token => [token.text, token.style]),
      );
    } catch (error) {
      console.error(`[git-ui] highlighting ${path} failed`, error);
    }
  }
  cache.set(key, result);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return result;
}

export function syntaxColors(theme: string) {
  const id = isSyntaxThemeId(theme) ? theme : DEFAULT_SYNTAX_THEME;
  return { light: resolveSyntaxColors(id, "light"), dark: resolveSyntaxColors(id, "dark") };
}

export function clearHighlightCache() {
  cache.clear();
}
