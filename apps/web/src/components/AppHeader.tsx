"use client";

/**
 * The board strip.
 *
 * A dark board bar across the top — the one place in this light document that
 * inverts, because it is the fixed signage a coordinator glances at without
 * reading: where they are, when Baton last swept, and the two ways out (open
 * the agent's activity, or sign off). It is a client component for two reasons:
 * the current section is marked from the pathname, and the activity trigger
 * dispatches a DOM event the activity panel listens for rather than lifting a
 * handler through the page.
 *
 * Sign-out is not a nav link but a real form posting the `signOut` server
 * action from the login stage — there is no account to revoke, only the one
 * session cookie to discard, so the control does exactly that and no more.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/app/login/actions";

/** The DOM event the agent-activity panel listens for. Kept as a named export
 * so the panel stage binds to the same string rather than a copied literal. */
export const OPEN_ACTIVITY_EVENT = "baton:open-activity";

const NAV: readonly { href: string; label: string }[] = [
  { href: "/", label: "Continuity" },
  { href: "/holdings", label: "Who holds what" },
  { href: "/briefs", label: "Briefs" },
];

function isCurrent(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppHeader({ lastRunLabel }: { lastRunLabel: string }) {
  const pathname = usePathname();

  function openActivity() {
    window.dispatchEvent(new CustomEvent(OPEN_ACTIVITY_EVENT));
  }

  return (
    <header
      className="flex items-center gap-6 px-6"
      style={{
        background: "var(--color-board)",
        color: "var(--color-board-ink)",
        borderBottom: "1px solid var(--color-board)",
        minHeight: "3rem",
      }}
    >
      {/* Identity + last-run stamp: the "where and when" a glance needs. */}
      <div className="flex items-baseline gap-3">
        <span
          className="board-type"
          style={{ fontSize: "var(--text-sub)", letterSpacing: "0.02em" }}
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

      {/* Primary navigation across the three surfaces. */}
      <nav aria-label="Primary" className="flex items-stretch self-stretch">
        <ul className="flex items-stretch gap-1">
          {NAV.map((item) => {
            const current = isCurrent(pathname, item.href);
            return (
              <li key={item.href} className="flex items-stretch">
                <Link
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  className="board-type flex items-center px-3"
                  style={{
                    fontSize: "var(--text-meta)",
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    fontWeight: 600,
                    color: current ? "#fff" : "var(--color-board-ink)",
                    // The one signage blue, spent on current selection.
                    borderBottom: current
                      ? "2px solid var(--color-signal)"
                      : "2px solid transparent",
                  }}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
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
