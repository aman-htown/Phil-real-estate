/**
 * Baileys auth state persisted in Postgres (table wa_auth_state), so the
 * WhatsApp Web link survives restarts and redeploys on hosts without a
 * persistent disk.
 */
import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from "baileys";
import { inArray, like, sql } from "drizzle-orm";
import { waAuthState, type Database } from "@phil/core";

const CREDS_KEY = "creds";

const encode = (value: unknown) => JSON.parse(JSON.stringify(value, BufferJSON.replacer));
const decode = <T>(value: unknown): T => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

export async function usePostgresAuthState(
  db: Database,
  namespace = "default",
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; clear: () => Promise<void> }> {
  const k = (key: string) => `${namespace}:${key}`;

  const [credsRow] = await db.select().from(waAuthState).where(inArray(waAuthState.key, [k(CREDS_KEY)]));
  const creds: AuthenticationCreds = credsRow ? decode(credsRow.value) : initAuthCreds();

  const upsert = async (rows: Array<{ key: string; value: unknown }>) => {
    if (!rows.length) return;
    await db
      .insert(waAuthState)
      .values(rows.map((r) => ({ key: r.key, value: encode(r.value) })))
      .onConflictDoUpdate({ target: waAuthState.key, set: { value: sql`excluded.value`, updatedAt: new Date() } });
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        if (!ids.length) return result;
        const rows = await db
          .select()
          .from(waAuthState)
          .where(inArray(waAuthState.key, ids.map((id) => k(`${type}-${id}`))));
        const byKey = new Map(rows.map((r) => [r.key, r.value]));
        for (const id of ids) {
          const raw = byKey.get(k(`${type}-${id}`));
          if (raw === undefined) continue;
          let value: any = decode(raw);
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          result[id] = value;
        }
        return result;
      },
      set: async (data) => {
        const toUpsert: Array<{ key: string; value: unknown }> = [];
        const toDelete: string[] = [];
        for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
          const entries = data[category] ?? {};
          for (const [id, value] of Object.entries(entries)) {
            const key = k(`${category}-${id}`);
            if (value) toUpsert.push({ key, value });
            else toDelete.push(key);
          }
        }
        await upsert(toUpsert);
        if (toDelete.length) await db.delete(waAuthState).where(inArray(waAuthState.key, toDelete));
      },
    },
  };

  return {
    state,
    saveCreds: () => upsert([{ key: k(CREDS_KEY), value: creds }]),
    clear: async () => {
      await db.delete(waAuthState).where(like(waAuthState.key, `${namespace}:%`));
    },
  };
}
