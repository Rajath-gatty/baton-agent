"use client";

/**
 * The fact detail panel — the provenance surface.
 *
 * Mounted once in the layout for the whole one-page document. It listens for the
 * `baton:open-fact` event the `Claim` primitive dispatches, so a claim anywhere —
 * the register, the inventory, a brief line — is one gesture from its evidence.
 * Reachability from every surface is what makes the register trustworthy.
 *
 * It is a native `<dialog>`, not an absolutely positioned div, because a claim
 * lives inside a scrolling chart and an overlay inside an `overflow` ancestor
 * would be clipped. `showModal()` also gives Escape-to-close, a backdrop, and a
 * focus trap for free, which is the accessible behaviour we want.
 *
 * Its reads cross to the server through `loadFactDetail` rather than importing the
 * data seam directly: this is a client component, and importing `lib/data.ts` here
 * would drag the whole read layer — a database client, once the schema lands —
 * into the browser bundle.
 *
 * Credential redaction [F30] therefore happens on the server too, and the raw text
 * is stripped before it crosses. Redacting in this component would have shipped the
 * literal credential to the browser and called it redacted because the pixels never
 * showed it.
 *
 * What it shows, in the order a coordinator reads it: the claim and its status;
 * who has held the subject, as a history that acquires and releases rather than
 * overwrites; the source message quoted verbatim and redacted [F30]; the chain of
 * facts this one superseded; Baton's own reasoning; and the actions — including
 * withdrawing the quote when the message behind it is gone [F4].
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Fact, Holding } from "@/lib/types";
import { loadFactDetail, type FactDetail } from "@/app/panel-actions";
import { withdrawProvenance } from "@/app/actions";
import { factStatusLabel, formatDate, formatDateTime } from "@/lib/format";
import { OPEN_FACT_EVENT, StatusCode, type OpenFactDetail } from "@/components/primitives";

/** What the panel is doing right now. Drives the seven states below. */
type PanelPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; detail: FactDetail }
  | { kind: "empty" }
  | { kind: "error"; message: string };

/** Actions a coordinator can take on a fact. Each carries its own pending flag. */
type ActionKey = "correct" | "retire" | "verify" | "withdraw";

export function FactPanel() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<PanelPhase>({ kind: "idle" });
  const [pendingAction, setPendingAction] = useState<ActionKey | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const loadFact = useCallback(async (factId: string) => {
    setPhase({ kind: "loading" });
    setPendingAction(null);
    setConfirmWithdraw(false);
    try {
      const detail = await loadFactDetail(factId);
      if (!detail) {
        setPhase({ kind: "empty" });
        return;
      }
      setPhase({ kind: "ready", detail });
    } catch (cause) {
      setPhase({
        kind: "error",
        message: cause instanceof Error ? cause.message : "The fact could not be loaded.",
      });
    }
  }, []);

  // Open on the shared event; the dialog element itself is the modal surface.
  useEffect(() => {
    function onOpen(event: Event) {
      const detail = (event as CustomEvent<OpenFactDetail>).detail;
      if (!detail?.factId) return;
      const dialog = dialogRef.current;
      if (dialog && !dialog.open) dialog.showModal();
      void loadFact(detail.factId);
    }
    window.addEventListener(OPEN_FACT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_FACT_EVENT, onOpen);
  }, [loadFact]);

  const close = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  // Reset to idle after the closing transition so a reopen starts clean, and so
  // the previous fact is not briefly visible behind a new load.
  const onClose = useCallback(() => {
    setPhase({ kind: "idle" });
    setPendingAction(null);
    setConfirmWithdraw(false);
  }, []);

  /**
   * Correct, retire and mark-verified are demonstration-only until their write
   * seam lands: they resolve after a short delay so the loading and disabled
   * states are exercised, then clear. Withdrawing provenance is different — it
   * goes through the real server action, because that action's whole job is to
   * stop showing a quote, which is a thing this panel can honour immediately.
   */
  const runAction = useCallback(
    (key: ActionKey) => {
      if (key !== "withdraw") {
        setPendingAction(key);
        window.setTimeout(() => setPendingAction(null), 900);
        return;
      }

      if (phase.kind !== "ready") return;

      // First press asks; second press acts. Withdrawing a quote is not
      // destructive — the fact stays — but it is the one action that changes what
      // a later reader can see, so it is worth one deliberate beat.
      if (!confirmWithdraw) {
        setConfirmWithdraw(true);
        return;
      }

      const factId = phase.detail.fact.id;
      setPendingAction("withdraw");
      void withdrawProvenance(factId)
        .then((result) => {
          if (result.status === "ok") {
            setPhase((current) =>
              current.kind === "ready"
                ? {
                    ...current,
                    detail: {
                      ...current.detail,
                      fact: { ...current.detail.fact, provenanceWithdrawn: true },
                      // The quote stops travelling as well as stops showing.
                      sourceText: null,
                      credentialRedacted: false,
                    },
                  }
                : current,
            );
          }
        })
        .finally(() => {
          setPendingAction(null);
          setConfirmWithdraw(false);
        });
    },
    [confirmWithdraw, phase],
  );

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby="fact-panel-title"
      className="max-h-[calc(100vh-4rem)] w-[min(42rem,calc(100vw-4rem))] overflow-hidden border border-[color:var(--color-rule-strong)] bg-transparent p-0"
    >
      <div className="sheet flex max-h-[calc(100vh-4rem)] flex-col">
        <header className="flex items-baseline justify-between gap-4 border-b border-[color:var(--color-rule)] px-5 py-3">
          <p className="eyebrow" id="fact-panel-title">
            Fact — provenance
          </p>
          <button type="button" className="btn" onClick={close} aria-label="Close fact panel">
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {phase.kind === "loading" || phase.kind === "idle" ? (
            <FactSkeleton />
          ) : phase.kind === "empty" ? (
            <EmptyState />
          ) : phase.kind === "error" ? (
            <ErrorState message={phase.message} onRetry={close} />
          ) : (
            <FactBody detail={phase.detail} />
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-[color:var(--color-rule)] px-5 py-3">
          <WithdrawHint phase={phase} confirming={confirmWithdraw} />
          <div className="flex items-center gap-2">
            <FactActions
              phase={phase}
              pendingAction={pendingAction}
              confirming={confirmWithdraw}
              onAction={runAction}
            />
          </div>
        </footer>
      </div>
    </dialog>
  );
}

// ── body ────────────────────────────────────────────────────────────────────

function FactBody({ detail }: { detail: FactDetail }) {
  const { fact, chain, holdings } = detail;

  return (
    <div className="flex flex-col gap-5">
      {/* The claim and its status. */}
      <section aria-labelledby="fact-claim-heading">
        <div className="flex items-start justify-between gap-4">
          <h2
            id="fact-claim-heading"
            className="board-type text-sub leading-tight text-[color:var(--color-ink)]"
          >
            {fact.statement}
          </h2>
          <StatusCode status={fact.status} />
        </div>
        <p className="mt-1 text-meta text-[color:var(--color-ink-muted)]">
          {fact.topic} · Recorded {formatDate(fact.recordedAt)} · {factStatusLabel(fact.status)}
        </p>
      </section>

      {/* Holder history — acquired and released, never overwritten. */}
      <HolderHistory holdings={holdings} />

      {/* The source, verbatim and redacted. This is F30, and F4 when withdrawn. */}
      <SourceQuote detail={detail} />

      {/* The supersession chain, if this fact replaced earlier ones. */}
      <SupersessionChain chain={chain} />

      {/* Baton's own account of why it stored the fact. */}
      <section aria-labelledby="fact-reasoning-heading">
        <p className="eyebrow" id="fact-reasoning-heading">
          Why Baton stored this
        </p>
        <p className="mt-1.5 text-body text-[color:var(--color-ink-muted)]">{reasoningFor(fact)}</p>
        {fact.curatorReasoning === null ? (
          <p className="mt-1 text-label text-[color:var(--color-ink-faint)]">
            The Curator recorded no reasoning for this claim, so the register&rsquo;s own rule for
            its status is stated instead.
          </p>
        ) : null}
      </section>
    </div>
  );
}

// ── holder history ────────────────────────────────────────────────────────

function HolderHistory({ holdings }: { holdings: Holding[] }) {
  if (holdings.length === 0) {
    // Good news, not an error: nothing about this fact rests on one person.
    return (
      <section aria-labelledby="fact-holders-heading">
        <p className="eyebrow" id="fact-holders-heading">
          Holding history
        </p>
        <p className="mt-1.5 text-body text-[color:var(--color-ink-muted)]">
          No holding has been recorded against this — it rests on no single pair of hands.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="fact-holders-heading">
      <p className="eyebrow" id="fact-holders-heading">
        Holding history
      </p>
      <ul className="mt-1.5 flex flex-col">
        {holdings.map((holding) => (
          <li
            key={holding.id}
            className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 border-t border-[color:var(--color-rule)] py-2 first:border-t-0"
          >
            <span className="board-type text-dense text-[color:var(--color-ink)]">
              {holding.holder ?? "No holder recorded"}
            </span>
            <span className="text-meta text-[color:var(--color-ink-faint)]">
              {holding.isPersonalResource ? "Personal resource · " : ""}
              {holding.lastSeenAt
                ? `last seen ${formatDate(holding.lastSeenAt)}`
                : "not seen exercised"}
            </span>
            <p className="col-span-2 text-body text-[color:var(--color-ink-muted)]">
              {holding.note}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── source quote (F30, and F4 once withdrawn) ───────────────────────────────

function SourceQuote({ detail }: { detail: FactDetail }) {
  const { fact, sourceText, credentialRedacted } = detail;

  // Withdrawn provenance: the quote is not shown at all — and did not travel from
  // the server either — and the panel says so plainly. The fact, its status and its
  // chain are untouched; that is the whole shape of this remedy.
  if (fact.provenanceWithdrawn || sourceText === null) {
    return (
      <section aria-labelledby="fact-source-heading">
        <div className="flex items-baseline justify-between gap-3">
          <p className="eyebrow" id="fact-source-heading">
            Source message
          </p>
          <span
            className="code code-closed"
            title="The quote has been withdrawn by the coordinator. The fact itself still stands."
          >
            WITHDRWN
          </span>
        </div>
        <p className="mt-1.5 text-body text-[color:var(--color-ink-muted)]">
          The quote was withdrawn on {fact.sourceMessage.authorName}&rsquo;s message of{" "}
          {formatDate(fact.sourceMessage.sentAt)}. Telegram does not tell Baton when a message is
          deleted, so this is how a coordinator stops the register quoting one that is gone. The
          claim above still stands, and its status has not changed.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="fact-source-heading">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" id="fact-source-heading">
          Source message
        </p>
        {credentialRedacted ? (
          <span
            className="code code-held"
            title="A credential was removed from this quote. It is not shown literally."
          >
            REDACTED
          </span>
        ) : null}
      </div>
      <figure className="mt-1.5 border-l-2 border-[color:var(--color-rule-strong)] pl-3">
        <blockquote className="text-body text-[color:var(--color-ink)]">
          &ldquo;{sourceText}&rdquo;
        </blockquote>
        <figcaption className="mt-1 text-meta text-[color:var(--color-ink-muted)]">
          {fact.sourceMessage.authorName} · {formatDateTime(fact.sourceMessage.sentAt)}
        </figcaption>
      </figure>
      {credentialRedacted ? (
        <p className="mt-1.5 text-meta text-[color:var(--color-ink-faint)]">
          A credential in the original was removed before this quote left the server. The register
          never stores a secret as a fact — only who holds one.
        </p>
      ) : null}
    </section>
  );
}

// ── supersession chain ──────────────────────────────────────────────────────

function SupersessionChain({ chain }: { chain: Fact[] }) {
  if (chain.length === 0) return null;

  return (
    <section aria-labelledby="fact-chain-heading">
      <p className="eyebrow" id="fact-chain-heading">
        This replaced {chain.length === 1 ? "an earlier fact" : "earlier facts"}
      </p>
      <ol className="mt-1.5 flex flex-col">
        {chain.map((prior) => (
          <li
            key={prior.id}
            className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 border-t border-[color:var(--color-rule)] py-2 first:border-t-0"
          >
            <StatusCode status={prior.status} />
            <div>
              <p className="text-body text-[color:var(--color-ink-muted)]">{prior.statement}</p>
              <p className="mt-0.5 text-meta text-[color:var(--color-ink-faint)]">
                Recorded {formatDate(prior.recordedAt)}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── actions ──────────────────────────────────────────────────────────────

const ACTIONS: { key: ActionKey; label: string; primary: boolean }[] = [
  { key: "withdraw", label: "Withdraw quote", primary: false },
  { key: "correct", label: "Correct", primary: false },
  { key: "retire", label: "Retire", primary: false },
  { key: "verify", label: "Mark verified", primary: true },
];

function FactActions({
  phase,
  pendingAction,
  confirming,
  onAction,
}: {
  phase: PanelPhase;
  pendingAction: ActionKey | null;
  confirming: boolean;
  onAction: (key: ActionKey) => void;
}) {
  const ready = phase.kind === "ready";
  const busy = pendingAction !== null;
  const fact = phase.kind === "ready" ? phase.detail.fact : null;
  // "Mark verified" only makes sense for a fact awaiting confirmation.
  const verifiable =
    fact !== null && (fact.status === "unverified" || fact.status === "pending_approval");
  // Nothing to withdraw once the quote is already withdrawn.
  const withdrawable = fact !== null && !fact.provenanceWithdrawn;

  return (
    <>
      {ACTIONS.map((action) => {
        const isVerify = action.key === "verify";
        const isWithdraw = action.key === "withdraw";
        const disabled =
          !ready || busy || (isVerify && !verifiable) || (isWithdraw && !withdrawable);
        const pending = pendingAction === action.key;
        const label = isWithdraw && confirming ? "Confirm withdraw" : action.label;
        return (
          <button
            key={action.key}
            type="button"
            className={action.primary ? "btn btn-primary" : "btn"}
            onClick={() => onAction(action.key)}
            disabled={disabled}
            aria-busy={pending}
            style={
              isWithdraw && confirming ? { borderColor: "var(--color-status-held)" } : undefined
            }
            title={
              isWithdraw
                ? "Stop showing the quoted message. The fact, its status and its trail all stay."
                : undefined
            }
          >
            {pending ? "Working…" : label}
          </button>
        );
      })}
    </>
  );
}

/**
 * The one line of the footer that explains itself. Withdrawing is the only action
 * here whose consequence is not obvious from its label, so the consequence is
 * stated in the footer rather than only in a tooltip nobody hovers.
 */
function WithdrawHint({ phase, confirming }: { phase: PanelPhase; confirming: boolean }) {
  if (phase.kind !== "ready") return <span />;

  if (phase.detail.fact.provenanceWithdrawn) {
    return (
      <span className="text-label text-[color:var(--color-ink-faint)]">
        The quote is withdrawn; the claim still stands.
      </span>
    );
  }

  if (confirming) {
    return (
      <span className="text-label text-[color:var(--color-status-held)]">
        Press again to stop showing the quote. Nothing else changes.
      </span>
    );
  }

  return (
    <span className="text-label text-[color:var(--color-ink-faint)]">
      Withdraw the quote if the message behind it was deleted.
    </span>
  );
}

// ── loading / empty / error ─────────────────────────────────────────────────

function FactSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <div className="skeleton h-6 w-3/4" />
        <div className="skeleton h-3 w-2/5" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-5/6" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="skeleton h-3 w-28" />
        <div className="skeleton h-16 w-full" />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="py-8">
      <p className="board-type text-lead text-[color:var(--color-ink)]">Nothing to trace here.</p>
      <p className="mt-1 text-body text-[color:var(--color-ink-muted)]">
        This claim has no fact behind it in the register — there is nothing standing that needs an
        owner.
      </p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="py-8" role="alert">
      <p className="board-type text-lead text-[color:var(--color-status-held)]">
        The fact could not be loaded.
      </p>
      <p className="mt-1 text-body text-[color:var(--color-ink-muted)]">{message}</p>
      <button type="button" className="btn mt-3" onClick={onRetry}>
        Close
      </button>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Why Baton stored the fact. The Curator's own reasoning when it recorded one —
 * `facts.curator_reasoning` — and otherwise the register's stated rule for that
 * status, so the section always has a real reason rather than an empty heading.
 * The fallback is labelled as a fallback in the body above; presenting a rule as
 * if it were a judgement about this particular claim would be a small lie.
 */
function reasoningFor(fact: Fact): string {
  if (fact.curatorReasoning !== null) return fact.curatorReasoning;

  switch (fact.status) {
    case "unverified":
      return "Recorded as unverified because it reached the register second-hand. It is held out of detection until it is confirmed, so a rumour cannot raise a finding.";
    case "pending_approval":
      return "Held for approval before it enters the register, because it proposes a change the coordinator should see first. It stays invisible to detection until then.";
    case "superseded":
      return "Kept as history after a later message revised it. Superseded facts are never deleted, so the record of what the group once knew stays intact.";
    case "retired":
      return "Retired from the active register but kept on the record. A retired fact no longer describes the present, but the trail to it remains.";
    case "active":
    default:
      return "Recorded as a durable operational fact: it names something the organisation knows and will still need to know after the person who said it has gone.";
  }
}
