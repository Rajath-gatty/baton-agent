/**
 * The quiet strip — restraint made visible.
 *
 * This is the product's signature and the reason it is not a monitoring tool.
 * Most registers show only what they raised; Baton shows, on the same sheet and
 * with equal weight, what it deliberately did *not* raise, and why. So the strip
 * is expanded by default and sits at the foot of the register rather than folded
 * behind a toggle — hiding it would hide the one thing that distinguishes the
 * product.
 *
 * Reasoning is scoped `item` or `org` and, by contract, is never about a person:
 * it explains a decision about an item on the sheet or about how the register
 * behaves, not about a volunteer.
 *
 * A server component — it only reads and renders; there is no interaction here
 * beyond the link out to the full list.
 */

import Link from "next/link";
import type { QuietDecision } from "@/lib/types";
import { formatRelativeAge } from "@/lib/format";
import { Eyebrow } from "@/components/primitives";

const SCOPE_LABEL: Record<QuietDecision["scope"], string> = {
  item: "This item",
  org: "The register",
};

export function QuietStrip({ decisions }: { decisions: QuietDecision[] }) {
  return (
    <section
      aria-labelledby="quiet-heading"
      style={{
        borderTop: "2px solid var(--color-rule-strong)",
        background: "var(--color-sheet-alt)",
      }}
    >
      <div className="flex items-baseline justify-between px-6 pt-3 pb-1">
        <div className="flex items-baseline gap-3">
          <Eyebrow>What Baton held back</Eyebrow>
          <span
            style={{ fontSize: "var(--text-meta)", color: "var(--color-ink-faint)" }}
          >
            Recorded on purpose, shown next to what it raised
          </span>
        </div>
        <Link
          href="/quiet"
          className="board-type"
          style={{
            fontSize: "var(--text-meta)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            fontWeight: 600,
            color: "var(--color-signal)",
            textDecoration: "none",
          }}
        >
          All quiet decisions →
        </Link>
      </div>

      {decisions.length === 0 ? (
        // Good news, not a blank: nothing withheld this pass.
        <p className="px-6 pb-3" style={{ fontSize: "var(--text-dense)", color: "var(--color-ink-muted)" }}>
          Nothing was held back this pass — everything the register found is on the
          sheet above.
        </p>
      ) : (
        <ul className="px-6 pb-3">
          {decisions.map((decision) => (
            <li
              key={decision.id}
              className="grid items-baseline"
              style={{
                gridTemplateColumns: "minmax(0, 1fr) 7.5rem 6rem",
                columnGap: "1rem",
                borderTop: "1px solid var(--color-rule)",
                paddingTop: "0.375rem",
                paddingBottom: "0.375rem",
              }}
            >
              <div className="min-w-0">
                <p
                  style={{
                    fontSize: "var(--text-dense)",
                    color: "var(--color-ink)",
                    fontWeight: 500,
                  }}
                >
                  {decision.summary}
                </p>
                <p
                  style={{
                    fontSize: "var(--text-meta)",
                    color: "var(--color-ink-muted)",
                    marginTop: "0.125rem",
                    lineHeight: 1.4,
                  }}
                >
                  {decision.reasoning}
                </p>
              </div>
              <span
                className="board-type self-center"
                style={{
                  fontSize: "var(--text-label)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  fontWeight: 600,
                  color: "var(--color-ink-faint)",
                }}
              >
                {SCOPE_LABEL[decision.scope]}
              </span>
              <span
                className="self-center"
                style={{
                  fontSize: "var(--text-meta)",
                  color: "var(--color-ink-faint)",
                  textAlign: "right",
                }}
              >
                {formatRelativeAge(decision.decidedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
