import type { EditorTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { darkColors, lightColors, type ColorPalette, type ThemeName } from "./colors.js";

const colorEnabled = !process.env.NO_COLOR && process.env.TERM !== "dumb";

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace("#", "");
  return {
    r: Number.parseInt(cleaned.slice(0, 2), 16),
    g: Number.parseInt(cleaned.slice(2, 4), 16),
    b: Number.parseInt(cleaned.slice(4, 6), 16),
  };
}

/** Prefer truecolor; fall back to plain text when colour is disabled. */
function fgHex(hex: string, text: string): string {
  if (!colorEnabled) return text;
  const { r, g, b } = hexToRgb(hex);
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[0m`;
}

function bgHex(hex: string, text: string): string {
  if (!colorEnabled) return text;
  const { r, g, b } = hexToRgb(hex);
  return `\u001b[48;2;${r};${g};${b}m${text}\u001b[0m`;
}

export class Theme {
  #palette: ColorPalette;
  #name: ThemeName;

  constructor(name: ThemeName = "auto", palette: ColorPalette = darkColors) {
    this.#name = name;
    this.#palette = palette;
  }

  get name(): ThemeName {
    return this.#name;
  }

  get palette(): ColorPalette {
    return this.#palette;
  }

  setPalette(name: ThemeName, palette: ColorPalette): void {
    this.#name = name;
    this.#palette = palette;
  }

  fg(token: keyof ColorPalette, text: string): string {
    return fgHex(this.#palette[token], text);
  }

  bg(token: keyof ColorPalette, text: string): string {
    return bgHex(this.#palette[token], text);
  }

  bold(text: string): string {
    return colorEnabled ? `\u001b[1m${text}\u001b[0m` : text;
  }

  dim(text: string): string {
    return colorEnabled ? `\u001b[2m${text}\u001b[0m` : text;
  }

  boldFg(token: keyof ColorPalette, text: string): string {
    return this.bold(this.fg(token, text));
  }

  editorTheme(): EditorTheme {
    const selectList: SelectListTheme = {
      selectedPrefix: (text) => this.fg("primary", text),
      selectedText: (text) => this.bold(text),
      description: (text) => this.fg("textDim", text),
      scrollInfo: (text) => this.fg("textMuted", text),
      noMatch: (text) => this.fg("warning", text),
    };
    return {
      borderColor: (text) => this.fg("border", text),
      selectList,
    };
  }
}

export function resolveThemeName(requested: ThemeName, scheme?: "dark" | "light"): "dark" | "light" {
  if (requested === "dark" || requested === "light") return requested;
  return scheme ?? "dark";
}

export function paletteFor(name: "dark" | "light"): ColorPalette {
  return name === "light" ? lightColors : darkColors;
}

/** Session-scoped theme instance; tests may construct their own. */
export const theme = new Theme("auto", darkColors);

export function applyTheme(requested: ThemeName, scheme?: "dark" | "light"): Theme {
  const resolved = resolveThemeName(requested, scheme);
  theme.setPalette(requested === "auto" ? "auto" : resolved, paletteFor(resolved));
  return theme;
}
