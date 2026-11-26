import { z } from "zod";
import { NextResponse } from "next/server";
import { checkPassword, createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth";
import { handler, HttpError, parseBody } from "@/lib/server";

const Body = z.object({ name: z.string().trim().min(1).max(60), password: z.string().min(1) });

export const POST = handler(async (req: Request) => {
  const { name, password } = await parseBody(req, Body);
  if (!checkPassword(password)) throw new HttpError(401, "Wrong password");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(name), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
});
