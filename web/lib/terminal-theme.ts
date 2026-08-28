import type { ResolvedTheme } from "./types";

export const terminalThemes: Record<ResolvedTheme, Record<string, string>> = {
  light: {
    background: "#111823",
    foreground: "#d7deea",
    cursor: "#7aa7e8",
    selectionBackground: "#355a87",
    black: "#111823",
    red: "#ff7b85",
    green: "#62d6a5",
    yellow: "#f4c66f",
    blue: "#83b4f2",
    magenta: "#cda2f2",
    cyan: "#76d6da",
    white: "#e6ebf2",
    brightBlack: "#8491a3",
  },
  dark: {
    background: "#0e1621",
    foreground: "#d8e0ec",
    cursor: "#8fc5f7",
    selectionBackground: "#294a70",
    black: "#0e1621",
    red: "#ff7f89",
    green: "#72d3a8",
    yellow: "#efc06f",
    blue: "#8fc5f7",
    magenta: "#caa0ef",
    cyan: "#7ad0da",
    white: "#e8edf4",
    brightBlack: "#8d99aa",
  },
};
