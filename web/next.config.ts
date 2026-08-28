import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default function createNextConfig(phase: string): NextConfig {
  const development = phase === PHASE_DEVELOPMENT_SERVER;

  return {
    assetPrefix: development ? undefined : "/static",
    generateBuildId: async () => "service-console-static",
    images: {
      unoptimized: true,
    },
    output: "export",
    poweredByHeader: false,
    reactStrictMode: true,
  };
}
