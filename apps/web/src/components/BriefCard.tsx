"use client";

/**
 * A single brief, and its three interactive promises.
 *
 * A client island because all three need the browser: Copy writes to the
 * clipboard, per-line filing holds transient state (idle → filing → filed, or
 * error), and the offer-to-subject block copies a differently-worded text. It
 * receives a fully-serialised `Brief` from the server page; it reads nothing
 * itself.
 *
 * The three promises, each stated in the interface rather than left to be assumed:
 *
 *   1. A brief is copyable as clean, pasteable plain text.
 *   2. Filing a line records it and sends NO notification. The button says so,
 *      because the silence is a product promise, not an omission — filing a
 *      continuity record must never ping twenty people.
 *   3. The brief is offered to the person it is about [F24]. Copyable text is
 *      always available. Whether Baton could reach that person privately at all is
 *      stated plainly — it can only where they have previously opened a chat with
 *      the bot, because Telegram forbids a bot writing first — and the sending
 *      itself belongs to the worker, which holds the token and paces the queue.
 *
 * Nothing here quotes a source message. Brief lines are Baton's own phrasing, not
 * verbatim volunteer text; the verbatim quote lives behind the `Claim`, in the
 * fact panel, which redacts. No line is ever about a person.
 */

import { useCallback, useMemo, useState, useTransition } from "react";
// `@baton/core/constants` rather than the barrel: the barrel re-exports the
// normaliser, which imports `node:crypto`, and a `use client` module importing it
// fails the webpack build. Constants are the part a browser may legitimately have.
import { BRIEF_SECTIONS, type BriefSection } from "@baton/core/constants";
import type { Brief, BriefLine, BriefSubject } from "@/lib/types";
import { formatDateTime } from "@/lib/format";
import { fileBriefLine, markBriefRead } from "@/app/actions";
import { Claim } from "@/components/primitives";

const SECTION_TITLES: Record<BriefSection, string> = {
  only_they_held: "Only they held",
  they_had_promised: "They had promised",
  nobody_else_seen: "Nobody else has been seen",
};

const SECTION_LEDES: Record<BriefSection, string> = {
  only_they_held: "Capabilities that had rested in this one pair of hands until now.",
  they_had_promised: "Commitments that were open at the point of the change.",
  nobody_else_seen: "Where the record shows no second person doing the thing — seen, not able.",
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
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h4
              id={`brief-${brief.id}-title`}
              className="board-type leading-none"
              style={{ fontSize: "var(--text-sub)" }}
            >
              {brief.title}
            </h4>
            {!brief.read ? (
              <span className="code code-active" title="Not yet read">
                NEW
              </span>
            ) : null}
          </div>
          <p
            className="mt-1"
            style={{ fontSize: "var(--text-meta)", color: "var(--color-ink-muted)" }}
          >
            {brief.trigger}{" "}
            <span style={{ color: "var(--color-ink-faint)" }}>
              · {formatDateTime(brief.generatedAt)}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {brief.read ? null : <MarkReadButton briefId={brief.id} />}
          <CopyButton text={plainText} label={`Copy the brief "${brief.title}" as plain text`}>
            Copy as text
          </CopyButton>
        </div>
      </header>

      <div className="grid gap-5">
        {BRIEF_SECTIONS.map((section) => (
          <Section
            key={section}
            section={section}
            lines={brief.sections[section]}
            briefId={brief.id}
          />
        ))}
      </div>

      <OfferToSubject brief={brief} />
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
      <h5 id={headingId} className="eyebrow">
        {SECTION_TITLES[section]}
      </h5>
      <p
        className="mb-2"
        style={{ fontSize: "var(--text-label)", color: "var(--color-ink-faint)" }}
      >
        {SECTION_LEDES[section]}
      </p>

      {lines.length === 0 ? (
        <p style={{ fontSize: "var(--text-meta)", color: "var(--color-ink-muted)" }}>
          Nothing under this heading.
        </p>
      ) : (
        <ul className="grid gap-1.5">
          {lines.map((line) => (
            <BriefLineRow key={line.id} line={line} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One line: its text, an evidence ref that opens the fact panel via `Claim`, and
 * the per-line file control. A line with no `factId` shows no evidence ref — a
 * statement about the record's silence has nothing to trace to, and we do not
 * manufacture a link.
 */
function BriefLineRow({ line }: { line: BriefLine }) {
  return (
    <li className="chart-row grid grid-cols-[1fr_auto] items-baseline gap-3 px-3 py-2 first:border-t-0">
      <div style={{ fontSize: "var(--text-dense)" }}>
        {line.factId ? <Claim factId={line.factId}>{line.text}</Claim> : <span>{line.text}</span>}
      </div>
      <FileLineButton line={line} />
    </li>
  );
}

// ── offer to the subject (F24) ───────────────────────────────────────────────

/**
 * The brief, offered to the person it is about.
 *
 * Two states, and the difference between them is the whole point. Where the
 * subject has written to the bot before, a direct message is possible and offered.
 * Where they have not, Telegram forbids the bot writing first, so the control is
 * disabled and says why — and the copyable text sits beside it, so the
 * coordinator is never blocked on a platform rule.
 *
 * A brief with no person as its subject — a period close — gets only the silence
 * note, because there is nobody to offer it to.
 */
function OfferToSubject({ brief }: { brief: Brief }) {
  const subject = brief.subject;
  const forSubject = useMemo(
    () => (subject ? serialiseForSubject(brief, subject) : null),
    [brief, subject],
  );

  if (!subject || !forSubject) {
    return (
      <p
        className="mt-5 border-t border-rule pt-3"
        style={{ fontSize: "var(--text-label)", color: "var(--color-ink-faint)" }}
      >
        Filing a line records it in the register. No message is sent to anyone.
      </p>
    );
  }

  return (
    <div className="mt-5 border-t border-rule pt-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">Offer this brief to {subject.name}</p>
          <p
            className="mt-1 max-w-prose"
            style={{ fontSize: "var(--text-meta)", color: "var(--color-ink-muted)" }}
          >
            {subject.canDirectMessage
              ? `${subject.name} has written to Baton before, so Baton can reach them privately — the worker sends it, paced with everything else. Copy the text to pass it on yourself; nothing is posted to the group either way.`
              : `Baton cannot message ${subject.name} first — Telegram only allows it once that person has opened a chat with the bot. Copy the text and send it however you already reach them.`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <CopyButton text={forSubject} label={`Copy the brief for ${subject.name} as plain text`}>
            Copy for them
          </CopyButton>
          <DirectMessageButton subject={subject} />
        </div>
      </div>

      <p
        className="mt-3"
        style={{ fontSize: "var(--text-label)", color: "var(--color-ink-faint)" }}
      >
        Filing a line records it in the register. No message is sent to anyone.
      </p>
    </div>
  );
}

/**
 * The direct-message control.
 *
 * Two honest states and no third. Where Telegram has never given Baton a private
 * chat for this person, a bot cannot write first, and the control says exactly
 * that with the platform reason on the button — a button that silently failed
 * would be worse than none.
 *
 * Where delivery *is* possible, the control still does not send from here, and
 * that is architectural rather than unfinished: every outbound message goes
 * through the worker's queue, which paces sends so the bot is not restricted, and
 * the web app holds no bot token and no route to that queue. So it offers the
 * text — the same fallback the worker itself returns when a private chat is
 * missing — and says who will receive it. The copyable text beside it is the
 * documented delivery path, not a degradation.
 */
function DirectMessageButton({ subject }: { subject: BriefSubject }) {
  if (!subject.canDirectMessage) {
    return (
      <button
        type="button"
        className="btn"
        disabled
        title={`${subject.name} has never opened a chat with Baton, so Telegram will not deliver a first message from a bot.`}
      >
        Direct message unavailable
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn"
      disabled
      title={`Baton can reach ${subject.name} privately, but sending runs in the worker, which owns the bot token and paces every outbound message. Copy the text and it will reach them either way.`}
    >
      Reachable privately
    </button>
  );
}

// ── mark read ──────────────────────────────────────────────────────────────

/**
 * Clears the unread banner on the continuity stop.
 *
 * Present as an explicit control rather than firing on scroll: the banner is the
 * one thing on the first viewport that says a handover is waiting, and marking it
 * read because a page happened to render past it would lose that.
 */
function MarkReadButton({ briefId }: { briefId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <button
      type="button"
      className="btn"
      disabled={pending}
      aria-busy={pending}
      title={error ?? "Mark this brief read. Nothing is sent to anyone."}
      style={error === null ? undefined : { borderColor: "var(--color-status-held)" }}
      onClick={() =>
        startTransition(async () => {
          const result = await markBriefRead(briefId);
          setError(result.status === "ok" ? null : result.message);
        })
      }
    >
      {pending ? "Marking…" : "Mark read"}
    </button>
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

function CopyButton({ text, label, children }: { text: string; label: string; children: string }) {
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
          : children;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="btn"
        onClick={copy}
        disabled={state === "copying"}
        aria-label={label}
        style={state === "error" ? { borderColor: "var(--color-status-held)" } : undefined}
      >
        {face}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied"
          ? "Copied to the clipboard as plain text."
          : state === "error"
            ? "Could not copy. Select and copy it by hand."
            : ""}
      </span>
    </div>
  );
}

// ── file a line ────────────────────────────────────────────────────────────

/**
 * File a line as a record. It goes through the server-action seam in
 * `app/actions.ts` rather than staying local, so the no-notification promise is
 * kept by the write path and not by a component that could later grow a send
 * call. States: idle, filing, filed (disabled), error.
 *
 * `filed` starts from the row's own `assigned_at`, so a line filed last week still
 * reads as filed after a reload rather than offering the button again.
 */
type FileState = "idle" | "filed" | "error";

function FileLineButton({ line }: { line: BriefLine }) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<FileState>(line.filed ? "filed" : "idle");
  const [message, setMessage] = useState<string | null>(null);

  const file = useCallback(() => {
    if (state === "filed" || pending) return;
    startTransition(async () => {
      const result = await fileBriefLine(line.id);
      setState(result.status === "ok" ? "filed" : "error");
      setMessage(result.status === "ok" ? null : result.message);
    });
  }, [line.id, pending, state, startTransition]);

  if (state === "filed") {
    return (
      <span className="code code-active shrink-0" title="Filed as a record. No one was messaged.">
        FILED
      </span>
    );
  }

  return (
    <button
      type="button"
      className="btn shrink-0"
      onClick={file}
      disabled={pending}
      aria-busy={pending}
      // The title says the quiet part in full; the label stays terse for the
      // dense row. On a failure it carries the reason, which is the only place a
      // dense row has for one.
      title={
        message ?? "File this line as a register record. No notification is sent to anyone."
      }
      style={state === "error" ? { borderColor: "var(--color-status-held)" } : undefined}
    >
      {pending ? "Filing…" : state === "error" ? "Retry" : "File · no ping"}
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

/**
 * The same brief, addressed to the person it is about. Second person rather than
 * third, and it drops the internal filing note, which means nothing to them —
 * pasting the coordinator's copy verbatim would read as a file about them.
 */
function serialiseForSubject(brief: Brief, subject: BriefSubject): string {
  const lines: string[] = [];
  lines.push(`${subject.name} — what the group is relying on`);
  lines.push(`${brief.trigger} — ${formatDateTime(brief.generatedAt)}`);
  lines.push("");
  lines.push("This is what our records show rested with you, so nothing gets dropped.");
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

  lines.push("Nothing here is a judgement — it is only what the chat recorded.");
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
