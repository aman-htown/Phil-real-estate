/**
 * Side-effect import: loads the repository-root .env so one file configures
 * local development for the worker and the migration script.
 * Import it before anything that reads process.env.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./env-file";

loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env"));
