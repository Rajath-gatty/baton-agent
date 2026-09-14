/**
 * The processing loop. `[F7]` `[F10]` `[F11]` `[F14]`
 *
 * Separate from intake, and that separation is the first design decision here: the
 * poll loop must never block on a model call, or one slow Curator stalls intake at
 * exactly the wrong moment. Intake persists; this curates.
 *
 * The order of operations is load bearing, top to bottom:
 *
 *  1. **Candidates are read in strict `sent_at` order.** Supersession is
 *     order-dependent — a contradiction applied before the claim it contradicts
 *     silently inverts a fact, and nothing about the result looks wrong afterwards.
 *  2. **The cache is consulted before batches are formed, not after.** This is the
 *     whole point of the cache. Batching first and then checking would send ten
 *     messages to the model to discover nine were already answered. Batches are formed
 *     from misses only, which is why their composition changes between runs, which is
 *     why the Curator prompt forbids cross-message inference.
 *  3. **Derivation runs one message at a time**, in the same `sent_at` order, whether
 *     the message's records came from a model call or from the cache. One code path,
 *     because the cached path is the one nobody watches.
 *  4. **`curated_at` is stamped last.** A crash between the model call and the writes
 *     leaves the message uncurated, so the next pass retries it — and the retry is free
 *     because the Curator's answer is already cached. Stamping first would turn the
 *     same crash into a message skipped forever, which is the one failure this pipeline
 *     cannot detect on its own.
 *
 * Three writes deliberately sit **outside** the pipeline lock's transaction, and each
 * for its own reason:
 *
 *   - The `runs` row, so a failed pass still leaves a record of having failed. A run
 *     that rolled back its own evidence of existing is undiagnosable.
 *   - The curator cache, so a model call that was paid for is never paid for twice.
 *     The Curator's answer for a given text at a given prompt version is true
 *     independently of whether the derivation that followed it committed.
 *   - Nothing else. Every register write is inside, so a pass either lands or does not.
 */

import {
  AliasIndex,
  CURATOR_PROMPT_VERSION,
  INGEST_BATCH_SIZE,
  classifyConsequence,
  decideFactStatus,
  ingestResultSchema,
  type AgentRequest,
  type CandidateMessage,
  type CuratorMessageResult,
  type IngestContext,
  type IngestResult,
  type RunKind,
  type RunStatus,
  type TraceEntry,
} from "@baton/core";
import type { Database } from "@baton/core/db";
import type { AgentTransport } from "../agent/transport.js";
import {
  lookupCuratorCache,
  rebindCachedResult,
  storeCuratorCache,
  type CuratorCacheEntry,
} from "../store/curator-cache.js";
import { applyCommitment, detectCommitmentClosure } from "../store/commitments.js";
import { applyCoverage } from "../store/coverage.js";
import { applyFact } from "../store/facts.js";
import { applyHolding } from "../store/holdings.js";
import { withPipelineLock } from "../store/lock.js";
import { markMessagesCurated } from "../store/messages.js";
import { closeRun, openRun } from "../store/runs.js";
import type { Executor, Transaction } from "../store/types.js";
import { requestFactApproval } from "./approval.js";
import { attributeRecords } from "./attribute.js";
import { hydrateIngestContext } from "./hydrate.js";
import { splitIngestResult } from "./ingest-result.js";
import { upsertEntitiesFromIngest } from "./entities.js";
import { selectCurationCandidates, type CurationCandidate } from "./prefilter.js";

/**
 * How many candidates one pass considers.
 *
 * Five batches' worth. Bounded because the pass holds the pipeline lock inside one
 * transaction, and an unbounded pass over a six-month backfill would hold it for as
 * long as the backfill takes. Backfill instead calls this repeatedly and passes its own
 * run id, so each transaction stays small while the run row spans the whole replay.
 */
export const DEFAULT_PASS_LIMIT = INGEST_BATCH_SIZE * 5;

export interface ProcessingLoopDeps {
  db: Database;
  transport: AgentTransport;
  /** Injectable so a test can assert on a fixed instant rather than on "roughly now". */
  now?: () => Date;
}

export interface ProcessingPassOptions {
  limit?: number;
  /** Defaults to `ingest`. Backfill passes `backfill`. */
  kind?: RunKind;
  /**
   * An existing run to report into. Supplied by backfill, which wants one run row
   * across many passes; when absent this pass opens and closes its own.
   */
  runId?: string;
}

export interface ProcessingPassResult {
  /** Null only when the lock was held and this pass never opened a run. */
  runId: string | null;
  status: RunStatus | "skipped";
  /** True when another pass held the lock. Not an error: the work is being done. */
  lockHeld: boolean;

  candidates: number;
  cacheHits: number;
  cacheMisses: number;
  batches: number;
  /** Rows written or updated in `facts`. */
  factsExtracted: number;
  commitmentsRecorded: number;
  commitmentsClosed: number;
  coverageObservations: number;
  holdingsChanged: number;
  /** Lifecycle records seen. Counted, never written — see the note at the call site. */
  lifecycleSeen: number;
  /** High-consequence claims held back for a human to agree to. */
  approvalsRequested: number;
  /** Of those, how many wait behind another approval about the same asset. */
  approvalsQueuedBehind: number;
  assetsCreated: number;
  capabilitiesCreated: number;
  aliasesLearned: number;
  /** Mentions that could not be settled. These become clarification questions. */
  unresolvedMentions: number;
  messagesCurated: number;
  trace: TraceEntry[];
}

function emptyResult(runId: string | null): ProcessingPassResult {
  return {
    runId,
    status: "complete",
    lockHeld: false,
    candidates: 0,
    cacheHits: 0,
    cacheMisses: 0,
    batches: 0,
    factsExtracted: 0,
    commitmentsRecorded: 0,
    commitmentsClosed: 0,
    coverageObservations: 0,
    holdingsChanged: 0,
    lifecycleSeen: 0,
    approvalsRequested: 0,
    approvalsQueuedBehind: 0,
    assetsCreated: 0,
    capabilitiesCreated: 0,
    aliasesLearned: 0,
    unresolvedMentions: 0,
    messagesCurated: 0,
    trace: [],
  };
}

/** The request shape the agent's `ingest` handler validates against. */
function toCandidateMessage(candidate: CurationCandidate): CandidateMessage {
  return {
    messageId: candidate.id,
    senderMention: candidate.senderMention,
    sentAt: candidate.sentAt.toISOString(),
    // Non-null by the selecting query's `text is not null`; narrowed here rather than
    // asserted, because a `!` would survive a future change to that query.
    text: candidate.text ?? "",
    replyToText: candidate.replyToText,
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Sends one batch and returns its validated result.
 *
 * An `interrupt` stop reason is rejected rather than ignored. Nothing in `ingest` is
 * supposed to raise one — approval routing for a high-consequence claim is decided by
 * the worker's own consequence classification, not by the agent — so an interrupt here
 * means the contract has changed, and silently dropping it would silently drop whatever
 * it was asking about.
 */
async function invokeIngest(
  transport: AgentTransport,
  request: AgentRequest,
  trace: TraceEntry[],
): Promise<IngestResult> {
  const response = await transport.invoke(request);
  trace.push(...response.trace);

  if (response.stopReason === "error") {
    throw new Error(`Agent ingest failed: ${response.error ?? "no error was reported"}`);
  }
  if (response.stopReason === "interrupt") {
    throw new Error(
      "Agent ingest raised an interrupt, which the ingest path does not implement. " +
        "Approval routing for high-consequence claims is decided by the worker.",
    );
  }

  return ingestResultSchema.parse(response.result);
}

/**
 * Applies one message's records to the register.
 *
 * Every write for the message goes through here, in one order, so the cached path and
 * the fresh path cannot diverge. Returns counters rather than logging, so a test can
 * assert on the decisions rather than on side effects.
 */
async function deriveMessage(
  tx: Executor,
  candidate: CurationCandidate,
  ingest: IngestResult,
  timezone: string,
  reasoningByMessage: Map<string, string>,
  counters: ProcessingPassResult,
): Promise<void> {
  const entities = await upsertEntitiesFromIngest(tx, ingest);

  counters.assetsCreated += entities.assetsCreated;
  counters.capabilitiesCreated += entities.capabilitiesCreated;
  counters.aliasesLearned += entities.aliasesLearned;
  counters.unresolvedMentions += entities.unresolved.length;

  const curatorReasoning = reasoningByMessage.get(candidate.id) ?? "";

  for (const resolved of entities.records) {
    const { record, holder, assetId, capabilityId } = resolved;

    switch (record.kind) {
      case "durable_fact": {
        const fact = await applyFact(tx, {
          record,
          holder,
          assetId,
          messageId: candidate.id,
          statedAt: candidate.sentAt,
          statedByPersonId: candidate.senderPersonId,
          timezone,
          curatorReasoning,
        });
        if (fact.outcome !== "skipped") counters.factsExtracted += 1;

        // **The worker's own approval gate.** `applyFact` has already written the claim as
        // `pending_approval` — invisible to every detection query, the fact index and the
        // brief context — but a claim held back that nobody is ever asked about is just a
        // claim quietly lost. This is what turns the status into a question.
        if (fact.requiresApproval && fact.factId !== null) {
          const requested = await requestFactApproval(tx, {
            record,
            factId: fact.factId,
            assetId,
            reason: fact.reason,
          });
          counters.approvalsRequested += 1;
          if (!requested.asked) counters.approvalsQueuedBehind += 1;
        }

        // Driven by what the fact did, not by comparing holders. `applyFact` already
        // made that judgment through the value signature; deciding it again here would
        // be a second, weaker copy that eventually disagrees with the first.
        const holding = await applyHolding(tx, {
          assetId,
          holder,
          factOutcome: fact.outcome,
          factId: fact.factId,
          ...(fact.supersededFactId === undefined
            ? {}
            : { supersededFactId: fact.supersededFactId }),
          at: candidate.sentAt,
        });
        if (holding.outcome !== "skipped" && holding.outcome !== "unchanged") {
          counters.holdingsChanged += 1;
        }
        break;
      }

      case "commitment": {
        const commitment = await applyCommitment(tx, {
          record,
          holder,
          messageId: candidate.id,
          statedAt: candidate.sentAt,
          timezone,
        });
        if (commitment.outcome === "recorded") counters.commitmentsRecorded += 1;
        break;
      }

      case "participation_evidence": {
        // No capability means nothing to record coverage against. A thanks-list with no
        // named activity is warmth, not evidence.
        if (capabilityId === null) break;

        // **The F33 gate for coverage, and it has to be here.** Every detection query
        // filters `status = 'active'` so that an unverified or pending claim can never
        // reach a finding — but `capability_coverage` is not derived from `facts` and has
        // no status column, so the capability detection query has nothing to filter on.
        // Without this check, "someone told me Anil ran the stall" would produce coverage
        // indistinguishable from having watched him do it, and a sole-holder finding
        // resting on a rumour is exactly what F33 exists to prevent.
        //
        // The same policy `facts` uses, reused rather than restated: record coverage only
        // where the equivalent claim would have been written `active`.
        const standing = decideFactStatus({
          consequence: classifyConsequence({
            assetKind: record.assetKind,
            sensitivity: record.sensitivity,
          }),
          confidence: record.confidence,
          isHearsay: record.isHearsay,
        });
        if (standing.status !== "active") break;

        const coverage = await applyCoverage(tx, {
          capabilityId,
          personIds: resolved.subjectPersonIds,
          observedAt: candidate.sentAt,
          messageId: candidate.id,
        });
        counters.coverageObservations += coverage.added + coverage.widened;
        break;
      }

      case "lifecycle_event": {
        // Counted, not written. Membership transitions come from Telegram's
        // `chat_member` update, which is authoritative and is what a brief fires from.
        // Prose is ambiguous about tense in exactly the way that matters — "Meera is
        // leaving next month" would mark her gone today — so a sentence is a signal
        // that something happened, not evidence that it has.
        counters.lifecycleSeen += 1;
        break;
      }
    }
  }

  // After the records, so a promise made in this message exists before anything tries
  // to close it. `detectCommitmentClosure` additionally requires `promisedAt` to be
  // strictly earlier than the closing message, so a message cannot close its own
  // promise — a promise cannot be kept before it was made.
  const closure = await detectCommitmentClosure(tx, {
    messageId: candidate.id,
    text: candidate.text,
    sentAt: candidate.sentAt,
    personId: candidate.senderPersonId,
  });
  counters.commitmentsClosed += closure.closed.length;
}

/**
 * One pass of the processing loop.
 *
 * Returns `lockHeld` rather than throwing or waiting when another pass is running. A
 * blocked pass is not an error — the work is being done by whoever holds the lock, and
 * the next tick finds whatever is left. Waiting would queue ticks behind each other and
 * turn one slow model call into a growing backlog of identical passes.
 */
export async function runIngestPass(
  deps: ProcessingLoopDeps,
  options: ProcessingPassOptions = {},
): Promise<ProcessingPassResult> {
  const { db, transport } = deps;
  const now = deps.now?.() ?? new Date();
  const limit = options.limit ?? DEFAULT_PASS_LIMIT;
  const kind: RunKind = options.kind ?? "ingest";
  const ownsRun = options.runId === undefined;

  const trace: TraceEntry[] = [];
  // Collected inside the locked transaction and written after it commits, so a model
  // call already paid for is never paid for twice — even if the derivation that
  // followed it rolled back.
  const cacheWrites: CuratorCacheEntry[] = [];
  let runId: string | null = options.runId ?? null;

  try {
    const outcome = await withPipelineLock(db, async (tx) => {
      // Opened on `db` rather than `tx`: the run row must survive a rollback of the
      // work it describes.
      if (runId === null) runId = await openRun(db, kind);

      return executePass(tx, {
        transport,
        runId,
        limit,
        now,
        trace,
        cacheWrites,
      });
    });

    if (outcome === null) {
      // Another pass holds the lock. If this call opened no run, there is nothing to
      // close and nothing to report — which is the honest representation of "did not
      // run" rather than a zero-counter run row in the activity panel.
      return { ...emptyResult(runId), status: "skipped", lockHeld: true };
    }

    await storeCuratorCache(db, cacheWrites, CURATOR_PROMPT_VERSION);

    const result: ProcessingPassResult = { ...outcome, runId, trace };
    if (ownsRun && runId !== null) {
      await closeRun(db, runId, {
        status: "complete",
        counters: {
          messagesRead: result.candidates,
          candidates: result.candidates,
          factsExtracted: result.factsExtracted,
        },
        trace,
      });
    }
    return result;
  } catch (error) {
    // The cache still gets what the model already answered. The pass failed; the
    // classifications it bought did not become untrue.
    if (cacheWrites.length > 0) {
      await storeCuratorCache(db, cacheWrites, CURATOR_PROMPT_VERSION).catch(() => undefined);
    }
    if (ownsRun && runId !== null) {
      await closeRun(db, runId, {
        status: "failed",
        trace,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

interface ExecutePassInput {
  transport: AgentTransport;
  runId: string;
  limit: number;
  now: Date;
  trace: TraceEntry[];
  cacheWrites: CuratorCacheEntry[];
}

/** The locked half. Everything here either commits together or not at all. */
async function executePass(
  tx: Transaction,
  { transport, runId, limit, now, trace, cacheWrites }: ExecutePassInput,
): Promise<ProcessingPassResult> {
  const counters = emptyResult(null);

  const candidates = (await selectCurationCandidates(tx, limit)).filter(
    (candidate) => candidate.text !== null && candidate.text.trim() !== "",
  );
  counters.candidates = candidates.length;
  if (candidates.length === 0) return counters;

  // ── The cache, before any batch exists ─────────────────────────────────────
  const cached = await lookupCuratorCache(
    tx,
    candidates.map((candidate) => candidate.contentHash),
    CURATOR_PROMPT_VERSION,
  );

  const misses: CurationCandidate[] = [];
  const resultByMessage = new Map<string, CuratorMessageResult>();

  for (const candidate of candidates) {
    const hit = cached.get(candidate.contentHash);
    if (hit === undefined) {
      misses.push(candidate);
      continue;
    }
    // Rebound to *this* message. The stored id belongs to whichever message was curated
    // first for this content, and two identical messages six months apart is enough to
    // attribute a record to the wrong day.
    resultByMessage.set(candidate.id, rebindCachedResult(hit, candidate.id));
    counters.cacheHits += 1;
  }
  counters.cacheMisses = misses.length;

  const context: IngestContext = await hydrateIngestContext(tx, now);

  // ── Batches, from misses only ──────────────────────────────────────────────
  const batches = chunk(misses, INGEST_BATCH_SIZE);
  counters.batches = batches.length;

  const attributionsByMessage = new Map<string, IngestResult>();

  for (const batch of batches) {
    const request: AgentRequest = {
      task: "ingest",
      runId,
      payload: { messages: batch.map(toCandidateMessage) },
      context,
    };

    const ingest = await invokeIngest(transport, request, trace);

    for (const perMessage of splitIngestResult(ingest)) {
      attributionsByMessage.set(perMessage.messageId, perMessage.ingest);
      const result = perMessage.ingest.curator.results[0];
      if (result === undefined) continue;
      resultByMessage.set(perMessage.messageId, result);

      const candidate = batch.find((entry) => entry.id === perMessage.messageId);
      if (candidate !== undefined) {
        cacheWrites.push({ contentHash: candidate.contentHash, result });
      }
    }
  }

  // ── Attribution for the cached half ────────────────────────────────────────
  // Built once for the whole pass and reused, because a pass can carry a hundred
  // mentions and the index is the same for all of them.
  const aliasIndex = new AliasIndex(context.aliases);

  // ── Derivation, one message at a time, in `sent_at` order ──────────────────
  const reasoningByMessage = new Map<string, string>();
  for (const [messageId, result] of resultByMessage) {
    reasoningByMessage.set(messageId, result.reasoning);
  }

  const curated: string[] = [];

  for (const candidate of candidates) {
    const result = resultByMessage.get(candidate.id);
    if (result === undefined) {
      // The agent guarantees one result per message in a batch and fails the whole call
      // otherwise, so this is unreachable through the normal path. Left uncurated rather
      // than stamped, so the next pass retries it against the cache instead of dropping
      // it silently.
      continue;
    }

    const ingest =
      attributionsByMessage.get(candidate.id) ??
      // A cache hit: the Curator's records are known, the attributions are not, and they
      // are resolved here against the alias table as it stands now.
      ({
        curator: { results: [result] },
        cartographer: { attributions: attributeRecords(result.records, aliasIndex) },
      } satisfies IngestResult);

    await deriveMessage(tx, candidate, ingest, context.org.timezone, reasoningByMessage, counters);
    curated.push(candidate.id);
  }

  counters.messagesCurated = await markMessagesCurated(tx, curated, now);
  return counters;
}
