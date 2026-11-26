/**
 * Minimal single-team auth: everyone shares ADMIN_PASSWORD and enters their
 * name, which is recorded on messages they send. Sessions are HMAC-signed
 * cookies (AUTH_SECRET). Swap for Auth.js / Clerk if you need per-user accounts.
 */
export const SESSION_COOKIE = "inbox_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface Session {
  name: string;
  exp: number;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 16) throw new Error("AUTH_SECRET must be set (at least 16 characters)");
  return value;
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(name: string): Promise<string> {
  const session: Session = { name, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const payload = b64url(enc.encode(JSON.stringify(session)));
  return `${payload}.${await hmac(payload)}`;
}

export async function verifySessionToken(token: string | undefined | null): Promise<Session | null> {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    if (!safeEqual(sig, await hmac(payload))) return null;
    const session = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Session;
    if (typeof session.name !== "string" || session.exp < Date.now() / 1000) return null;
    return session;
  } catch {
    return null;
  }
}

export function checkPassword(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new Error("ADMIN_PASSWORD is not configured");
  return safeEqual(password, expected);
}
