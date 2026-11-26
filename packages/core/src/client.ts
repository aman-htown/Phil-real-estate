import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

type Cached = { db: Database; sql: postgres.Sql };
const globalForDb = globalThis as unknown as { __philDb?: Cached };

export interface DbOptions {
  /** Max pool size. Serverless functions (Vercel) should use 1; the worker can use more. */
  max?: number;
}

/**
 * Returns a process-wide Drizzle client. Reads DATABASE_URL.
 *
 * On Vercel, point DATABASE_URL at a pooled connection string (Neon/Supabase
 * pooler, PgBouncer); prepared statements are disabled so transaction-mode
 * poolers work.
 */
export function getDb(options: DbOptions = {}): Database {
  if (globalForDb.__philDb) return globalForDb.__philDb.db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, {
    max: options.max ?? (process.env.VERCEL ? 1 : 10),
    prepare: false,
    idle_timeout: 20,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  globalForDb.__philDb = { db, sql };
  return db;
}

export async function closeDb(): Promise<void> {
  const cached = globalForDb.__philDb;
  if (!cached) return;
  globalForDb.__philDb = undefined;
  await cached.sql.end({ timeout: 5 });
}
