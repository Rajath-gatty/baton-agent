/**
 * Quiet decisions — restraint made visible.
 *
 * This is the product's signature. Most tools show only what they surfaced;
 * Baton keeps a standing list of what it deliberately did NOT say, and why.
 * Withholding is a first-class act here, on the same sheet as the register, so
 * a coordinator can see the judgement as well as its result.
 *
 * Two rules govern this page absolutely:
 *   • Reasoning is item-level or organisation-level. It is NEVER about a
 *     volunteer. A quiet decision explains a choice about a finding or about how
 *     the register behaves — not about a person. The fixtures are authored this
 *     way; this page renders the `scope` so the reader can see which it is.
 *   • Each decision names the run that recorded it, so restraint is auditable
 *     back to a pass of the agent, not an unattributable act.
 *
 * A server component: it reads the quiet decisions and the runs from the seam
 * and pairs them. The run link is derived here in the view — a `QuietDecision`
 * carries no run id yet, so we attribute each to the pass it belongs to by
 * time. When the schema lands, that link becomes a real foreign key and this
 * derivation is deleted.
 */

import Link from "next/link";
import type { QuietDecision, Run } from "@/lib/types";
import { getQuietDecisions, getRuns } from "@/lib/data";
import { formatDate, formatDateTime } from "@/lib/format";
import { Eyebrow, Sheet } from "@/components/primitives";

export const metadata = {
  title: "Quiet decisions — Baton",
};

export default async function QuietPage() {
  const [decisions, runs] = await Promise.all([getQuietDecisions(), getRuns()]);

  return (
    <main className="mx-auto max-w-[52rem] px-6 py-10">
      <header className="mb-8">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <Eyebrow>What Baton chose not to say</Eyebrow>
            <h1 className="board-type text-head leading-none mt-1">Quiet decisions</h1>
          </div>
          <Link
            href="/"
            className="text-meta text-ink-muted underline decoration-rule-strong underline-offset-2 hover:decoration-signal"
          >
            Back to continuity
          </Link>
        </div>
        <p className="text-dense text-ink-muted mt-3 max-w-prose">
          Every time Baton held something back — a finding it did not raise, a number it would not
          put on the sheet — it wrote down the choice and the reason. The reasons are about the item
          or the register, never about a volunteer.
        </p>
      </header>

      {decisions.length === 0 ? (
        <EmptyQuiet />
      ) : (
        <ol className="grid gap-4">
          {decisions.map((decision) => (
            <li key={decision.id}>
              <QuietRow decision={decision} run={runForDecision(decision, runs)} />
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}

/** No quiet decisions is good news: Baton has surfaced everything it judged. */
function EmptyQuiet() {
  return (
    <Sheet className="px-6 py-8">
      <p className="text-body text-ink">
        Nothing has been held back. Every judgement Baton has made is already on the register —
        there is no quieter layer beneath it.
      </p>
    </Sheet>
  );
}

// ── one quiet decision ───────────────────────────────────────────────────────

function QuietRow({ decision, run }: { decision: QuietDecision; run: Run | null }) {
  return (
    <article className="sheet px-5 py-4" aria-labelledby={`quiet-${decision.id}`}>
      <div className="flex items-start justify-between gap-4">
        <h2 id={`quiet-${decision.id}`} className="text-lead text-ink leading-snug">
          {decision.summary}
        </h2>
        {/* Scope is shown as a status code in the product's own vocabulary: an
            item-level choice reads active (settled about one thing), an
            org-level choice reads held (a standing rule about the register). */}
        <ScopeCode scope={decision.scope} />
      </div>

      <div className="mt-3">
        <p className="eyebrow">Reason</p>
        <p className="text-body text-ink mt-1">{decision.reasoning}</p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mt-3 pt-3 border-t border-rule text-meta">
        <dt className="eyebrow self-baseline">Decided</dt>
        <dd className="text-ink-muted">
          <time dateTime={decision.decidedAt} title={formatDate(decision.decidedAt)}>
            {formatDateTime(decision.decidedAt)}
          </time>
        </dd>

        <dt className="eyebrow self-baseline">Recorded in</dt>
        <dd className="text-ink-muted">
          {run ? (
            <>
              <span className="board-type text-ink">{run.id}</span>{" "}
              <span className="text-ink-faint">· the pass of {formatDate(run.startedAt)}</span>
            </>
          ) : (
            <span className="text-ink-faint">a pass before the earliest run on record</span>
          )}
        </dd>
      </dl>
    </article>
  );
}

function ScopeCode({ scope }: { scope: QuietDecision["scope"] }) {
  if (scope === "org") {
    return (
      <span
        className="code code-held shrink-0"
        title="Organisation-level — a standing choice about how the register behaves"
        aria-label="Scope: organisation-level"
      >
        ORG
      </span>
    );
  }
  return (
    <span
      className="code code-active shrink-0"
      title="Item-level — a choice about one finding or asset"
      aria-label="Scope: item-level"
    >
      ITEM
    </span>
  );
}

// ── run attribution (view-layer derivation) ──────────────────────────────────

/**
 * The run that recorded a decision, derived by time: the latest run whose start
 * is at or before the decision, or — when the decision predates every run on
 * record — the earliest run, so a decision is never left unattributed. Runs
 * arrive newest-first from the seam.
 */
function runForDecision(decision: QuietDecision, runs: Run[]): Run | null {
  if (runs.length === 0) return null;
  const decidedMs = new Date(decision.decidedAt).getTime();

  let atOrBefore: Run | null = null;
  for (const run of runs) {
    if (new Date(run.startedAt).getTime() <= decidedMs) {
      atOrBefore = run;
      break; // newest-first, so the first match is the latest qualifying run
    }
  }
  if (atOrBefore) return atOrBefore;

  // Predates every run: attribute to the earliest on record.
  return runs[runs.length - 1] ?? null;
}
