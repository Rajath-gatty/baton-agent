/**
 * Briefs — what changed about the organisation's exposure. The third stop.
 *
 * A brief is produced by a membership or lifecycle event: someone stepped back,
 * someone arrived, a quarter closed. It says, in three fixed sections and in this
 * order, what the organisation is newly exposed to. The sections are fixed by
 * core's `BRIEF_SECTIONS` and never reordered:
 *
 *   1. only_they_held    — capabilities that had rested with that one hand
 *   2. they_had_promised — commitments that were left open
 *   3. nobody_else_seen  — where no second person has been seen doing the thing
 *
 * Every line is phrased about a capability or a commitment, never about a person.
 * "Nobody else has been seen" is a statement about the record, not a judgement
 * that nobody else *could*.
 *
 * A server component reading the seam's result; the interactive brief body — copy,
 * per-line filing, and the offer to the brief's subject — is a client island so
 * the reads stay on the server.
 */

import type { Brief } from "@/lib/types";
import { Eyebrow } from "@/components/primitives";
import { BriefCard } from "@/components/BriefCard";

export function BriefsSection({ briefs }: { briefs: Brief[] }) {
  const current = briefs[0] ?? null;
  const past = briefs.slice(1);

  return (
    <section id="briefs" className="stop" aria-labelledby="briefs-heading">
      <div className="stop-head">
        <div>
          <Eyebrow>Exposure at a change</Eyebrow>
          <h2
            id="briefs-heading"
            className="board-type mt-1 leading-none"
            style={{ fontSize: "var(--text-head)" }}
          >
            Briefs
          </h2>
        </div>
        <p
          className="max-w-prose text-right"
          style={{ fontSize: "var(--text-dense)", color: "var(--color-ink-muted)" }}
        >
          When a volunteer steps back or arrives, Baton writes down what that leaves the
          organisation relying on. Each line traces to the fact it rests on, and can be filed
          without anyone being messaged.
        </p>
      </div>

      {current === null ? (
        <EmptyBriefs />
      ) : (
        <div className="grid gap-8" style={{ maxWidth: "56rem" }}>
          <section aria-labelledby="current-brief">
            <h3 id="current-brief" className="eyebrow mb-2">
              Current brief
            </h3>
            <BriefCard brief={current} current />
          </section>

          {past.length > 0 ? (
            <section aria-labelledby="past-briefs">
              <h3 id="past-briefs" className="eyebrow mb-2">
                Earlier briefs
              </h3>
              <div className="grid gap-6">
                {past.map((brief) => (
                  <BriefCard key={brief.id} brief={brief} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** No briefs is good news: nothing has changed the organisation's exposure. */
function EmptyBriefs() {
  return (
    <section className="sheet px-6 py-8" style={{ maxWidth: "56rem" }}>
      <p style={{ color: "var(--color-ink)" }}>
        No briefs yet. Nothing has changed hands and no period has closed, so the
        organisation&apos;s exposure stands as the register already shows it.
      </p>
    </section>
  );
}
