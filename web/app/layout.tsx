import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

const themeBootstrap = `
(() => {
  const preference = "__SERVICE_CONSOLE_THEME__";
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = preference === "dark" || (preference === "system" && systemDark)
    ? "dark"
    : "light";
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector("#themeColorMeta")?.setAttribute(
    "content",
    theme === "dark" ? "#0d131d" : "#f4f6f8",
  );
})();
`;

export const metadata: Metadata = {
  title: "Service Console",
  description: "本地进程与日志控制台",
  icons: {
    icon: "/static/favicon.svg",
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN" data-theme-preference="system" suppressHydrationWarning>
      <head>
        <meta id="themeColorMeta" name="theme-color" content="#f4f6f8" />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
