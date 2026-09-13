"use client";

/**
 * A single brief, and its two interactive promises.
 *
 * This is a client island because both promises need the browser: the Copy
 * button writes to the clipboard, and per-line assign holds transient state
 * (idle → filing → filed, or error). It receives a fully-serialised `Brief`
 * from the server page; it reads nothing itself.
 *
 * The assign action is deliberately local and reversible-feeling: filing a line
 * as a record sends NO notification, and the button says so. That silence is a
 * product promise — filing a continuity record must never ping twenty people —
 * so the interface states it rather than leaving the reader to assume.
 *
 * Nothing here quotes a source message. Brief lines are Baton's own phrasing,
 * not verbatim volunteer text; the verbatim quote lives behind the `Claim`, in
 * the fact panel, which redacts. No line is ever about a person.
 */

import { useCallback, useMemo, useState } from "react";
import { BRIEF_SECTIONS, type BriefSection } from "@baton/core";
import type { Brief, BriefLine } from "@/lib/types";
import { formatDateTime } from "@/lib/format";
import { Claim } from "@/components/primitives";

const SECTION_TITLES: Record<BriefSection, string> = {
  only_they_held: "Only they held",
  they_had_promised: "They had promised",
  nobody_else_seen: "Nobody else has been seen",
};

const SECTION_LEDES: Record<BriefSection, string> = {
  only_they_held:
    "Capabilities that had rested in this one pair of hands until now.",
  they_had_promised: "Commitments that were open at the point of the change.",
  nobody_else_seen:
    "Where the record shows no second person doing the thing — seen, not able.",
};

export function BriefCard({ brief, current = false }: { brief: Brief; current?: boolean }) {
  const plainText = useMemo(() => serialiseBrief(brief), [brief]);

  return (
    <article
      className="sheet px-6 py-6"
      aria-labelledby={`brief-${brief.id}-title`}
      // The current brief carries the single selection accent on its left edge;
      // earlier briefs sit quiet.
      style={current ? { borderLeft: "2px solid var(--color-signal)" } : undefined}
    >
      <header className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 id={`brief-${brief.id}-title`} className="board-type text-sub leading-none">
              {brief.title}
            </h3>
            {!brief.read ? (
              <span className="code code-active" title="Not yet read">
                NEW
              </span>
            ) : null}
          </div>
          <p className="text-meta text-ink-muted mt-1">
            {brief.trigger}{" "}
            <span className="text-ink-faint">
              · {formatDateTime(brief.generatedAt)}
            </span>
          </p>
        </div>
        <CopyButton text={plainText} label={brief.title} />
      </header>

      <div className="grid gap-5">
        {BRIEF_SECTIONS.map((section) => (
          <Section key={section} section={section} lines={brief.sections[section]} briefId={brief.id} />
        ))}
      </div>

      <p className="text-label text-ink-faint mt-5 pt-3 border-t border-rule">
        Filing a line records it in the register. No message is sent to anyone.
      </p>
    </article>
  );
}

// ── a section ────────────────────────────────────────────────────────────────

function Section({
  section,
  lines,
  briefId,
}: {
  section: BriefSection;
  lines: BriefLine[];
  briefId: string;
}) {
  const headingId = `brief-${briefId}-${section}`;
  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId} className="eyebrow">
        {SECTION_TITLES[section]}
      </h4>
      <p className="text-label text-ink-faint mb-2">{SECTION_LEDES[section]}</p>

      {lines.length === 0 ? (
        <p className="text-meta text-ink-muted">Nothing under this heading.</p>
      ) : (
        <ul className="grid gap-1.5">
          {lines.map((line, i) => (
            <BriefLineRow key={`${section}-${i}`} line={line} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One line: its text, an evidence ref that opens the fact panel via `Claim`,
 * and the per-line assign control. A line with no `factId` shows no evidence
 * ref — a statement about the record's silence has nothing to trace to, and we
 * do not manufacture a link.
 */
function BriefLineRow({ line }: { line: BriefLine }) {
  return (
    <li className="chart-row grid grid-cols-[1fr_auto] items-baseline gap-3 px-3 py-2 first:border-t-0">
      <div className="text-dense">
        {line.factId ? (
          <Claim factId={line.factId}>{line.text}</Claim>
        ) : (
          <span>{line.text}</span>
        )}
      </div>
      <AssignButton lineText={line.text} />
    </li>
  );
}

// ── copy ──────────────────────────────────────────────────────────────────

/**
 * The Copy control, all seven states: default, hover, focus, active, disabled
 * (while writing), loading (the same "Copying…" frame), and error (clipboard
 * refused). Success is announced through a live region and a two-second label
 * flip back to rest, so the confirmation conveys state without a toast system.
 */
type CopyState = "idle" | "copying" | "copied" | "error";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<CopyState>("idle");

  const copy = useCallback(async () => {
    setState("copying");
    try {
      await writeToClipboard(text);
      setState("copied");
      window.setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("error");
      window.setTimeout(() => setState("idle"), 3000);
    }
  }, [text]);

  const face =
    state === "copying"
      ? "Copying…"
      : state === "copied"
        ? "Copied"
        : state === "error"
          ? "Copy failed"
          : "Copy as text";

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="btn"
        onClick={copy}
        disabled={state === "copying"}
        aria-label={`Copy the brief "${label}" as plain text`}
        style={
          state === "error" ? { borderColor: "var(--color-status-held)" } : undefined
        }
      >
        {face}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied"
          ? "Brief copied to the clipboard as plain text."
          : state === "error"
            ? "Could not copy the brief. Select and copy it by hand."
            : ""}
      </span>
    </div>
  );
}

// ── assign ─────────────────────────────────────────────────────────────────

/**
 * Assign a line as a record. Local and idempotent for now — the write seam for
 * this lands with the database — but the states are real so the control ships
 * complete: idle, filing (loading), filed (done, disabled), error. The label
 * carries the silence promise so it is read at the moment of acting.
 */
type AssignState = "idle" | "filing" | "filed" | "error";

function AssignButton({ lineText }: { lineText: string }) {
  const [state, setState] = useState<AssignState>("idle");

  const file = useCallback(async () => {
    if (state === "filed" || state === "filing") return;
    setState("filing");
    try {
      // The persistence seam does not exist yet; this stands in for it and is
      // where the Drizzle write will go. It never notifies — that is the point.
      await fileAsRecord(lineText);
      setState("filed");
    } catch {
      setState("error");
      window.setTimeout(() => setState("idle"), 3000);
    }
  }, [lineText, state]);

  if (state === "filed") {
    return (
      <span
        className="code code-active shrink-0"
        title="Filed as a record. No one was messaged."
      >
        FILED
      </span>
    );
  }

  return (
    <button
      type="button"
      className="btn shrink-0"
      onClick={file}
      disabled={state === "filing"}
      // The title says the quiet part in full; the label stays terse for the
      // dense row.
      title="File this line as a register record. No notification is sent to anyone."
      style={state === "error" ? { borderColor: "var(--color-status-held)" } : undefined}
    >
      {state === "filing" ? "Filing…" : state === "error" ? "Retry" : "File · no ping"}
    </button>
  );
}

// ── plumbing ─────────────────────────────────────────────────────────────

/** Render a brief as clean, pasteable plain text — no markup, stable order. */
function serialiseBrief(brief: Brief): string {
  const lines: string[] = [];
  lines.push(brief.title);
  lines.push(`${brief.trigger} — ${formatDateTime(brief.generatedAt)}`);
  lines.push("");

  for (const section of BRIEF_SECTIONS) {
    lines.push(SECTION_TITLES[section].toUpperCase());
    const sectionLines = brief.sections[section];
    if (sectionLines.length === 0) {
      lines.push("  (nothing under this heading)");
    } else {
      for (const line of sectionLines) {
        lines.push(`  - ${line.text}`);
      }
    }
    lines.push("");
  }

  lines.push("Filed lines are recorded in the register. No notification is sent.");
  return lines.join("\n").trimEnd() + "\n";
}

/** Clipboard write with a legacy fallback, so Copy works without the async API. */
async function writeToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  if (!ok) throw new Error("clipboard unavailable");
}

/**
 * Stand-in for the future write seam. Resolves after a short beat so the filing
 * state is visible; the real implementation will insert a record and, crucially,
 * still send nothing.
 */
function fileAsRecord(_lineText: string): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 350));
}
