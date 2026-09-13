/**
 * The gate's plumbing.
 *
 * Baton has one human user and no user table — the direction contract forbids
 * signup, roles and password reset because none of them exist in the product.
 * So the whole notion of "identity" collapses to a single shared passcode and a
 * signed session cookie proving that passcode was once presented. `jose` is the
 * only dependency this needs; no auth provider is introduced.
 */

import "server-only";
import { SignJWT, jwtVerify } from "jose";

/** The session cookie name, referenced by both the action and the middleware. */
export const SESSION_COOKIE = "baton_session";

/** Seven days, in seconds. The token lifetime and the cookie maxAge share it. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * The signing secret, read once. Absent config is a deployment fault, not a
 * runtime branch to paper over — a gate signed with an empty key is no gate, so
 * fail loudly at module load rather than mint forgeable sessions in silence.
 */
function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "SESSION_SECRET is missing or too short (need at least 16 characters).",
    );
  }
  return new TextEncoder().encode(secret);
}

/**
 * Sign a session token. The payload carries nothing about a person — there is
 * no person to carry — only that a valid passcode was presented and when.
 */
export async function createSession(): Promise<string> {
  return new SignJWT({ gate: "baton" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

/**
 * Verify a session token. Returns a plain boolean: the middleware only needs to
 * know whether to let the request through, and any failure — expired, tampered,
 * wrong algorithm — is the same answer, no.
 */
export async function verifySession(token: string): Promise<boolean> {
  if (token.length === 0) return false;
  try {
    await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison of the presented passcode against `ADMIN_PASSCODE`.
 *
 * Length is guarded first because it is public information (the comparison loop
 * would leak it anyway) and lets the loop run over a fixed span. The input is
 * never logged, interpolated into an error, or returned — a passcode that
 * reaches a log file is a passcode leaked.
 */
export function checkPasscode(input: string): boolean {
  const expected = process.env.ADMIN_PASSCODE;
  if (!expected || expected.length < 8) {
    throw new Error("ADMIN_PASSCODE is missing or too short (need at least 8 characters).");
  }

  if (input.length !== expected.length) return false;

  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    // Indices are in range by the length guard above; charCodeAt on an
    // out-of-range index would return NaN, so the guard is load-bearing.
    mismatch |= input.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * In-memory attempt limiter, keyed by client IP: at most 8 attempts per rolling
 * 10-minute window.
 *
 * Deliberately per-instance — it lives in this module's memory and resets on
 * redeploy or scale-out. For Baton's single-container deployment with one human
 * user that is acceptable; a shared store would be more machinery than the
 * threat (one coordinator, one shared passcode) warrants.
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export function rateLimit(ip: string): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(ip);

  if (!existing || now >= existing.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true };
  }

  if (existing.count >= MAX_ATTEMPTS) {
    return { ok: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
  }

  existing.count += 1;
  return { ok: true };
}
