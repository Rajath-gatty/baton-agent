"use client";

/**
 * Presentational primitives. No data fetching lives here.
 *
 * The module is a client module because of `Claim`, the shared provenance
 * control: it dispatches a DOM event the fact panel listens for, which needs
 * the browser. The other primitives are pure and render identically on the
 * server; grouping them here keeps the product's small vocabulary of parts in
 * one file, which is the point of a primitives module.
 */

import type { ReactNode } from "react";
import type { FactStatus } from "@baton/core";
import { formatConfidence } from "@/lib/format";

// ── Sheet ──────────────────────────────────────────────────────────────────

/** The ledger sheet every surface sits on. */
export function Sheet({
  children,
  className,
  as: Tag = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return <Tag className={`sheet${className ? ` ${className}` : ""}`}>{children}</Tag>;
}

// ── Eyebrow ──────────────────────────────────────────────────────────────

/** A small condensed uppercase label above a block. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

// ── StatusCode ─────────────────────────────────────────────────────────────

/**
 * A fact's status as a tabular code, in the product's own five-state
 * vocabulary. The four colour classes map to the register's states; a fact that
 * is neither superseded, retired, unverified nor held reads as active.
 */
const STATUS_CODE: Record<FactStatus, { label: string; className: string }> = {
  active: { label: "ACTIVE", className: "code-active" },
  unverified: { label: "UNVERIF", className: "code-unverified" },
  pending_approval: { label: "HELD", className: "code-held" },
  superseded: { label: "SUPERSD", className: "code-closed" },
  retired: { label: "RETIRED", className: "code-closed" },
};

export function StatusCode({ status }: { status: FactStatus }) {
  const { label, className } = STATUS_CODE[status];
  return (
    <span className={`code ${className}`} aria-label={`Status: ${label}`}>
      {label}
    </span>
  );
}

// ── Confidence ─────────────────────────────────────────────────────────────

/**
 * A small hairline meter for the assessor's confidence — five ticks that fill
 * from the left, not a percentage-as-progress-bar. The exact figure is exposed
 * to assistive tech and to the pointer via the title, so the reading is
 * available without the cliché.
 */
export function Confidence({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(clamped * 5);
  const label = `Confidence ${formatConfidence(clamped)}`;
  return (
    <span
      className="inline-flex items-center gap-[2px] align-middle"
      role="img"
      aria-label={label}
      title={label}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className="block h-[0.5rem] w-[3px]"
          style={{
            backgroundColor:
              i < filled ? "var(--color-signal)" : "var(--color-rule-strong)",
          }}
        />
      ))}
    </span>
  );
}

// ── Claim ────────────────────────────────────────────────────────────────

/** The custom event the fact panel listens for. */
export const OPEN_FACT_EVENT = "baton:open-fact";

/** The detail carried by {@link OPEN_FACT_EVENT}. */
export interface OpenFactDetail {
  factId: string;
}

/**
 * The shared provenance control. Every claim anywhere in the product is a
 * `Claim`: pressing it opens the fact detail panel by dispatching a DOM event
 * the panel stage listens for, so provenance is one gesture from any surface
 * without prop-drilling a handler through every page.
 */
export function Claim({
  factId,
  children,
  className,
}: {
  factId: string;
  children: ReactNode;
  className?: string;
}) {
  function open() {
    const detail: OpenFactDetail = { factId };
    window.dispatchEvent(new CustomEvent<OpenFactDetail>(OPEN_FACT_EVENT, { detail }));
  }

  return (
    <button
      type="button"
      className={`claim${className ? ` ${className}` : ""}`}
      onClick={open}
      aria-haspopup="dialog"
    >
      {children}
    </button>
  );
}
