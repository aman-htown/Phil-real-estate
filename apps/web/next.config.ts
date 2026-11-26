import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

const repoRoot = path.join(__dirname, "../..");
// Local development: read the shared .env at the repository root. No-op on Vercel.
loadEnvConfig(repoRoot);

const nextConfig: NextConfig = {
  // @phil/core ships TypeScript source; let Next compile it.
  transpilePackages: ["@phil/core"],
  // Monorepo: trace and resolve files from the repository root.
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
};

export default nextConfig;
