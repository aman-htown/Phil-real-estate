import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

const repoRoot = path.join(__dirname, "../..");

// Local development: read the shared .env at the repository root (Next.js only
// reads .env files in apps/web). Existing variables win; no-op on Vercel.
try {
  for (const line of fs.readFileSync(path.join(repoRoot, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const value = /^(['"]).*\1$/.test(m[2]!) ? m[2]!.slice(1, -1) : m[2]!.replace(/\s+#.*$/, "");
    if (!process.env[m[1]!]) process.env[m[1]!] = value;
  }
} catch {
  // no root .env
}

const nextConfig: NextConfig = {
  // @phil/core ships TypeScript source; let Next compile it.
  transpilePackages: ["@phil/core"],
  // Monorepo: trace and resolve files from the repository root.
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
};

export default nextConfig;
