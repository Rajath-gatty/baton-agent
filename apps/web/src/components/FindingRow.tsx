"use client";

/**
 * One finding, as a ruled chart row — not a padded card.
 *
 * The card was rejected on purpose: seven findings, the state line and the
 * quiet strip all have to sit inside a 1440×900 first viewport, and cards would
 * push the strip below the fold. So a finding is a dense CSS-grid row on a
 * hairline rule, the same visual grammar as a reservation chart.
 *
 * The hierarchy inside the row is deliberate and is the product's third truth
 * made structural: the capability is the subject and reads large; the holder is
 * a small trailing attribute. Promoting the holder — bolding a name, giving it
 * the headline slot — would make the row about a person, which Baton never is.
 * A finding says a capability has been *seen* in one pair of hands; it never
 * says a person is the only one who *can*.
 *
 * Actions run through a transition so each button carries all seven states: it
 * disables and reads "Working…" while its own action is in flight, disables its
 * siblings so two writes cannot race, and surfaces a failure inline rather than
 * throwing. The finding stays in place until the server action revalidates and
 * the register re-reads without it.
 */

import { useState, useTransition } from "react";
import type { Finding } from "@/lib/types";
import { severityLabel, subtypeLabel } from "@/lib/format";
import { Claim, Confidence } from "@/components/primitives";
import {
  dismissFinding,
  markHasBackup,
  resolveFinding,
  type FindingActionResult,
} from "@/app/actions";

/**
 * A finding's title opens the fact behind it — but only when there is a fact to
 * open. Findings key off assets (`sole_holder:a-insta-login`) or facts
 * (`loose_end:f-80g`); the fact panel takes a fact id, so the title is a `Claim`
 * only when the dedupe key names an `f-`-prefixed fact, and plain text
 * otherwise. Guessing an asset id into the fact panel would open the wrong
 * thing, which is worse than not opening at all.
 */
function factIdFromDedupeKey(dedupeKey: string): string | null {
  const target = dedupeKey.split(":")[1];
  if (target && target.startsWith("f-")) return target;
  return null;
}

/** The shared column template — one grid so every row's columns line up. */
const GRID_TEMPLATE =
  "minmax(0, 1fr) 9.5rem 3.25rem 4.5rem 11.5rem";

type PendingAction = "resolve" | "backup" | "dismiss" | null;

export function FindingRow({ finding }: { finding: Finding }) {
  const [pending, startTransition] = useTransition();
  const [active, setActive] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);

  const factId = factIdFromDedupeKey(finding.dedupeKey);
  const busy = pending;

  function run(which: Exclude<PendingAction, null>, fn: () => Promise<FindingActionResult>) {
    setError(null);
    setActive(which);
    startTransition(async () => {
      const result = await fn();
      if (result.status === "error") setError(result.message);
      setActive(null);
    });
  }

  const evidenceLabel = `${finding.evidenceCount} ${
    finding.evidenceCount === 1 ? "message" : "messages"
  }`;

  return (
    <li
      className="chart-row px-6"
      style={{
        gridTemplateColumns: GRID_TEMPLATE,
        columnGap: "1rem",
        paddingTop: "0.4375rem",
        paddingBottom: "0.4375rem",
      }}
    >
      {/* Subject column: the capability, then the one line of why-it-matters,
          then the small trailing attributes (evidence + holder). */}
      <div className="min-w-0">
        <h3
          className="board-type"
          style={{
            fontSize: "var(--text-lead)",
            fontWeight: 600,
            lineHeight: 1.25,
            color: "var(--color-ink)",
          }}
        >
          {factId ? (
            <Claim factId={factId}>{finding.title}</Claim>
          ) : (
            finding.title
          )}
        </h3>
        <p
          title={finding.whyItMatters}
          style={{
            fontSize: "var(--text-dense)",
            color: "var(--color-ink-muted)",
            marginTop: "0.125rem",
            lineHeight: 1.35,
            display: "-webkit-box",
            WebkitLineClamp: 1,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {finding.whyItMatters}
        </p>
        <p
          style={{
            fontSize: "var(--text-meta)",
            color: "var(--color-ink-faint)",
            marginTop: "0.1875rem",
          }}
        >
          {/* Evidence count is the clickable thread to provenance when a fact
              backs it; otherwise a plain count. */}
          {factId ? (
            <Claim factId={factId}>{evidenceLabel}</Claim>
          ) : (
            <span>{evidenceLabel}</span>
          )}
          {/* Holder as a small attribute — never the subject. */}
          {finding.holderName ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>
                seen held by{" "}
                <span style={{ color: "var(--color-ink-muted)" }}>{finding.holderName}</span>
              </span>
            </>
          ) : (
            <>
              <span aria-hidden="true"> · </span>
              <span>no one seen holding it</span>
            </>
          )}
        </p>
      </div>

      {/* Subtype badge, in the product's plain vocabulary. */}
      <div className="self-center">
        <span
          className="board-type"
          style={{
            display: "inline-block",
            fontSize: "var(--text-label)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            fontWeight: 600,
            color: "var(--color-ink-muted)",
            border: "1px solid var(--color-rule-strong)",
            borderRadius: "1px",
            padding: "0.0625rem 0.375rem",
          }}
        >
          {subtypeLabel(finding.subtype)}
        </span>
      </div>

      {/* Severity, quiet — a word, not a red chip. */}
      <div
        className="self-center board-type"
        style={{
          fontSize: "var(--text-meta)",
          letterSpacing: "0.04em",
          color: "var(--color-ink-muted)",
        }}
      >
        {severityLabel(finding.severity)}
      </div>

      {/* Confidence as the hairline meter primitive. */}
      <div className="self-center">
        <Confidence value={finding.confidence} />
      </div>

      {/* Actions column: three controls, all seven states via the transition. */}
      <div className="flex flex-col items-end gap-1 self-center">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            aria-busy={active === "resolve"}
            onClick={() => run("resolve", () => resolveFinding(finding.id))}
          >
            {active === "resolve" ? "Working…" : "Resolve"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            aria-busy={active === "backup"}
            onClick={() => run("backup", () => markHasBackup(finding.id))}
          >
            {active === "backup" ? "Working…" : "Have a backup"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            aria-busy={active === "dismiss"}
            onClick={() => run("dismiss", () => dismissFinding(finding.id))}
          >
            {active === "dismiss" ? "Working…" : "Dismiss"}
          </button>
        </div>
        {error ? (
          <p
            role="alert"
            style={{
              fontSize: "var(--text-label)",
              color: "var(--color-status-held)",
              textAlign: "right",
            }}
          >
            {error}
          </p>
        ) : null}
      </div>
    </li>
  );
}
