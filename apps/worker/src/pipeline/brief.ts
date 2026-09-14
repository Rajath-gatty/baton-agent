/**
 * Generating a brief from a lifecycle event. `[F23]` `[F24]` `[F25]`
 *
 * **The brief fires from a Telegram membership event, not from a button.** That is the
 * product's central claim about itself: nobody remembers to press "generate handover notes"
 * on the day a volunteer leaves, which is exactly the day the knowledge walks out. So the
 * trigger is `chat_member`, and this module is what that event runs.
 *
 * Four things here are decisions rather than mechanics:
 *
 *   - **One brief per transition, not per event.** Telegram can deliver the same
 *     `chat_member` update twice, and a second handover document makes a coordinator wonder
 *     which is current. Keyed on the person's `left_at`/`joined_at`, so a genuine second
 *     departure months later still produces a second brief.
 *   - **The empty brief is generated and stored, not skipped.** "Nothing appears to have left
 *     with them" is a useful sentence. Three empty sections, or silence, both read as broken.
 *   - **Delivery is offered, and failure is normal.** A bot cannot open a conversation with
 *     someone who never wrote to it, which for most of a twenty-person roster means the
 *     subject cannot be reached — and a departing member least of all. The coordinator always
 *     gets it; the subject gets it if possible; and the text comes back either way so the UI
 *     can render it as copyable.
 *   - **The subject is told what is leaving with them, not asked to do anything.** No
 *     assignment, no chasing. Assignment is a coordinator action recorded in `brief_lines`.
 */

import {
  briefResultSchema,
  type AgentRequest,
  type BriefContext,
  type BriefKind,
  type BriefResult,
  type RunKind,
  type RunStatus,
  type TraceEntry,
} from "@baton/core";
import type { Database } from "@baton/core/db";
import type { AgentTransport } from "../agent/transport.js";
import { findBriefForTransition, storeBrief, type StoredBrief } from "../store/briefs.js";
import { recordQuietDecisions } from "../store/quiet-decisions.js";
import { closeRun, openRun } from "../store/runs.js";
import { sendPrivately, sendToCoordinator } from "../telegram/private-delivery.js";
import type { OutboundQueue } from "../telegram/outbound-queue.js";
import { hydrateBriefContext } from "./hydrate.js";
import { findPersonForBrief } from "../store/people.js";
import type { Executor } from "../store/types.js";

export interface BriefDeps {
  db: Database;
  transport: AgentTransport;
  queue: OutboundQueue;
  now?: () => Date;
}

export interface BriefRequest {
  kind: BriefKind;
  subjectPersonId: string;
  /** The message that prompted it, where there was one. A membership event has none. */
  triggeredByMessageId?: string | null;
  /** Skip the one-per-transition guard. For a coordinator regenerating deliberately. */
  force?: boolean;
  runId?: string;
}

export type BriefDelivery = "sent" | "undeliverable" | "not_attempted";

export interface BriefPassResult {
  runId: string | null;
  status: RunStatus | "skipped";
  /** Null when the guard found an existing brief for this transition. */
  briefId: string | null;
  /** True when an existing brief for the same transition was reused rather than regenerated. */
  duplicate: boolean;
  isEmpty: boolean;
  lineCount: number;
  quietDecisions: number;
  /** Whether the subject themselves could be reached. Failure is ordinary. */
  toSubject: BriefDelivery;
  toCoordinator: BriefDelivery;
  /** The rendered brief, so an undeliverable one is still copyable in the UI. */
  text: string;
  trace: TraceEntry[];
}

/**
 * Renders a brief as the message a person reads.
 *
 * Sections are headed only when they have lines, which is what keeps the empty case from
 * rendering as three headings with nothing under them. The opening line carries the empty
 * case on its own, which is why the schema requires one even then.
 */
export function renderBrief(result: BriefResult): string {
  const { brief } = result;
  if (brief.isEmpty || brief.lines.length === 0) return brief.openingLine;

  const headings: Record<string, string> = {
    only_they_held: "Only they held",
    they_had_promised: "They had promised",
    nobody_else_seen: "Nobody else has been seen doing",
  };

  const parts: string[] = [brief.openingLine];
  // Iterated in the enum's declaration order rather than the order lines arrived, because the
  // three sections are ordered and that order is part of the contract.
  for (const section of ["only_they_held", "they_had_promised", "nobody_else_seen"] as const) {
    const lines = brief.lines.filter((line) => line.section === section);
    if (lines.length === 0) continue;
    parts.push("", `${headings[section]}:`);
    for (const line of lines) parts.push(`• ${line.text}`);
  }

  return parts.join("\n");
}

/**
 * Sends the brief for generation.
 *
 * An interrupt is rejected: Restraint gates brief lines by returning quiet decisions on the
 * produce path, not by interrupting, so an interrupt here means the contract changed and
 * continuing would report a brief that was never produced.
 */
async function invokeBrief(
  transport: AgentTransport,
  request: AgentRequest,
  trace: TraceEntry[],
): Promise<BriefResult> {
  const response = await transport.invoke(request);
  trace.push(...response.trace);

  if (response.stopReason === "error") {
    throw new Error(`Agent brief failed: ${response.error ?? "no error was reported"}`);
  }
  if (response.stopReason === "interrupt") {
    throw new Error(
      "Agent brief raised an interrupt, which the brief path does not implement. Restraint " +
        "withholds a line by returning a quiet decision rather than by interrupting.",
    );
  }

  return briefResultSchema.parse(response.result);
}

/**
 * When this transition happened, for the one-brief-per-transition guard.
 *
 * Falls back to the current instant when the person has no recorded transition date. That is
 * the permissive direction on purpose: it means the guard finds nothing and a brief *is*
 * generated. Refusing to brief because a timestamp is missing would lose the handover for the
 * one case the product exists to serve.
 */
function transitionInstant(
  person: { leftAt: Date | null; joinedAt: Date | null },
  kind: BriefKind,
  now: Date,
): Date {
  return (kind === "departure" ? person.leftAt : person.joinedAt) ?? now;
}

/**
 * Generates, stores and delivers one brief.
 *
 * Ordering: the brief is **stored before it is sent**. The opposite order would mean a send
 * failure loses the document, and the document is the valuable part — delivery is a
 * convenience on top of a record the UI can always render.
 */
export async function runBriefPass(
  deps: BriefDeps,
  request: BriefRequest,
): Promise<BriefPassResult> {
  const { db, transport, queue } = deps;
  const now = deps.now?.() ?? new Date();
  const kind: RunKind = "brief";
  const ownsRun = request.runId === undefined;

  const trace: TraceEntry[] = [];
  let runId: string | null = request.runId ?? null;

  const person = await findPersonForBrief(db, request.subjectPersonId);
  if (person === null) {
    throw new Error(`Cannot brief an unknown person: ${request.subjectPersonId}`);
  }

  if (request.force !== true) {
    const existing = await findBriefForTransition(
      db,
      request.subjectPersonId,
      request.kind,
      transitionInstant(person, request.kind, now),
    );
    if (existing !== null) {
      return {
        runId: null,
        status: "skipped",
        briefId: existing,
        duplicate: true,
        isEmpty: false,
        lineCount: 0,
        quietDecisions: 0,
        toSubject: "not_attempted",
        toCoordinator: "not_attempted",
        text: "",
        trace,
      };
    }
  }

  if (runId === null) runId = await openRun(db, kind);

  try {
    const context: BriefContext = await hydrateBriefContext(db, now, {
      kind: request.kind,
      subjectPersonId: request.subjectPersonId,
    });

    const agentRequest: AgentRequest = {
      task: "brief",
      runId,
      payload: {
        kind: request.kind,
        subjectPersonId: request.subjectPersonId,
        subjectDisplayName: person.displayName,
      },
      context,
    };

    const result = await invokeBrief(transport, agentRequest, trace);
    const quietDecisions = await recordQuietDecisions(db, result.quietDecisions, runId);

    const stored: StoredBrief = await storeBrief(db, {
      brief: result.brief,
      runId,
      triggeredByMessageId: request.triggeredByMessageId ?? null,
      generatedAt: now,
    });

    const text = renderBrief(result);

    // The coordinator always gets it — they are the one who acts on a handover. The subject is
    // offered it, which is a courtesy and frequently impossible.
    const toCoordinatorDelivery = await sendToCoordinator(db, queue, text, `${request.kind} brief`);
    const toSubjectDelivery = await sendPrivately(
      db,
      queue,
      request.subjectPersonId,
      text,
      `${request.kind} brief`,
    );

    if (ownsRun) {
      await closeRun(db, runId, { status: "complete", trace });
    }

    return {
      runId,
      status: "complete",
      briefId: stored.briefId,
      duplicate: false,
      isEmpty: result.brief.isEmpty,
      lineCount: stored.lineCount,
      quietDecisions,
      toSubject: toSubjectDelivery.delivered ? "sent" : "undeliverable",
      toCoordinator: toCoordinatorDelivery.delivered ? "sent" : "undeliverable",
      text,
      trace,
    };
  } catch (error) {
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

/**
 * The lifecycle handler, ready to hand to the intake loop.
 *
 * Curried rather than inlined at the call site so `main.ts` wires one function and the
 * membership path has no knowledge of transports or queues. A `joined` transition produces an
 * arrival brief and a `left` one a departure brief; `unchanged` produces neither, because a
 * promotion is not a handover.
 */
export function briefOnMembership(deps: BriefDeps) {
  return async (outcome: {
    personId: string;
    briefWorthy: boolean;
    transition: "joined" | "left" | "unchanged";
  }): Promise<BriefPassResult | null> => {
    if (!outcome.briefWorthy) return null;
    if (outcome.transition === "unchanged") return null;

    return runBriefPass(deps, {
      kind: outcome.transition === "left" ? "departure" : "arrival",
      subjectPersonId: outcome.personId,
    });
  };
}

/** Re-exported for the admin UI, which regenerates deliberately. */
export async function personExists(db: Executor, personId: string): Promise<boolean> {
  return (await findPersonForBrief(db, personId)) !== null;
}
