"use client";

/**
 * The fact detail panel — the provenance surface.
 *
 * Mounted once in the layout. It listens for the `baton:open-fact` event the
 * `Claim` primitive dispatches, so a claim anywhere in the product is one
 * gesture from its evidence. Reachability from every surface is what makes the
 * register trustworthy; a per-page panel would let one page quietly lack it.
 *
 * It is a native `<dialog>`, not an absolutely positioned div, because a claim
 * lives inside a scrolling chart and an overlay inside an `overflow` ancestor
 * would be clipped. `showModal()` also gives Escape-to-close, a backdrop, and a
 * focus trap for free, which is the accessible behaviour we want.
 *
 * What it shows, in the order a coordinator reads it: the claim and its status;
 * who has held the topic, as a history that acquires and releases rather than
 * overwrites; the source message quoted verbatim and redacted [F30]; the chain
 * of facts this one superseded; Baton's own reasoning; and the three actions.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { containsCredential, redactCredentials } from "@baton/core";
import type { Fact, Holding } from "@/lib/types";
import { getFact, getHoldingsByKind } from "@/lib/data";
import { factStatusLabel, formatDate, formatDateTime } from "@/lib/format";
import { OPEN_FACT_EVENT, StatusCode, type OpenFactDetail } from "@/components/primitives";

/** What the panel is doing right now. Drives the seven states below. */
type PanelPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; fact: Fact; chain: Fact[]; holdings: Holding[] }
  | { kind: "empty" }
  | { kind: "error"; message: string };

/** Actions a coordinator can take on a fact. Each carries its own pending flag. */
type ActionKey = "correct" | "retire" | "verify";

export function FactPanel() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<PanelPhase>({ kind: "idle" });
  const [pendingAction, setPendingAction] = useState<ActionKey | null>(null);

  /**
   * Walk the supersession chain by following `supersedes`, oldest last. Guarded
   * against a cycle in synthetic data with a visited set so a bad fixture can
   * never hang the panel.
   */
  const loadFact = useCallback(async (factId: string) => {
    setPhase({ kind: "loading" });
    setPendingAction(null);
    try {
      const fact = await getFact(factId);
      if (!fact) {
        setPhase({ kind: "empty" });
        return;
      }

      const chain: Fact[] = [];
      const seen = new Set<string>([fact.id]);
      let cursor = fact.supersedes;
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const prior = await getFact(cursor);
        if (!prior) break;
        chain.push(prior);
        cursor = prior.supersedes;
      }

      // Holdings whose topic matches this fact's, so the panel can show holding
      // history without the fact type carrying a holder itself (it must not —
      // a fact is about a claim, holders are an attribute of the asset).
      const groups = await getHoldingsByKind();
      const holdings = groups
        .flatMap((group) => group.entries)
        .filter((entry) => topicMatchesAsset(fact.topic, entry.asset.label))
        .flatMap((entry) => entry.holdings);

      setPhase({ kind: "ready", fact, chain, holdings });
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
  }, []);

  /**
   * Actions are demonstration-only until the write seam lands: they resolve
   * after a short delay so the loading and disabled states are exercised, then
   * clear. No fixture is mutated. Wiring these to real writes is a later stage.
   */
  const runAction = useCallback((key: ActionKey) => {
    setPendingAction(key);
    window.setTimeout(() => setPendingAction(null), 900);
  }, []);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby="fact-panel-title"
      className="w-[min(42rem,calc(100vw-4rem))] max-h-[calc(100vh-4rem)] overflow-hidden border border-[color:var(--color-rule-strong)] bg-transparent p-0"
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
            <FactBody fact={phase.fact} chain={phase.chain} holdings={phase.holdings} />
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--color-rule)] px-5 py-3">
          <FactActions phase={phase} pendingAction={pendingAction} onAction={runAction} />
        </footer>
      </div>
    </dialog>
  );
}

// ── body ────────────────────────────────────────────────────────────────────

function FactBody({ fact, chain, holdings }: { fact: Fact; chain: Fact[]; holdings: Holding[] }) {
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

      {/* The source, verbatim and redacted. This is F30. */}
      <SourceQuote fact={fact} />

      {/* The supersession chain, if this fact replaced earlier ones. */}
      <SupersessionChain chain={chain} />

      {/* Baton's own account of why it stored the fact. */}
      <section aria-labelledby="fact-reasoning-heading">
        <p className="eyebrow" id="fact-reasoning-heading">
          Why Baton stored this
        </p>
        <p className="mt-1.5 text-body text-[color:var(--color-ink-muted)]">{reasoningFor(fact)}</p>
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

// ── source quote (F30) ──────────────────────────────────────────────────────

function SourceQuote({ fact }: { fact: Fact }) {
  const raw = fact.sourceMessage.text;
  const redacted = redactCredentials(raw);
  const wasRedacted = containsCredential(raw);

  return (
    <section aria-labelledby="fact-source-heading">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" id="fact-source-heading">
          Source message
        </p>
        {wasRedacted ? (
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
          &ldquo;{redacted}&rdquo;
        </blockquote>
        <figcaption className="mt-1 text-meta text-[color:var(--color-ink-muted)]">
          {fact.sourceMessage.authorName} · {formatDateTime(fact.sourceMessage.sentAt)}
        </figcaption>
      </figure>
      {wasRedacted ? (
        <p className="mt-1.5 text-meta text-[color:var(--color-ink-faint)]">
          A credential in the original was removed for display. The register never stores a secret
          as a fact — only who holds one.
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
  { key: "correct", label: "Correct", primary: false },
  { key: "retire", label: "Retire", primary: false },
  { key: "verify", label: "Mark verified", primary: true },
];

function FactActions({
  phase,
  pendingAction,
  onAction,
}: {
  phase: PanelPhase;
  pendingAction: ActionKey | null;
  onAction: (key: ActionKey) => void;
}) {
  const ready = phase.kind === "ready";
  const busy = pendingAction !== null;
  // "Mark verified" only makes sense for a fact awaiting confirmation.
  const verifiable =
    ready && (phase.fact.status === "unverified" || phase.fact.status === "pending_approval");

  return (
    <>
      {ACTIONS.map((action) => {
        const isVerify = action.key === "verify";
        const disabled = !ready || busy || (isVerify && !verifiable);
        const pending = pendingAction === action.key;
        return (
          <button
            key={action.key}
            type="button"
            className={action.primary ? "btn btn-primary" : "btn"}
            onClick={() => onAction(action.key)}
            disabled={disabled}
            aria-busy={pending}
          >
            {pending ? "Working…" : action.label}
          </button>
        );
      })}
    </>
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
 * A fact's topic and an asset's label share a subject phrase (e.g. "Public
 * presence — Instagram" ↔ "Instagram — @streetpaws.blr"). Match on the shared
 * significant word rather than requiring a foreign key the fixture layer does
 * not model yet; when the schema lands this becomes a join.
 */
function topicMatchesAsset(topic: string, assetLabel: string): boolean {
  const key = significantWord(topic);
  if (!key) return false;
  return assetLabel.toLowerCase().includes(key);
}

function significantWord(topic: string): string | null {
  // Take the phrase after the em dash if present, else the whole topic, and
  // reduce to its first meaningful token.
  const parts = topic.split("—");
  const tailPart = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const tail = (tailPart ?? "").trim().toLowerCase();
  const words = tail.split(/\s+/).filter((w) => w.length > 3);
  return words[0] ?? null;
}

/**
 * Baton's reasoning for storing the fact. Facts do not carry a reasoning field
 * of their own; the register's rule is stated per status so the panel always
 * has a stated reason rather than an empty section.
 */
function reasoningFor(fact: Fact): string {
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
