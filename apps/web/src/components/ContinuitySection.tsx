/**
 * Continuity — the first stop, and the screen the demo pauses on.
 *
 * Absent by design, and binding: no question box anywhere. The coordinator reads
 * what Baton decided; a text field inviting a question would reframe the whole
 * product as retrieval.
 *
 * The order top-to-bottom is fixed by the design document and is not
 * rearrangeable: the state of the organisation in one sentence, the
 * since-you-last-looked diff, the slim waiting-on line, an unread-brief banner
 * only when one exists, the ranked register of five to eight findings as ruled
 * chart rows, and the quiet strip expanded at the foot.
 *
 * The binding layout constraint: the state line, the register with seven
 * findings, and the quiet strip must all sit inside a 1440×900 first viewport.
 * That is why findings are dense rows, the diff and waiting-on share a compact
 * meta band, and the sheet is capped to a document width rather than sprawling.
 * A judge pausing the video here understands the product without narration.
 *
 * A server component: it receives everything already read through `lib/data.ts`,
 * so the fixture → Drizzle swap never touches this file.
 */

import { ASK_BUDGET } from "@baton/core";
import type { Brief, Diff, Finding, QuietDecision, Question } from "@/lib/types";
import { FindingRow } from "@/components/FindingRow";
import { QuietStrip } from "@/components/QuietStrip";
import { Eyebrow } from "@/components/primitives";

/** The diff kinds, worded in the product's own terms for the meta band. */
const DIFF_KIND_LABEL: Record<Diff["kind"], string> = {
  added: "New",
  changed: "Changed",
  resolved: "Closed",
  withheld: "Held back",
};

export interface ContinuityProps {
  stateSentence: string;
  diffs: Diff[];
  questions: Question[];
  unreadBrief: Brief | null;
  register: Finding[];
  quiet: QuietDecision[];
}

export function ContinuitySection({
  stateSentence,
  diffs,
  questions,
  unreadBrief,
  register,
  quiet,
}: ContinuityProps) {
  const openQuestionCount = questions.filter((q) => q.status === "asked").length;

  return (
    <section id="continuity" className="stop" aria-labelledby="state-heading">
      {/* 1 — The state of the organisation in one sentence. The focal point. */}
      <div>
        <Eyebrow>The state of the organisation</Eyebrow>
        <h1
          id="state-heading"
          className="board-type"
          style={{
            fontSize: "var(--text-state)",
            lineHeight: 1.1,
            letterSpacing: "-0.005em",
            color: "var(--color-ink)",
            // Wide enough that a one-sentence summary stays one line. The fold
            // budget has about forty pixels of slack and a second line costs
            // thirty, so keeping this on one line is load-bearing, not cosmetic.
            maxWidth: "72rem",
            marginTop: "0.25rem",
          }}
        >
          {stateSentence}
        </h1>
      </div>

      {/* 2 + 3 — Since-you-last-looked and the waiting-on line share one compact
          meta band, to keep the register above the fold. */}
      <div className="mt-3 grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr) 22rem" }}>
        {/* 2 — Since you last looked. */}
        <section aria-labelledby="diff-heading">
          <h2 id="diff-heading">
            <Eyebrow>Since you last looked</Eyebrow>
          </h2>
          {diffs.length === 0 ? (
            <p
              style={{
                fontSize: "var(--text-dense)",
                color: "var(--color-ink-muted)",
                marginTop: "0.25rem",
              }}
            >
              Nothing has changed since your last visit.
            </p>
          ) : (
            <ul className="mt-1 flex flex-col gap-[0.1875rem]">
              {diffs.map((diff) => (
                <li
                  key={diff.id}
                  className="flex items-baseline gap-2"
                  style={{ fontSize: "var(--text-dense)" }}
                >
                  <span
                    className="board-type"
                    style={{
                      flex: "0 0 auto",
                      minWidth: "5rem",
                      fontSize: "var(--text-label)",
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      fontWeight: 600,
                      color: "var(--color-ink-faint)",
                    }}
                  >
                    {DIFF_KIND_LABEL[diff.kind]}
                  </span>
                  <span style={{ color: "var(--color-ink-muted)" }}>{diff.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 3 — Waiting on: open questions, both asked and queued, with the ask
            budget shown. Both states mean Baton is holding something back
            deliberately, so both belong here. */}
        <section aria-labelledby="waiting-heading">
          <h2 id="waiting-heading">
            <Eyebrow>Waiting on the group</Eyebrow>
          </h2>
          {questions.length === 0 ? (
            <p
              style={{
                fontSize: "var(--text-dense)",
                color: "var(--color-ink-muted)",
                marginTop: "0.25rem",
              }}
            >
              Baton is waiting on nothing — no open questions.
            </p>
          ) : (
            <>
              <ul className="mt-1 flex flex-col gap-[0.1875rem]">
                {questions.map((q) => (
                  <li
                    key={q.id}
                    className="flex items-baseline gap-2"
                    style={{ fontSize: "var(--text-dense)" }}
                  >
                    <span
                      className="board-type"
                      style={{
                        flex: "0 0 auto",
                        minWidth: "3.75rem",
                        fontSize: "var(--text-label)",
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        fontWeight: 600,
                        color:
                          q.status === "asked" ? "var(--color-signal)" : "var(--color-ink-faint)",
                      }}
                    >
                      {q.status === "asked" ? "Asked" : "Queued"}
                    </span>
                    <span style={{ color: "var(--color-ink-muted)" }}>{q.text}</span>
                  </li>
                ))}
              </ul>
              <p
                style={{
                  fontSize: "var(--text-meta)",
                  color: "var(--color-ink-faint)",
                  marginTop: "0.25rem",
                }}
              >
                {openQuestionCount} of {ASK_BUDGET.maxOpen} open, at most{" "}
                {ASK_BUDGET.maxPerRollingWindow} in {ASK_BUDGET.rollingWindowHours}h — Baton rations
                what it asks.
              </p>
            </>
          )}
        </section>
      </div>

      {/* 4 — Unread-brief banner, only when one is unread. It scrolls to the
          briefs stop rather than navigating: there is nowhere else to go. */}
      {unreadBrief ? (
        <a
          href="#briefs"
          className="mt-3 flex items-center justify-between px-4 py-1"
          style={{
            border: "1px solid var(--color-signal)",
            background: "var(--color-signal-soft)",
            borderRadius: "2px",
            textDecoration: "none",
          }}
        >
          <span className="flex items-baseline gap-3">
            <span
              className="board-type"
              style={{
                fontSize: "var(--text-label)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                fontWeight: 600,
                color: "var(--color-signal)",
              }}
            >
              New brief
            </span>
            <span style={{ fontSize: "var(--text-dense)", color: "var(--color-ink)" }}>
              {unreadBrief.title} — {unreadBrief.trigger}
            </span>
          </span>
          <span
            className="board-type"
            style={{
              fontSize: "var(--text-meta)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontWeight: 600,
              color: "var(--color-signal)",
            }}
          >
            Read →
          </span>
        </a>
      ) : null}

      {/* 5 — The ranked register + 6 — the quiet strip, on one sheet. */}
      <section aria-labelledby="register-heading" className="sheet mt-3 overflow-hidden">
        <div
          className="grid items-baseline px-6 pt-2 pb-1"
          style={{
            gridTemplateColumns: "minmax(0, 1fr) 9.5rem 3.25rem 4.5rem 11.5rem",
            columnGap: "1rem",
            borderBottom: "1px solid var(--color-rule-strong)",
          }}
        >
          <h2 id="register-heading">
            <Eyebrow>The register — open exposures, ranked</Eyebrow>
          </h2>
          <span className="eyebrow">Kind</span>
          <span className="eyebrow">Sev</span>
          <span className="eyebrow">Conf</span>
          <span className="eyebrow" style={{ textAlign: "right" }}>
            Actions
          </span>
        </div>

        {register.length === 0 ? (
          // Good news, not an error: an empty register means nothing is exposed.
          <div className="px-6 py-10 text-center">
            <p
              className="board-type"
              style={{ fontSize: "var(--text-sub)", color: "var(--color-status-active)" }}
            >
              Nothing stands exposed right now.
            </p>
            <p
              style={{
                fontSize: "var(--text-dense)",
                color: "var(--color-ink-muted)",
                marginTop: "0.375rem",
              }}
            >
              Every capability the group relies on has been seen in more than one pair of hands.
              Baton is still reading the chat; a new exposure will appear here the moment one is
              found.
            </p>
          </div>
        ) : (
          <ul>
            {register.map((finding) => (
              <FindingRow key={finding.id} finding={finding} />
            ))}
          </ul>
        )}

        {/* 6 — The quiet strip, expanded, at the foot of the sheet. It carries the
            two anchors out — to the dismissed list and to the full quiet list —
            because a footer row of its own cost thirty pixels of the fold budget
            to say two words. */}
        <QuietStrip decisions={quiet} />
      </section>
    </section>
  );
}
