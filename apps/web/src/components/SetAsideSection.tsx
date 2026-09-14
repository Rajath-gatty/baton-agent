/**
 * Set aside — the fourth and last stop: what the register decided *not* to press.
 *
 * Two lists live here, and they are two different kinds of restraint. The
 * dismissed findings are the coordinator's judgements: exposures a human looked
 * at and put down, kept with the reason so that hiding stays distinguishable from
 * forgetting. The quiet decisions are Baton's own: things it declined to raise,
 * each with its reasoning and the pass that recorded it.
 *
 * Both were separate routes before this build. They are folded disclosures on the
 * one page now, closed by default — which is a deliberate ordering claim, not a
 * demotion. The quiet strip on the register above is expanded, because restraint
 * must be visible without asking; these are the *full* lists behind that strip
 * and the register footer, and pushing seven more articles into the first scroll
 * would cost the register its rank.
 *
 * Two rules govern the quiet list absolutely. Reasoning is item-level or
 * organisation-level and is NEVER about a volunteer. And each decision names the
 * run that recorded it, so restraint is auditable back to a pass of the agent
 * rather than being an unattributable act.
 *
 * A server component: it receives the reads and renders. Each decision names the run
 * that recorded it by `quiet_decisions.run_id`, so restraint is auditable back to a
 * pass of the agent rather than being an unattributable act.
 */

import type { Finding, QuietDecision, Run } from "@/lib/types";
import {
  formatDate,
  formatDateTime,
  formatRelativeAge,
  severityLabel,
  subtypeLabel,
} from "@/lib/format";
import { Confidence, Eyebrow, Sheet } from "@/components/primitives";

export interface SetAsideProps {
  dismissed: Finding[];
  quiet: QuietDecision[];
  runs: Run[];
}

export function SetAsideSection({ dismissed, quiet, runs }: SetAsideProps) {
  return (
    <section id="set-aside" className="stop" aria-labelledby="set-aside-heading">
      <div className="stop-head">
        <div>
          <Eyebrow>Judged, and kept on the record</Eyebrow>
          <h2
            id="set-aside-heading"
            className="board-type mt-1 leading-none"
            style={{ fontSize: "var(--text-head)" }}
          >
            Set aside
          </h2>
        </div>
        <p
          className="max-w-prose text-right"
          style={{ fontSize: "var(--text-dense)", color: "var(--color-ink-muted)" }}
        >
          Nothing here was deleted. A decision that was taken must never read as a thing that was
          lost — which is why both lists keep their reasons.
        </p>
      </div>

      <div className="grid gap-4" style={{ maxWidth: "56rem" }}>
        {/* Dismissed findings — the coordinator's own judgements. */}
        <details className="disclosure" id="dismissed">
          <summary>
            <span className="flex items-baseline gap-3">
              <span
                className="board-type"
                style={{ fontSize: "var(--text-lead)", color: "var(--color-ink)" }}
              >
                Dismissed exposures
              </span>
              <span style={{ fontSize: "var(--text-meta)", color: "var(--color-ink-muted)" }}>
                {dismissed.length === 0
                  ? "none — everything raised is still standing"
                  : `${dismissed.length} put down, each with the reason it was dismissed`}
              </span>
            </span>
            <span
              className="disclosure-hint board-type"
              style={{
                fontSize: "var(--text-meta)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--color-signal)",
              }}
            />
          </summary>

          <div className="pt-3">
            {dismissed.length === 0 ? (
              <Sheet className="px-5 py-4">
                <p style={{ color: "var(--color-ink)" }}>
                  Nothing has been dismissed. Every exposure the register has raised is still
                  standing on the sheet above, where you can see it.
                </p>
              </Sheet>
            ) : (
              <ul className="grid gap-3">
                {dismissed.map((finding) => (
                  <li key={finding.id}>
                    <DismissedCard finding={finding} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>

        {/* Quiet decisions — Baton's own restraint, in full. */}
        <details className="disclosure" id="quiet-decisions">
          <summary>
            <span className="flex items-baseline gap-3">
              <span
                className="board-type"
                style={{ fontSize: "var(--text-lead)", color: "var(--color-ink)" }}
              >
                All quiet decisions
              </span>
              <span style={{ fontSize: "var(--text-meta)", color: "var(--color-ink-muted)" }}>
                {quiet.length === 0
                  ? "none — Baton has surfaced everything it judged"
                  : `${quiet.length} things Baton chose not to say, and why`}
              </span>
            </span>
            <span
              className="disclosure-hint board-type"
              style={{
                fontSize: "var(--text-meta)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--color-signal)",
              }}
            />
          </summary>

          <div className="pt-3">
            {quiet.length === 0 ? (
              <Sheet className="px-5 py-4">
                <p style={{ color: "var(--color-ink)" }}>
                  Nothing has been held back. Every judgement Baton has made is already on the
                  register — there is no quieter layer beneath it.
                </p>
              </Sheet>
            ) : (
              <ol className="grid gap-3">
                {quiet.map((decision) => (
                  <li key={decision.id}>
                    <QuietCard decision={decision} run={runForDecision(decision, runs)} />
                  </li>
                ))}
              </ol>
            )}
          </div>
        </details>
      </div>
    </section>
  );
}

// ── one dismissed finding ────────────────────────────────────────────────────

function DismissedCard({ finding }: { finding: Finding }) {
  return (
    <article className="sheet px-5 py-4" aria-labelledby={`dismissed-${finding.id}`}>
      <div className="flex items-start justify-between gap-4">
        <h3
          id={`dismissed-${finding.id}`}
          className="leading-snug"
          style={{ fontSize: "var(--text-lead)", color: "var(--color-ink)" }}
        >
          {finding.title}
        </h3>
        {/* A dismissed finding keeps its "closed" reading — the neutral status
            colour, never a red chip — because it is resolved by judgement, not an
            alert that fired. */}
        <span className="code code-closed shrink-0" aria-label="Dismissed">
          DISMISSD
        </span>
      </div>

      <dl
        className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1"
        style={{ fontSize: "var(--text-meta)" }}
      >
        <dt className="eyebrow self-baseline">Kind</dt>
        <dd style={{ color: "var(--color-ink-muted)" }}>{subtypeLabel(finding.subtype)}</dd>

        <dt className="eyebrow self-baseline">Was</dt>
        <dd style={{ color: "var(--color-ink-muted)" }}>
          {severityLabel(finding.severity)} severity · {finding.evidenceCount}{" "}
          {finding.evidenceCount === 1 ? "message" : "messages"} of evidence ·{" "}
          <span className="inline-flex items-center gap-1.5 align-middle">
            <Confidence value={finding.confidence} />
          </span>
        </dd>

        <dt className="eyebrow self-baseline">Seen</dt>
        <dd style={{ color: "var(--color-ink-muted)" }}>
          first {formatRelativeAge(finding.firstSeenAt)}, last{" "}
          <time dateTime={finding.lastSeenAt} title={formatDate(finding.lastSeenAt)}>
            {formatRelativeAge(finding.lastSeenAt)}
          </time>
        </dd>
      </dl>

      {/* The dismissal reason is the reason to be here at all — give it the
          weight, set apart from the metadata above. */}
      <div className="mt-3 border-t border-rule pt-3">
        <p className="eyebrow">Dismissed because</p>
        <p className="mt-1" style={{ color: "var(--color-ink)" }}>
          {finding.dismissalReason ?? "No reason was recorded."}
        </p>
      </div>
    </article>
  );
}

// ── one quiet decision ───────────────────────────────────────────────────────

function QuietCard({ decision, run }: { decision: QuietDecision; run: Run | null }) {
  return (
    <article className="sheet px-5 py-4" aria-labelledby={`quiet-${decision.id}`}>
      <div className="flex items-start justify-between gap-4">
        <h3
          id={`quiet-${decision.id}`}
          className="leading-snug"
          style={{ fontSize: "var(--text-lead)", color: "var(--color-ink)" }}
        >
          {decision.summary}
        </h3>
        {/* Scope is shown as a status code in the product's own vocabulary: an
            item-level choice reads active (settled about one thing), an org-level
            choice reads held (a standing rule about the register). */}
        <ScopeCode scope={decision.scope} />
      </div>

      <div className="mt-3">
        <p className="eyebrow">Reason</p>
        <p className="mt-1" style={{ color: "var(--color-ink)" }}>
          {decision.reasoning}
        </p>
      </div>

      <dl
        className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-rule pt-3"
        style={{ fontSize: "var(--text-meta)" }}
      >
        <dt className="eyebrow self-baseline">Decided</dt>
        <dd style={{ color: "var(--color-ink-muted)" }}>
          <time dateTime={decision.decidedAt} title={formatDate(decision.decidedAt)}>
            {formatDateTime(decision.decidedAt)}
          </time>
        </dd>

        <dt className="eyebrow self-baseline">Recorded in</dt>
        <dd style={{ color: "var(--color-ink-muted)" }}>
          {run ? (
            <>
              <span className="board-type" style={{ color: "var(--color-ink)" }}>
                {run.id}
              </span>{" "}
              <span style={{ color: "var(--color-ink-faint)" }}>
                · the pass of {formatDate(run.startedAt)}
              </span>
            </>
          ) : (
            <span style={{ color: "var(--color-ink-faint)" }}>
              a pass before the earliest run on record
            </span>
          )}
        </dd>
      </dl>
    </article>
  );
}

/**
 * The produce path Restraint was gating, as a status code.
 *
 * Three scopes, because Restraint gates three things and the two nobody watches are
 * the two a human reads aloud. A withheld brief line and a withheld answer are shown
 * with as much weight as a withheld finding, which is the only way a reader could
 * notice if either ever stopped appearing.
 */
function ScopeCode({ scope }: { scope: QuietDecision["scope"] }) {
  if (scope === "brief_line") {
    return (
      <span
        className="code code-held shrink-0"
        title="A line Restraint kept out of a handover brief"
        aria-label="Scope: a brief line"
      >
        BRIEF
      </span>
    );
  }
  if (scope === "answer") {
    return (
      <span
        className="code code-unverified shrink-0"
        title="Something Restraint kept out of an answer to the group"
        aria-label="Scope: an answer to the group"
      >
        ANSWER
      </span>
    );
  }
  return (
    <span
      className="code code-active shrink-0"
      title="An exposure Restraint judged not worth raising on the register"
      aria-label="Scope: a finding"
    >
      FINDING
    </span>
  );
}

// ── run attribution ──────────────────────────────────────────────────────────

/**
 * The run that recorded a decision, by its real foreign key.
 *
 * `quiet_decisions.run_id` is nullable, and null is a legitimate state rather than
 * missing data: a decision taken outside a pass — or one whose run has since been
 * pruned — has no pass to name. It reads as such instead of being attributed to
 * whichever run happens to be nearest in time, which is what this function did while
 * the decisions were fixtures with no run on them.
 */
function runForDecision(decision: QuietDecision, runs: Run[]): Run | null {
  if (decision.runId === null) return null;
  return runs.find((run) => run.id === decision.runId) ?? null;
}
