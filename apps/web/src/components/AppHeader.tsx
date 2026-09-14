"use client";

/**
 * The board strip.
 *
 * A dark board bar across the top — the one place in this light document that
 * inverts, because it is the fixed signage a coordinator glances at without
 * reading: where they are, when Baton last swept, and the two ways out (open the
 * agent's activity, or sign off).
 *
 * The admin UI is ONE page. So this navigation moves the reader within a
 * document rather than between routes: each item is an in-page anchor, and the
 * current item is marked from scroll position by an `IntersectionObserver`
 * rather than from a pathname. That is the whole reason this remains a client
 * component, along with the activity trigger, which dispatches a DOM event the
 * activity panel listens for rather than lifting a handler through the page.
 *
 * Why observe rather than read `location.hash`: a hash only changes when a link
 * is pressed, so scrolling with the wheel would leave the strip claiming a stop
 * the reader left three screens ago — a nav that lies about position is worse
 * than none.
 *
 * Sign-out is not a nav link but a real form posting the `signOut` server action
 * from the login stage — there is no account to revoke, only the one session
 * cookie to discard, so the control does exactly that and no more.
 */

import { useEffect, useState } from "react";
import { signOut } from "@/app/login/actions";

/** The DOM event the agent-activity panel listens for. Kept as a named export
 * so the panel stage binds to the same string rather than a copied literal. */
export const OPEN_ACTIVITY_EVENT = "baton:open-activity";

/**
 * The four stops of the single page, in document order. Exported so the page
 * itself renders its sections from the same list — a nav item pointing at an id
 * nothing renders is a dead link that no type would catch.
 */
export const STOPS = [
  { id: "continuity", label: "Continuity" },
  { id: "holdings", label: "Who holds what" },
  { id: "briefs", label: "Briefs" },
  { id: "set-aside", label: "Set aside" },
] as const;

export type StopId = (typeof STOPS)[number]["id"];

/**
 * The first and last stop, extracted once. `noUncheckedIndexedAccess` is on, so an
 * index into a tuple is `T | undefined` — and `STOPS` is a literal tuple whose ends
 * are known, so naming them is both cheaper and clearer than asserting at each use.
 */
const FIRST_STOP: StopId = "continuity";
const LAST_STOP: StopId = "set-aside";

export function AppHeader({ lastRunLabel }: { lastRunLabel: string }) {
  const current = useCurrentStop();

  function openActivity() {
    window.dispatchEvent(new CustomEvent(OPEN_ACTIVITY_EVENT));
  }

  return (
    <header className="board-strip flex items-center gap-6 px-6">
      {/* Identity + last-run stamp: the "where and when" a glance needs. */}
      <div className="flex items-baseline gap-3">
        <span
          className="board-type"
          style={{ fontSize: "var(--text-sub)", letterSpacing: "0.02em", lineHeight: 1 }}
        >
          Baton
        </span>
        <span
          className="board-type"
          style={{
            fontSize: "var(--text-meta)",
            color: "var(--color-ink-faint)",
            fontWeight: 500,
            letterSpacing: "0.04em",
          }}
        >
          {lastRunLabel}
        </span>
      </div>

      {/* In-page navigation across the four stops of the one page. */}
      <nav aria-label="Sections of this page" className="flex items-stretch self-stretch">
        <ul className="flex items-stretch gap-1">
          {STOPS.map((stop) => (
            <li key={stop.id} className="flex items-stretch">
              <a
                href={`#${stop.id}`}
                className="nav-stop"
                // `aria-current="true"` rather than "page": every stop is the
                // same page, and claiming otherwise would misdescribe the
                // document to a screen reader.
                aria-current={current === stop.id ? "true" : undefined}
              >
                {stop.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* Right cluster: agent activity + sign off. */}
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={openActivity}
          aria-haspopup="dialog"
          className="board-type"
          style={{
            display: "inline-flex",
            alignItems: "center",
            fontSize: "var(--text-meta)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            fontWeight: 600,
            color: "var(--color-board-ink)",
            border: "1px solid var(--color-rule-strong)",
            borderRadius: "2px",
            background: "transparent",
            padding: "0.25rem 0.625rem",
            cursor: "pointer",
          }}
        >
          Agent activity
        </button>

        <form action={signOut}>
          <button
            type="submit"
            className="board-type"
            style={{
              fontSize: "var(--text-meta)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontWeight: 600,
              color: "var(--color-ink-faint)",
              background: "transparent",
              border: "none",
              padding: "0.25rem 0.375rem",
              cursor: "pointer",
            }}
          >
            Sign off
          </button>
        </form>
      </div>
    </header>
  );
}

/**
 * Which stop the reader is in, from scroll position.
 *
 * A probe line sits just below the sticky strip; the current stop is the last one
 * whose top has passed it. That is deliberately not an `IntersectionObserver`: the
 * obvious observer form — shrink the root to a reading band and take the topmost
 * intersecting section — never marks the LAST stop, because a short final section
 * at the end of the document cannot scroll far enough to enter a band whose bottom
 * is 45% up the viewport. The nav then sat permanently one stop behind at the foot
 * of the page. A probe line has no such blind spot, and it needs one extra rule to
 * be complete: at the very bottom of the document the last stop is current, whether
 * or not its top ever cleared the line.
 *
 * Reading layout in a scroll handler is a forced synchronous layout, so the work is
 * deferred to an animation frame and coalesced — at most one measurement per frame
 * no matter how fast the wheel turns.
 */
function useCurrentStop(): StopId {
  const [current, setCurrent] = useState<StopId>(FIRST_STOP);

  useEffect(() => {
    let frame = 0;

    function measure() {
      frame = 0;

      const root = document.documentElement;

      // Within a few pixels of the end: the last stop owns the foot of the
      // document, which is the case a reading-band observer could never see.
      //
      // Both terms come from `documentElement` on purpose. Comparing
      // `window.innerHeight + scrollY` against `scrollHeight` looks equivalent and
      // is not: `innerHeight` includes the horizontal scrollbar gutter and
      // `scrollHeight` does not, so on a page with one the sum never reaches the
      // end and the last stop is never marked. `clientHeight` and `scrollHeight`
      // are measured the same way as each other, which is the property needed.
      const maxScroll = root.scrollHeight - root.clientHeight;
      if (window.scrollY >= maxScroll - 4) {
        setCurrent(LAST_STOP);
        return;
      }

      // The probe: the strip's height plus a small margin, so a heading counts as
      // reached once it is comfortably clear of the bar rather than under it.
      const probe = 72;
      let reached: StopId = FIRST_STOP;
      for (const stop of STOPS) {
        const node = document.getElementById(stop.id);
        if (!node) continue;
        if (node.getBoundingClientRect().top <= probe) reached = stop.id;
      }
      setCurrent(reached);
    }

    function onScroll() {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(measure);
    }

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return current;
}
