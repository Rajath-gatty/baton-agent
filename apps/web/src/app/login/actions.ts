"use server";

/**
 * The login action and its inverse.
 *
 * A discriminated result rather than thrown errors: the form is a client
 * component that must render five distinct states, and a tagged union lets it
 * switch on `status` exhaustively instead of guessing from a string message.
 */

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  checkPasscode,
  createSession,
  rateLimit,
} from "@/lib/session";

export type LoginResult =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "rate_limited"; retryAfterSeconds: number };

/**
 * Best-effort client IP for the rate limiter. Behind a proxy the forwarded
 * header is the real client; the leftmost entry is the origin. When nothing is
 * present every caller collapses to one shared bucket, which fails safe — it
 * throttles harder, never softer.
 */
async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip") ?? "unknown";
}

export async function login(_prev: LoginResult, formData: FormData): Promise<LoginResult> {
  const limit = rateLimit(await clientIp());
  if (!limit.ok) {
    return { status: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds };
  }

  // Read as a value that is always a string; never log or echo it.
  const passcode = formData.get("passcode");
  const input = typeof passcode === "string" ? passcode : "";

  if (!checkPasscode(input)) {
    return { status: "invalid" };
  }

  const token = await createSession();
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  redirect("/");
}

/**
 * Sign out. Deleting the cookie and sending the coordinator back to the gate —
 * there is no account to revoke, only this one proof to discard.
 */
export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
