import { Platform } from "react-native";
import { TERMINAL_FONT_SIZE } from "./diff-metrics";

// The SDK exposes no font tokens or terminal component, so mirror the stack and size Paseo's own terminal uses.
const TERMINAL_FONT_STACK =
  "'JetBrains Mono', 'JetBrainsMono Nerd Font', 'JetBrainsMono NF', 'MesloLGM Nerd Font', 'MesloLGM NF', 'Hack Nerd Font', " +
  "'FiraCode Nerd Font', 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace";

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: TERMINAL_FONT_STACK });
export { TERMINAL_FONT_SIZE };

/**
 * Paseo gives every Text its UI font, so nested Text does not inherit the parent's font.
 * Spread this into every Text that renders code, nested or not.
 */
export const terminalFont = { fontFamily: MONO, fontSize: TERMINAL_FONT_SIZE } as const;
