"use client";

/**
 * The gate — the first frame anyone sees, before a single row of data.
 *
 * It carries the whole visual world at full strength with nothing competing: the
 * newsprint ground, one sheet, condensed board lettering, and the single signage
 * blue spent on the one primary action. No signup, no forgot-password, no social
 * buttons — the product has one shared passcode and no user table, so offering
 * any of those would describe a product that does not exist.
 *
 * Five states, all rendered here: idle, submitting, wrong passcode, rate-limited
 * with the wait time, and an expired-session notice when arriving with ?expired=1.
 */

import { Suspense, useActionState } from "react";
import { useFormStatus } from "react-dom";
import { useSearchParams } from "next/navigation";
import { login, type LoginResult } from "./actions";

const INITIAL: LoginResult = { status: "idle" };

export default function LoginPage() {
  return (
    <main className="min-h-screen grid place-items-center px-6 py-16">
      {/* Suspense: useSearchParams reads the request URL and must not block the
          static shell. The fallback is the same gate without the expiry note. */}
      <Suspense fallback={<Gate expired={false} />}>
        <GateWithSearchParams />
      </Suspense>
    </main>
  );
}

function GateWithSearchParams() {
  const params = useSearchParams();
  return <Gate expired={params.get("expired") === "1"} />;
}

function Gate({ expired }: { expired: boolean }) {
  const [result, formAction] = useActionState(login, INITIAL);

  const invalid = result.status === "invalid";
  const rateLimited = result.status === "rate_limited";

  // The live region announces the single most urgent condition, in priority
  // order: a lock-out outranks a wrong code, which outranks a stale session.
  const notice = rateLimited
    ? `Too many attempts. Try again in ${formatWait(result.retryAfterSeconds)}.`
    : invalid
      ? "That passcode was not recognised."
      : expired
        ? "Your session expired. Sign in to continue."
        : null;

  const noticeTone = rateLimited || invalid ? "held" : "muted";

  return (
    <section className="sheet w-full max-w-sm px-8 py-9" aria-labelledby="gate-title">
      <p className="eyebrow">Continuity risk register</p>
      <h1 id="gate-title" className="board-type text-head mt-1 leading-none">
        Baton
      </h1>
      <p className="text-dense text-ink-muted mt-3 max-w-prose">
        The standing record of what your group knows and who alone holds it, read
        from the one chat that holds its history.
      </p>

      <hr className="border-0 border-t border-rule my-6" />

      <form action={formAction} className="grid gap-4" noValidate>
        <div className="grid gap-2">
          <label htmlFor="passcode" className="eyebrow">
            Passcode
          </label>
          <input
            id="passcode"
            name="passcode"
            type="password"
            inputMode="text"
            autoComplete="current-password"
            autoFocus
            required
            className="field"
            placeholder="••••••••"
            aria-invalid={invalid || rateLimited}
            aria-describedby={notice ? "gate-notice" : undefined}
            style={
              invalid || rateLimited
                ? { borderColor: "var(--color-status-held)" }
                : undefined
            }
          />
        </div>

        <Submit disabled={rateLimited} />
      </form>

      {/* Reserve the notice line so its appearance shifts nothing — an empty
          state here is the good news, and the layout should not flinch. */}
      <div
        id="gate-notice"
        role="status"
        aria-live="polite"
        className="text-meta mt-4 min-h-[1.25rem]"
        style={{
          color:
            noticeTone === "held"
              ? "var(--color-status-held)"
              : "var(--color-ink-faint)",
        }}
      >
        {notice}
      </div>
    </section>
  );
}

/**
 * The primary action, and the fourth of the five states. `useFormStatus` reads
 * the pending status of the enclosing form, so the button can be its own
 * loading indicator without the page holding submission state.
 */
function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending || disabled}>
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

/** Whole minutes read more calmly than a bare second count on a lock-out. */
function formatWait(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
