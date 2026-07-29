import type { EditorTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { darkColors, lightColors, type ColorPalette, type ThemeName } from "./colors.js";

export type ColorLevel = 0 | 1 | 2 | 3;

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace("#", "");
  return {
    r: Number.parseInt(cleaned.slice(0, 2), 16),
    g: Number.parseInt(cleaned.slice(2, 4), 16),
    b: Number.parseInt(cleaned.slice(4, 6), 16),
  };
}

export function detectColorLevel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ColorLevel {
  if (env.NO_COLOR !== undefined || env.TERM === "dumb") return 0;
  const colorTerm = env.COLORTERM?.toLowerCase();
  if (colorTerm === "truecolor" || colorTerm === "24bit") return 3;
  if (env.TERM?.includes("256color")) return 2;
  return 1;
}

const ansi16 = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
  [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
  [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
] as const;

function nearestAnsi16(r: number, g: number, b: number): number {
  let selected = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ansi16.length; index += 1) {
    const candidate = ansi16[index]!;
    const next = (r - candidate[0]) ** 2 + (g - candidate[1]) ** 2 + (b - candidate[2]) ** 2;
    if (next < distance) {
      selected = index;
      distance = next;
    }
  }
  return selected;
}

function ansi256(r: number, g: number, b: number): number {
  const channel = (value: number) => Math.round(value / 255 * 5);
  return 16 + 36 * channel(r) + 6 * channel(g) + channel(b);
}

function colorCode(hex: string, level: ColorLevel, background: boolean): string {
  const { r, g, b } = hexToRgb(hex);
  if (level === 3) return `${background ? 48 : 38};2;${r};${g};${b}`;
  if (level === 2) return `${background ? 48 : 38};5;${ansi256(r, g, b)}`;
  const index = nearestAnsi16(r, g, b);
  const base = background ? 40 : 30;
  return String(index < 8 ? base + index : base + 60 + index - 8);
}

function paint(hex: string, text: string, level: ColorLevel, background = false): string {
  if (level === 0) return text;
  return `\u001b[${colorCode(hex, level, background)}m${text}\u001b[0m`;
}

export class Theme {
  #palette: ColorPalette;
  #name: ThemeName;
  readonly #colorLevel: ColorLevel;

  constructor(
    name: ThemeName = "auto",
    palette: ColorPalette = darkColors,
    colorLevel: ColorLevel = detectColorLevel(),
  ) {
    this.#name = name;
    this.#palette = palette;
    this.#colorLevel = colorLevel;
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
    return paint(this.#color(token), text, this.#colorLevel);
  }

  bg(token: keyof ColorPalette, text: string): string {
    return paint(this.#color(token), text, this.#colorLevel, true);
  }

  bold(text: string): string {
    return this.#colorLevel > 0 ? `\u001b[1m${text}\u001b[0m` : text;
  }

  dim(text: string): string {
    return this.#colorLevel > 0 ? `\u001b[2m${text}\u001b[0m` : text;
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

  #color(token: keyof ColorPalette): string {
    const direct = this.#palette[token];
    if (direct) return direct;
    switch (token) {
      case "body": return this.#palette.text;
      case "secondary": return this.#palette.textDim;
      case "muted": return this.#palette.textMuted;
      case "attention": return this.#palette.warning;
      case "surface": return this.#palette.userMessageBg;
      case "surfaceRaised": return this.#palette.toolPendingBg;
      default: return this.#palette.text;
    }
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
