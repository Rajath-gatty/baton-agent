/**
 * The quiet strip — restraint made visible.
 *
 * This is the product's signature and the reason it is not a monitoring tool. Most
 * registers show only what they raised; Baton shows, on the same sheet and with
 * equal weight, what it deliberately did *not* raise, and why. So the strip is
 * expanded by default and sits at the foot of the register rather than folded behind
 * a toggle — hiding it would hide the one thing that distinguishes the product.
 *
 * It is a strip, and that word is doing work. Each decision is ONE line: what was
 * withheld, then its reason, clamped. The stacked two-line form it replaced was 253
 * pixels tall for three decisions and pushed itself clean out of the first viewport,
 * which is the one place it has to be — an invisible statement of restraint makes
 * the same claim as no statement at all. The full reasoning is a scroll away in
 * `Set aside`, and every word of it is there.
 *
 * Reasoning is scoped `item` or `org` and, by contract, is never about a person: it
 * explains a decision about an item on the sheet or about how the register behaves,
 * not about a volunteer.
 *
 * The two links out live here rather than in a footer of their own, because a
 * separate footer row cost 30 pixels of the same budget to say two words.
 *
 * A server component — it only reads and renders.
 */

import type { QuietDecision } from "@/lib/types";
import { formatRelativeAge } from "@/lib/format";
import { Eyebrow } from "@/components/primitives";

const SCOPE_LABEL: Record<QuietDecision["scope"], string> = {
  item: "This item",
  org: "The register",
};

/** The two anchors out of the strip, into the folded lists on the same page. */
const LINK_STYLE = {
  fontSize: "var(--text-meta)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  fontWeight: 600,
  textDecoration: "none",
} as const;

export function QuietStrip({ decisions }: { decisions: QuietDecision[] }) {
  return (
    <section
      aria-labelledby="quiet-heading"
      style={{
        borderTop: "2px solid var(--color-rule-strong)",
        background: "var(--color-sheet-alt)",
      }}
    >
      <div className="flex items-baseline justify-between gap-4 px-6 pt-2 pb-1">
        <div className="flex items-baseline gap-3">
          <h3 id="quiet-heading">
            <Eyebrow>What Baton held back</Eyebrow>
          </h3>
          <span style={{ fontSize: "var(--text-meta)", color: "var(--color-ink-faint)" }}>
            Recorded on purpose, shown next to what it raised
          </span>
        </div>
        <div className="flex items-baseline gap-4">
          <a
            href="#dismissed"
            className="board-type"
            style={{ ...LINK_STYLE, color: "var(--color-ink-muted)" }}
          >
            Dismissed →
          </a>
          <a
            href="#quiet-decisions"
            className="board-type"
            style={{ ...LINK_STYLE, color: "var(--color-signal)" }}
          >
            All quiet decisions →
          </a>
        </div>
      </div>

      {decisions.length === 0 ? (
        // Good news, not a blank: nothing withheld this pass.
        <p
          className="px-6 pb-2"
          style={{ fontSize: "var(--text-dense)", color: "var(--color-ink-muted)" }}
        >
          Nothing was held back this pass — everything the register found is on the sheet above.
        </p>
      ) : (
        <ul className="px-6 pb-2">
          {decisions.map((decision) => (
            <li
              key={decision.id}
              className="grid items-baseline"
              style={{
                gridTemplateColumns: "minmax(0, 1fr) 6.5rem 5rem",
                columnGap: "1rem",
                borderTop: "1px solid var(--color-rule)",
                paddingTop: "0.25rem",
                paddingBottom: "0.25rem",
              }}
            >
              {/* One line: the decision, then its reason. The full reason is in the
                  Set aside list; the title attribute carries it here too, so a
                  pointer reveals it without a scroll. */}
              <p
                title={`${decision.summary} — ${decision.reasoning}`}
                className="min-w-0"
                style={{
                  fontSize: "var(--text-dense)",
                  lineHeight: 1.3,
                  display: "-webkit-box",
                  WebkitLineClamp: 1,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                <span style={{ color: "var(--color-ink)", fontWeight: 500 }}>
                  {decision.summary}
                </span>{" "}
                <span style={{ color: "var(--color-ink-muted)" }}>{decision.reasoning}</span>
              </p>
              <span
                className="board-type"
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
