import fs from "node:fs";

/**
 * Loads KEY=value lines from a .env file into process.env, without
 * overriding variables that are already set. Missing file = no-op (in
 * production the host sets the variables). Works on every Node version,
 * unlike --env-file-if-exists / process.loadEnvFile.
 */
export function loadEnvFile(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  // Later lines win within the file (like dotenv); variables already set in the environment win overall.
  const parsed = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    parsed.set(m[1]!, value);
  }
  for (const [key, value] of parsed) {
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
  }
}
