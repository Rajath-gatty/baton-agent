"use client";

/**
 * The activity panel — the run's own account of itself.
 *
 * A slide-over opened from the header, mounted once in the layout. It is the
 * ONE place in the product where volume metrics are allowed: messages read,
 * facts extracted, candidates skipped, tokens spent. Everywhere else they are
 * banned, because on the dashboard a token count would compete with a finding
 * for the coordinator's attention, and the findings must win. Here, in a panel
 * a coordinator opens deliberately, the numbers answer a fair question — what
 * did the last pass actually do — without ever reaching the surfaces that read
 * as the register itself.
 *
 * Like the fact panel it is a native `<dialog>` opened with `showModal()`, for the
 * same reasons: it is dispatched from a header that scrolls, and the native
 * element gives Escape-to-close, a backdrop and a focus trap. The slide is a
 * transform on the inner sheet, 200ms, purely to convey that it enters from the
 * edge — no other choreography.
 *
 * Its read crosses to the server through `loadLastRun` rather than importing the
 * data seam: this is a client component, and importing `lib/data.ts` here would
 * drag the read layer into the browser bundle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TraceEntry } from "@baton/core";
import type { Run } from "@/lib/types";
import { loadLastRun } from "@/app/panel-actions";
import { formatDateTime } from "@/lib/format";

/** The event the header dispatches to open this panel. */
export const OPEN_ACTIVITY_EVENT = "baton:open-activity";

/**
 * Dispatch helper the header uses, so the event name is owned in one place and
 * a caller never has to know the payload is empty.
 */
export function openActivity() {
  window.dispatchEvent(new CustomEvent(OPEN_ACTIVITY_EVENT));
}

type PanelPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; run: Run }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export function ActivityPanel() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<PanelPhase>({ kind: "idle" });
  const [entering, setEntering] = useState(false);

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const run = await loadLastRun();
      setPhase(run ? { kind: "ready", run } : { kind: "empty" });
    } catch (cause) {
      setPhase({
        kind: "error",
        message: cause instanceof Error ? cause.message : "The activity could not be loaded.",
      });
    }
  }, []);

  useEffect(() => {
    function onOpen() {
      const dialog = dialogRef.current;
      if (dialog && !dialog.open) dialog.showModal();
      // Trigger the enter transition on the next frame, after the dialog paints
      // in its off-screen start position.
      requestAnimationFrame(() => setEntering(true));
      void load();
    }
    window.addEventListener(OPEN_ACTIVITY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ACTIVITY_EVENT, onOpen);
  }, [load]);

  const close = useCallback(() => {
    setEntering(false);
    dialogRef.current?.close();
  }, []);

  const onClose = useCallback(() => {
    setEntering(false);
    setPhase({ kind: "idle" });
  }, []);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby="activity-panel-title"
      className="m-0 ml-auto h-screen max-h-screen w-[min(34rem,calc(100vw-3rem))] border-0 bg-transparent p-0"
    >
      <div
        className="sheet flex h-screen flex-col border-l border-[color:var(--color-rule-strong)]"
        style={{
          transform: entering ? "translateX(0)" : "translateX(100%)",
          transition: "transform 200ms ease",
        }}
      >
        <header className="flex items-baseline justify-between gap-4 border-b border-[color:var(--color-rule)] px-5 py-3">
          <p className="eyebrow" id="activity-panel-title">
            Activity — last run
          </p>
          <button type="button" className="btn" onClick={close} aria-label="Close activity panel">
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {phase.kind === "loading" || phase.kind === "idle" ? (
            <ActivitySkeleton />
          ) : phase.kind === "empty" ? (
            <EmptyState />
          ) : phase.kind === "error" ? (
            <ErrorState message={phase.message} onClose={close} />
          ) : (
            <ActivityBody run={phase.run} />
          )}
        </div>
      </div>
    </dialog>
  );
}

// ── body ────────────────────────────────────────────────────────────────────

function ActivityBody({ run }: { run: Run }) {
  // Candidates skipped: everything the run considered that did not become a
  // durable fact. Derived rather than stored, and labelled as such, so the
  // number never implies a field the register does not keep.
  const candidatesSkipped = Math.max(0, run.messagesConsidered - run.factsRecorded);
  const running = run.status === "running";
  const errored = run.status === "error";

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="activity-summary-heading">
        <div className="flex items-baseline justify-between gap-3">
          <h2
            id="activity-summary-heading"
            className="board-type text-sub leading-tight text-[color:var(--color-ink)]"
          >
            {run.finishedAt ? "Pass complete" : running ? "Pass running" : "Pass ended"}
          </h2>
          {errored ? <span className="code code-held">ERROR</span> : null}
          {running ? <span className="code code-unverified">RUNNING</span> : null}
        </div>
        <p className="mt-1 text-meta text-[color:var(--color-ink-muted)]">
          Started {formatDateTime(run.startedAt)}
          {run.finishedAt ? ` · finished ${formatDateTime(run.finishedAt)}` : ""}
        </p>

        <dl className="mt-3 grid grid-cols-3 border-t border-[color:var(--color-rule)]">
          <Metric label="Messages read" value={run.messagesConsidered} />
          <Metric label="Facts extracted" value={run.factsRecorded} />
          <Metric label="Candidates skipped" value={candidatesSkipped} />
        </dl>
        <p className="mt-1.5 text-meta text-[color:var(--color-ink-faint)]">
          Candidates skipped is what the pass read and set aside — the restraint the register runs
          on, counted here and nowhere else.
        </p>
      </section>

      <RunTrace trace={run.trace} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-r border-[color:var(--color-rule)] px-3 py-2 last:border-r-0">
      <dd className="board-type text-state leading-none text-[color:var(--color-ink)]">{value}</dd>
      <dt className="mt-1 text-label uppercase tracking-[0.1em] text-[color:var(--color-ink-faint)]">
        {label}
      </dt>
    </div>
  );
}

// ── the trace ────────────────────────────────────────────────────────────

function RunTrace({ trace }: { trace: TraceEntry[] }) {
  if (trace.length === 0) {
    return (
      <section aria-labelledby="activity-trace-heading">
        <p className="eyebrow" id="activity-trace-heading">
          Run trace
        </p>
        <p className="mt-1.5 text-body text-[color:var(--color-ink-muted)]">
          This pass recorded no trace — it had nothing to work through.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="activity-trace-heading">
      <p className="eyebrow" id="activity-trace-heading">
        Run trace
      </p>
      <ol className="mt-1.5 flex flex-col">
        {trace.map((entry, index) => (
          <TraceRow key={`${entry.node}-${index}`} entry={entry} step={index + 1} />
        ))}
      </ol>
    </section>
  );
}

function TraceRow({ entry, step }: { entry: TraceEntry; step: number }) {
  const tokens =
    entry.inputTokens !== undefined || entry.outputTokens !== undefined
      ? `${entry.inputTokens ?? 0} in · ${entry.outputTokens ?? 0} out`
      : null;
  const duration = entry.durationMs !== undefined ? `${entry.durationMs} ms` : null;
  const meta = [entry.model, tokens, duration].filter((part): part is string => Boolean(part));

  return (
    <li className="border-t border-[color:var(--color-rule)] py-2.5 first:border-t-0">
      <div className="flex items-baseline gap-2">
        <span className="text-meta tabular-nums text-[color:var(--color-ink-faint)]">
          {String(step).padStart(2, "0")}
        </span>
        <span className="board-type text-dense uppercase tracking-[0.06em] text-[color:var(--color-ink)]">
          {entry.node}
        </span>
      </div>

      {meta.length > 0 ? (
        <p className="mt-0.5 pl-6 text-meta text-[color:var(--color-ink-faint)]">
          {meta.join(" · ")}
        </p>
      ) : null}

      {entry.reasoning ? (
        <p className="mt-1 pl-6 text-body text-[color:var(--color-ink-muted)]">{entry.reasoning}</p>
      ) : null}

      {entry.toolCalls && entry.toolCalls.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-1 pl-6">
          {entry.toolCalls.map((call, callIndex) => (
            <li
              key={`${call.name}-${callIndex}`}
              className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-2 text-meta"
            >
              <span className="board-type text-[color:var(--color-ink)]">{call.name}</span>
              <span className="text-[color:var(--color-ink-faint)]">{call.argsSummary ?? "—"}</span>
              <span
                className={`code ${call.ok ? "code-active" : "code-held"}`}
                aria-label={call.ok ? "Tool call succeeded" : "Tool call failed"}
              >
                {call.ok ? "OK" : "FAIL"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// ── loading / empty / error ─────────────────────────────────────────────────

function ActivitySkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <div className="skeleton h-6 w-1/2" />
        <div className="skeleton h-3 w-3/4" />
        <div className="mt-2 grid grid-cols-3 gap-2">
          <div className="skeleton h-12" />
          <div className="skeleton h-12" />
          <div className="skeleton h-12" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-10 w-full" />
        <div className="skeleton h-10 w-full" />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="py-8">
      <p className="board-type text-lead text-[color:var(--color-ink)]">No pass has run yet.</p>
      <p className="mt-1 text-body text-[color:var(--color-ink-muted)]">
        Once Baton has read the group&rsquo;s messages, this is where its account of that pass will
        sit — what it read, what it kept, and what it set aside.
      </p>
    </div>
  );
}

function ErrorState({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="py-8" role="alert">
      <p className="board-type text-lead text-[color:var(--color-status-held)]">
        The activity could not be loaded.
      </p>
      <p className="mt-1 text-body text-[color:var(--color-ink-muted)]">{message}</p>
      <button type="button" className="btn mt-3" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
