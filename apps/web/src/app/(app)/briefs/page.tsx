/**
 * Briefs — what changed about the organisation's exposure.
 *
 * A brief is produced by a membership or lifecycle event: someone stepped back,
 * a quarter closed. It says, in three fixed sections and in this order, what the
 * organisation is newly exposed to. The sections are fixed by core's
 * `BRIEF_SECTIONS` and never reordered:
 *
 *   1. only_they_held    — capabilities that had rested with the departing hand
 *   2. they_had_promised — commitments that were left open
 *   3. nobody_else_seen  — where no second person has been seen doing the thing
 *
 * Every line is phrased about a capability or a commitment, never about a
 * person. "Nobody else has been seen" is a statement about the record, not a
 * judgement that nobody else *could*.
 *
 * Two promises are made visible in the interface itself:
 *   • A brief is copyable as clean, pasteable plain text.
 *   • A line can be assigned as a record with NO notification sent — and the UI
 *     says so, because the absence of a notification is a product promise, not
 *     an omission.
 *
 * The page is a server component reading the seam; the interactive brief body
 * (copy, per-line assign) is a client island so the reads stay on the server.
 */

import Link from "next/link";
import { getBriefs } from "@/lib/data";
import { Eyebrow } from "@/components/primitives";
import { BriefCard } from "./brief-card";

export const metadata = {
  title: "Briefs — Baton",
};

export default async function BriefsPage() {
  const briefs = await getBriefs();
  const current = briefs[0] ?? null;
  const past = briefs.slice(1);

  return (
    <main className="mx-auto max-w-[52rem] px-6 py-10">
      <header className="mb-8">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <Eyebrow>Exposure at a change</Eyebrow>
            <h1 className="board-type text-head leading-none mt-1">Briefs</h1>
          </div>
          <Link
            href="/"
            className="text-meta text-ink-muted underline decoration-rule-strong underline-offset-2 hover:decoration-signal"
          >
            Back to continuity
          </Link>
        </div>
        <p className="text-dense text-ink-muted mt-3 max-w-prose">
          When a volunteer steps back or a period closes, Baton writes down what that leaves the
          organisation exposed to. Each line traces to the fact it rests on, and can be filed as a
          record without anyone being messaged.
        </p>
      </header>

      {current === null ? (
        <EmptyBriefs />
      ) : (
        <div className="grid gap-10">
          <section aria-labelledby="current-brief">
            <h2 id="current-brief" className="eyebrow mb-2">
              Current brief
            </h2>
            <BriefCard brief={current} current />
          </section>

          {past.length > 0 ? (
            <section aria-labelledby="past-briefs">
              <h2 id="past-briefs" className="eyebrow mb-2">
                Earlier briefs
              </h2>
              <div className="grid gap-6">
                {past.map((brief) => (
                  <BriefCard key={brief.id} brief={brief} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </main>
  );
}

/** No briefs is good news: nothing has changed the organisation's exposure. */
function EmptyBriefs() {
  return (
    <section className="sheet px-6 py-8">
      <p className="text-body text-ink">
        No briefs yet. Nothing has changed hands and no period has closed, so the
        organisation&apos;s exposure stands as the register already shows it.
      </p>
    </section>
  );
}
