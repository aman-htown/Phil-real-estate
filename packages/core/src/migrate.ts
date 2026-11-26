/**
 * Applies SQL migrations from ./drizzle. Run with `npm run db:migrate`.
 * The worker also calls runMigrations() on boot when RUN_MIGRATIONS=true.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, getDb } from "./client";

export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runMigrations()
    .then(() => {
      console.log("Migrations applied.");
      return closeDb();
    })
    .catch(async (err) => {
      console.error(err);
      await closeDb();
      process.exit(1);
    });
}
