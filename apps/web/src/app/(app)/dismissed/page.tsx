/**
 * Dismissed — findings the coordinator set aside.
 *
 * Reached from the register's footer. Its whole reason to exist is that hiding
 * must stay distinguishable from forgetting: a dismissed finding is not deleted
 * and not silently gone — it is here, with the reason it was dismissed written
 * next to it, so a later coordinator can see what was judged and why.
 *
 * Every finding is phrased about a capability, never a person, and carries no
 * score. The dismissal reason is the human's, shown verbatim as they gave it.
 *
 * A server component reading the seam. The only interactive parts would be the
 * evidence refs; dismissed findings here point at their own record, not a fact
 * panel, so there is nothing client-side to mount.
 */

import Link from "next/link";
import type { Finding } from "@/lib/types";
import { getDismissedFindings } from "@/lib/data";
import { formatDate, formatRelativeAge, severityLabel, subtypeLabel } from "@/lib/format";
import { Confidence, Eyebrow, Sheet } from "@/components/primitives";

export const metadata = {
  title: "Dismissed — Baton",
};

export default async function DismissedPage() {
  const dismissed = await getDismissedFindings();

  return (
    <main className="mx-auto max-w-[52rem] px-6 py-10">
      <header className="mb-8">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <Eyebrow>Set aside, not forgotten</Eyebrow>
            <h1 className="board-type text-head leading-none mt-1">Dismissed</h1>
          </div>
          <Link
            href="/"
            className="text-meta text-ink-muted underline decoration-rule-strong underline-offset-2 hover:decoration-signal"
          >
            Back to continuity
          </Link>
        </div>
        <p className="text-dense text-ink-muted mt-3 max-w-prose">
          Exposures the coordinator judged and put down, each kept with the reason it was dismissed
          — so a thing that was decided never reads as a thing that was lost.
        </p>
      </header>

      {dismissed.length === 0 ? (
        <EmptyDismissed />
      ) : (
        <ul className="grid gap-4">
          {dismissed.map((finding) => (
            <li key={finding.id}>
              <DismissedCard finding={finding} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/** No dismissals is good news: nothing has been set aside. */
function EmptyDismissed() {
  return (
    <Sheet className="px-6 py-8">
      <p className="text-body text-ink">
        Nothing has been dismissed. Every exposure the register has raised is still standing on the
        sheet where you can see it.
      </p>
    </Sheet>
  );
}

// ── one dismissed finding ────────────────────────────────────────────────────

function DismissedCard({ finding }: { finding: Finding }) {
  return (
    <article className="sheet px-5 py-4" aria-labelledby={`dismissed-${finding.id}`}>
      <div className="flex items-start justify-between gap-4">
        <h2 id={`dismissed-${finding.id}`} className="text-lead text-ink leading-snug">
          {finding.title}
        </h2>
        {/* A dismissed finding keeps its "closed" reading — the neutral status
            colour, never a red chip — because it is resolved by judgement, not
            an alert that fired. */}
        <span className="code code-closed shrink-0" aria-label="Dismissed">
          DISMISSD
        </span>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mt-3 text-meta">
        <dt className="eyebrow self-baseline">Kind</dt>
        <dd className="text-ink-muted">{subtypeLabel(finding.subtype)}</dd>

        <dt className="eyebrow self-baseline">Was</dt>
        <dd className="text-ink-muted">
          {severityLabel(finding.severity)} severity · {finding.evidenceCount}{" "}
          {finding.evidenceCount === 1 ? "message" : "messages"} of evidence ·{" "}
          <span className="inline-flex items-center gap-1.5 align-middle">
            <Confidence value={finding.confidence} />
          </span>
        </dd>

        <dt className="eyebrow self-baseline">Seen</dt>
        <dd className="text-ink-muted">
          first {formatRelativeAge(finding.firstSeenAt)}, last{" "}
          <time dateTime={finding.lastSeenAt} title={formatDate(finding.lastSeenAt)}>
            {formatRelativeAge(finding.lastSeenAt)}
          </time>
        </dd>
      </dl>

      {/* The dismissal reason is the reason to be here at all — give it the
          weight, set apart from the metadata above. */}
      <div className="mt-3 pt-3 border-t border-rule">
        <p className="eyebrow">Dismissed because</p>
        <p className="text-body text-ink mt-1">
          {finding.dismissalReason ?? "No reason was recorded."}
        </p>
      </div>
    </article>
  );
}
