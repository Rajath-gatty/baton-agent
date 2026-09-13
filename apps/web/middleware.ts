/**
 * The perimeter.
 *
 * Every page and every API route is behind the gate; only the gate itself and
 * the static shell are open. The distinction that matters to the coordinator:
 * arriving with no cookie is simply "not signed in", while arriving with a
 * cookie that no longer verifies is "your session expired" — a different, gentler
 * message, so ?expired=1 is set only in the second case.
 *
 * This runs in the Edge runtime, so it verifies the token with `jose` directly
 * rather than importing the app's `session` module — that module is marked
 * `server-only` and would throw here. The cookie name, algorithm and secret are
 * kept in step with it by hand; both are one line.
 */

import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "baton_session";

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "SESSION_SECRET is missing or too short (need at least 16 characters).",
    );
  }
  return new TextEncoder().encode(secret);
}

async function isValid(token: string): Promise<boolean> {
  if (token.length === 0) return false;
  try {
    await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;

  if (token && (await isValid(token))) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  // A present-but-invalid cookie means the session lapsed; distinguish it so the
  // gate can say so, and clear the stale cookie on the way out.
  if (token) {
    url.searchParams.set("expired", "1");
  }

  const response = NextResponse.redirect(url);
  if (token) {
    response.cookies.delete(SESSION_COOKIE);
  }
  return response;
}

/**
 * Match everything except the gate, Next's internals, and static assets. The
 * negative lookahead keeps /login open (and its own asset requests), lets the
 * framework serve /_next, and skips the common static file extensions and
 * favicon so the perimeter never redirects a stylesheet.
 */
export const config = {
  matcher: [
    "/((?!login|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2|ttf|map)$).*)",
  ],
};
