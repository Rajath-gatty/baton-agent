/**
 * The approval round trip, worker half. `[F31]` `[F32]`
 *
 * The one flow with real mechanical complexity, and it has **two entrances** that meet at
 * the same exit. Missing that is the easiest way to build half of this feature:
 *
 *   1. **The worker's own gate.** `decideFactStatus` classifies consequence deterministically
 *      from asset kind and sensitivity — never by asking a model — and a high-consequence
 *      claim on weak evidence is written `pending_approval` with `requiresApproval`. There is
 *      no interrupt, no snapshot and nothing to resume: the claim is already in `facts`,
 *      invisible to detection, waiting for a yes. This is the path the seeded demo exercises.
 *   2. **An agent interrupt.** A node stops mid-graph, AgentCore returns `stopReason:
 *      'interrupt'` with a snapshot, and the worker stores the snapshot in `agent_sessions`
 *      so that hours later `resume` can pick up from the interruption point in a container
 *      with no memory of the original request.
 *
 * Both write a `pending_changes` row and an approval `questions` row, and both resolve
 * through {@link answerApproval}. The only difference at resolution is whether there is a
 * session to resume.
 *
 * Four rules the design names explicitly, all enforced here:
 *
 *   - **Only the coordinator may answer an approval.** A volunteer's "yes" leaves it
 *     unresolved — not rejected, not applied. Verification and clarification questions accept
 *     an answer from anyone, because they are questions of fact and the group is the authority
 *     on its own facts. An approval is a question of authority.
 *   - **Two approvals about one asset are never asked in parallel.** The second waits.
 *   - **An answer arriving after its claim was superseded resolves as `obsolete`**, and the
 *     change is discarded rather than applied.
 *   - **Routing follows sensitivity, not the model's preference.** Anything touching financial
 *     control or credentials goes to the coordinator privately rather than to twenty people.
 */

import {
  assessorOutputSchema,
  brieferOutputSchema,
  classifyConsequence,
  respondentOutputSchema,
  type AgentInterrupt,
  type AgentRequest,
  type AgentResponse,
  type AgentTask,
  type ConsequenceLevel,
  type CuratorRecord,
  type QuestionTarget,
} from "@baton/core";
import type { Database } from "@baton/core/db";
import type { AgentTransport } from "../agent/transport.js";
import { getAppSettings } from "../store/app-settings.js";
import { claimSessionForResume, closeSession, storeSession } from "../store/agent-sessions.js";
import { findFactStatus, updateFactStatus } from "../store/facts.js";
import {
  createPendingChange,
  findPendingChange,
  markPendingChangeApplied,
  markPendingChangeObsolete,
  markPendingChangeRejected,
  selectNextAskablePendingChange,
} from "../store/pending-changes.js";
import { findPersonByTelegramId } from "../store/people.js";
import {
  findAskedQuestionByBotMessageId,
  markQuestionObsolete,
  queueQuestion,
  resolveQuestion,
} from "../store/questions.js";
import type { Executor } from "../store/types.js";

/**
 * Where an approval is asked.
 *
 * High consequence means the coordinator privately. An approval about who controls the money
 * asked in front of twenty people is a different act from asking the coordinator, whatever
 * the words are — and it hands the group an authority the gate exists to withhold.
 */
export function approvalTarget(consequence: ConsequenceLevel): QuestionTarget {
  return consequence === "high" ? "coordinator" : "group";
}

/** The sentence a coordinator reads. Plain, and it says what happens if they say nothing. */
export function approvalText(claim: string, reason: string): string {
  return [
    `Before I record this, can you confirm it?`,
    ``,
    `“${claim}”`,
    ``,
    reason,
    ``,
    `Reply yes to record it, or no to leave it out. Until you answer, it stays out of the register.`,
  ].join("\n");
}

export interface FactApprovalInput {
  record: CuratorRecord;
  factId: string;
  assetId: string | null;
  /** Why approval is needed, from `decideFactStatus`. Shown verbatim. */
  reason: string;
}

export interface RequestedApproval {
  pendingChangeId: string;
  /** Null when another proposal about the same asset is already awaiting an answer. */
  questionId: string | null;
  target: QuestionTarget;
  /** False when this proposal is queued behind another about the same asset. */
  asked: boolean;
}

/**
 * Entrance one: the worker's own consequence gate.
 *
 * Called from the processing loop when `applyFact` reports `requiresApproval`. The claim is
 * already in `facts` at `pending_approval`, so nothing here writes truth — it records the
 * proposal and, if nothing else is queued for the asset, asks.
 *
 * No `agent_sessions` row, because there is nothing to resume. That asymmetry is why
 * `pending_changes.agent_session_id` is nullable.
 */
export async function requestFactApproval(
  db: Executor,
  { record, factId, assetId, reason }: FactApprovalInput,
): Promise<RequestedApproval> {
  const consequence = classifyConsequence({
    assetKind: record.assetKind,
    sensitivity: record.sensitivity,
  });
  const target = approvalTarget(consequence);

  const created = await createPendingChange(db, {
    proposedChange: { kind: "fact", claim: record.claim, factId },
    consequence,
    assetId,
    factId,
  });

  if (!created.askable) {
    // Stored and waiting. Two answers about one asset could contradict, and the second would
    // silently win.
    return {
      pendingChangeId: created.pendingChangeId,
      questionId: null,
      target,
      asked: false,
    };
  }

  const queued = await queueQuestion(db, {
    kind: "approval",
    target,
    askedText: approvalText(record.claim, reason),
    factId,
    assetId,
    pendingChangeId: created.pendingChangeId,
  });

  return {
    pendingChangeId: created.pendingChangeId,
    questionId: queued.questionId,
    target,
    asked: true,
  };
}

export interface RecordInterruptsInput {
  /** The task that was interrupted, so `resume` can rebuild the right agent. */
  task: AgentTask;
  response: AgentResponse;
  runId: string | null;
  /** The asset the interrupt concerns, where the caller knows it. Drives queueing. */
  assetId?: string | null;
  factId?: string | null;
}

export interface RecordedInterrupt {
  interruptId: string;
  pendingChangeId: string;
  questionId: string | null;
  agentSessionId: string;
  asked: boolean;
}

/**
 * Entrance two: an agent interrupt.
 *
 * Stores **one session for the whole response** rather than one per interrupt, because the
 * snapshot is the graph's state and there is one graph. Each interrupt gets its own pending
 * change and its own question, and all of them reference that session — so a resume carries
 * every answer at once, which is what `interruptResponses` being an array is for.
 */
export async function recordInterrupts(
  db: Executor,
  { task, response, runId, assetId = null, factId = null }: RecordInterruptsInput,
): Promise<RecordedInterrupt[]> {
  const interrupts = response.interrupts ?? [];
  if (interrupts.length === 0) return [];

  const agentSessionId = await storeSession(db, {
    task,
    snapshot: response.snapshot,
    runId,
  });

  // An interrupt raised by an agent carries no asset kind, so consequence cannot be
  // classified from the claim. `high` is the safe default: it routes privately, which is
  // never wrong for something a node stopped the graph to ask about.
  const consequence: ConsequenceLevel = "high";
  const target = approvalTarget(consequence);

  const recorded: RecordedInterrupt[] = [];

  for (const interrupt of interrupts) {
    const created = await createPendingChange(db, {
      proposedChange: interrupt.proposedChange ?? { kind: "interrupt", reason: interrupt.reason },
      consequence,
      assetId,
      factId,
      agentSessionId,
    });

    let questionId: string | null = null;
    if (created.askable) {
      const queued = await queueQuestion(db, {
        kind: "approval",
        target,
        askedText: interrupt.reason,
        pendingChangeId: created.pendingChangeId,
        assetId,
        factId,
      });
      questionId = queued.questionId;
    }

    recorded.push({
      interruptId: interrupt.interruptId,
      pendingChangeId: created.pendingChangeId,
      questionId,
      agentSessionId,
      asked: created.askable,
    });
  }

  return recorded;
}

/** Whether this person may answer an approval. */
export async function isCoordinator(
  db: Executor,
  personId: string,
  permittedTelegramIds: readonly number[],
): Promise<boolean> {
  const settings = await getAppSettings(db);
  if (settings.coordinatorPersonId === personId) return true;

  // The environment's operator list. Checked second, so the table remains the primary
  // authority and the list is the escape hatch for a second operator.
  for (const telegramId of permittedTelegramIds) {
    if ((await findPersonByTelegramId(db, telegramId)) === personId) return true;
  }
  return false;
}

/** What an answer's text means. Deliberately narrow. */
export type ApprovalVerdict = "approved" | "rejected" | "unclear";

const YES = /^(yes|y|yep|yeah|ok|okay|confirmed|confirm|approved|approve|go ahead|sure)\b/i;
const NO = /^(no|nope|n|don't|dont|do not|reject|rejected|leave it|not right)\b/i;

/**
 * Reads a yes or a no out of a reply.
 *
 * Matched at the **start** of the reply, because "no, yes that's right" and "yes, no need to
 * change it" both contain both words and only the leading one is the answer. Anything that is
 * neither is `unclear`, and unclear is not a no: an approval that cannot be read stays open
 * rather than being silently declined, because a declined approval looks identical to one
 * nobody answered and the coordinator would never know their reply was discarded.
 */
export function readVerdict(answerText: string): ApprovalVerdict {
  const trimmed = answerText.trim();
  if (NO.test(trimmed)) return "rejected";
  if (YES.test(trimmed)) return "approved";
  return "unclear";
}

export interface AnswerApprovalInput {
  /** The `questions` row the reply matched. */
  questionId: string;
  pendingChangeId: string;
  answeredByPersonId: string | null;
  answerText: string;
  at: Date;
  permittedTelegramIds: readonly number[];
}

export type ApprovalOutcome =
  | "applied"
  | "rejected"
  | "obsolete"
  | "not_permitted"
  | "unclear"
  | "already_resolved";

export interface AnswerApprovalResult {
  outcome: ApprovalOutcome;
  /** Present when a session was resumed, so the caller can validate the returned output. */
  resumedResult?: unknown;
  reason: string;
}

export interface ApprovalDeps {
  db: Database;
  transport: AgentTransport;
}

/**
 * Resolves an approval from a reply.
 *
 * The order of the checks is the design, and each one refuses rather than guessing:
 *
 *  1. **Is the claim still pending?** If the fact has moved on, the answer is moot. The
 *     question resolves `obsolete` and the change is discarded — not applied. An answer that
 *     arrives after the thing it was about has been superseded is not a late yes.
 *  2. **Is the answerer permitted?** If not, nothing happens at all. Not rejected, not
 *     applied: the question stays open and the coordinator can still answer it. A volunteer's
 *     "yes" is not an approval, and treating it as a rejection would let anyone veto.
 *  3. **Is the answer readable?** An unclear reply leaves it open, for the same reason.
 *  4. **Then apply or discard**, and resume the session if there is one.
 */
export async function answerApproval(
  deps: ApprovalDeps,
  input: AnswerApprovalInput,
): Promise<AnswerApprovalResult> {
  const { db } = deps;
  const { questionId, pendingChangeId, answeredByPersonId, answerText, at } = input;

  const change = await findPendingChange(db, pendingChangeId);
  if (change === null || change.status !== "pending") {
    return {
      outcome: "already_resolved",
      reason: "This proposal has already been settled.",
    };
  }

  // ── 1. Has the claim moved on? ─────────────────────────────────────────────
  if (change.factId !== null) {
    const status = await findFactStatus(db, change.factId);
    if (status !== "pending_approval") {
      await markPendingChangeObsolete(db, pendingChangeId, at);
      await markQuestionObsolete(
        db,
        questionId,
        "The claim was superseded before the answer arrived.",
        at,
      );
      if (change.agentSessionId !== null) {
        // Nobody will resume this snapshot. Left open, the count of what Baton is waiting on
        // stays wrong forever.
        await closeSession(db, change.agentSessionId, at);
      }
      await promoteNextForAsset(db, change.assetId, at);
      return {
        outcome: "obsolete",
        reason: "The claim was superseded before the answer arrived, so nothing was applied.",
      };
    }
  }

  // ── 2. May this person answer? ─────────────────────────────────────────────
  const permitted =
    answeredByPersonId !== null &&
    (await isCoordinator(db, answeredByPersonId, input.permittedTelegramIds));
  if (!permitted) {
    return {
      outcome: "not_permitted",
      reason:
        "Only the coordinator can answer an approval, so this reply was noted and the " +
        "question is still open.",
    };
  }

  // ── 3. Is the answer readable? ─────────────────────────────────────────────
  const verdict = readVerdict(answerText);
  if (verdict === "unclear") {
    return {
      outcome: "unclear",
      reason: "The reply was neither a yes nor a no, so the question is still open.",
    };
  }

  // ── 4. Apply or discard ────────────────────────────────────────────────────
  // Resolved **before** anything is applied, and the result is checked. `resolveQuestion`
  // only answers a question that was actually sent, so a false here means either a racing
  // tick already answered it or the question was never asked. Applying the change anyway
  // would leave a question open next to a change that had already been made — and on the
  // racing-tick path it would apply the same change twice.
  const claimed = await resolveQuestion(db, questionId, {
    answerText,
    answeredByPersonId,
    resolution: verdict === "approved" ? "approved" : "rejected",
    at,
  });
  if (!claimed) {
    return {
      outcome: "already_resolved",
      reason: "This question was already answered, or was never asked.",
    };
  }

  if (verdict === "approved") {
    await markPendingChangeApplied(db, pendingChangeId, at);
    if (change.factId !== null) await believeFact(db, change.factId, at);
  } else {
    await markPendingChangeRejected(db, pendingChangeId, at);
    if (change.factId !== null) await disbelieveFact(db, change.factId);
  }

  let resumedResult: unknown;
  if (change.agentSessionId !== null) {
    resumedResult = await resumeSession(deps, {
      agentSessionId: change.agentSessionId,
      questionId,
      approved: verdict === "approved",
      answeredByPersonId,
      answerText,
      at,
    });
  }

  await promoteNextForAsset(db, change.assetId, at);

  return {
    outcome: verdict === "approved" ? "applied" : "rejected",
    ...(resumedResult === undefined ? {} : { resumedResult }),
    reason:
      verdict === "approved"
        ? "The coordinator confirmed it, so the claim is now part of the register."
        : "The coordinator declined, so the claim stays out of the register.",
  };
}

/**
 * The claim becomes truth.
 *
 * `verified_at` is stamped rather than merely flipping the status, because the register's
 * whole promise is that a claim can be traced — and "a human agreed to this, on this day" is
 * the strongest provenance any claim in it has.
 */
async function believeFact(db: Executor, factId: string, at: Date): Promise<void> {
  await updateFactStatus(db, factId, "active", { verifiedAt: at });
}

/**
 * The claim is not believed.
 *
 * `unverified` rather than `retired`: retired means an arrangement the register once held has
 * ended, which would be a lie about something never recorded. `unverified` says plainly that
 * Baton was told this and does not believe it — invisible to every detection query, still
 * readable in the fact detail, and re-askable if the group says it again.
 */
async function disbelieveFact(db: Executor, factId: string): Promise<void> {
  await updateFactStatus(db, factId, "unverified");
}

/**
 * Asks about the next proposal for this asset, now that the one in front has resolved.
 *
 * This is the other half of "two approvals are never asked in parallel": without it the second
 * proposal would sit `pending` forever with no question attached, which is worse than asking
 * both — it is a write held back that nobody is ever asked about.
 */
async function promoteNextForAsset(
  db: Executor,
  assetId: string | null,
  at: Date,
): Promise<string | null> {
  if (assetId === null) return null;

  const next = await selectNextAskablePendingChange(db, assetId);
  if (next === null) return null;

  const claim =
    typeof next.proposedChange === "object" &&
    next.proposedChange !== null &&
    "claim" in next.proposedChange &&
    typeof (next.proposedChange as { claim: unknown }).claim === "string"
      ? (next.proposedChange as { claim: string }).claim
      : "a change to the register";

  const queued = await queueQuestion(db, {
    kind: "approval",
    target: approvalTarget(next.consequence),
    askedText: approvalText(
      claim,
      `This was waiting behind another question about the same thing.`,
    ),
    pendingChangeId: next.id,
    assetId,
    factId: next.factId,
  });
  // `at` is unused for the queue itself — asking happens in the ask pass, which stamps
  // `asked_at` when the message actually goes out.
  void at;
  return queued.questionId;
}

interface ResumeInput {
  agentSessionId: string;
  questionId: string;
  approved: boolean;
  answeredByPersonId: string | null;
  answerText: string;
  at: Date;
}

/**
 * Resumes the interrupted graph with the answer.
 *
 * The session is **claimed** first, and the claim succeeds once. Two ticks racing on the same
 * answered question would otherwise both resume, and the node would run twice from the same
 * interruption point — applying the approved change twice, or saying the same thing to the
 * group twice. Neither is recoverable by retrying.
 *
 * The result is validated against the **original node's** schema rather than the wrapped task
 * result, because `resume` returns the node's own output: the Assessor's findings, the
 * Briefer's brief, the Respondent's reply. It carries no quiet decisions, which is worth
 * knowing — a resumed output has not been through Restraint a second time.
 */
async function resumeSession(deps: ApprovalDeps, input: ResumeInput): Promise<unknown> {
  const { db, transport } = deps;

  const session = await claimSessionForResume(db, input.agentSessionId, input.at);
  if (session === null) {
    // Already resumed, or already closed. Not an error: the answer landed twice.
    return undefined;
  }

  if (session.task === "ingest" || session.task === "resume") {
    // `ingest` raises no interrupts, and a session claiming to resume `resume` is a lookup
    // bug rather than a case to handle.
    await closeSession(db, session.id, input.at);
    throw new Error(`A '${session.task}' session cannot be resumed.`);
  }

  const request: AgentRequest = {
    task: "resume",
    runId: session.runId ?? input.questionId,
    payload: { originalTask: session.task },
    context: {},
    snapshot: session.snapshot,
    interruptResponses: [
      {
        interruptId: input.questionId,
        approved: input.approved,
        ...(input.answeredByPersonId === null ? {} : { answeredBy: input.answeredByPersonId }),
        answerText: input.answerText,
      },
    ],
  };

  const response = await transport.invoke(request);
  await closeSession(db, session.id, input.at);

  if (response.stopReason === "error") {
    throw new Error(`Resuming ${session.task} failed: ${response.error ?? "no reason given"}`);
  }

  return validateResumedResult(session.task, response.result);
}

/** The three resumable tasks and the schema each one's node returns. */
function validateResumedResult(task: AgentTask, result: unknown): unknown {
  switch (task) {
    case "assess":
      return assessorOutputSchema.parse(result);
    case "brief":
      return brieferOutputSchema.parse(result);
    case "respond":
      return respondentOutputSchema.parse(result);
    default:
      throw new Error(`No resumed-result schema for task '${task}'.`);
  }
}

export interface ApprovalReplyMatch {
  questionId: string;
  pendingChangeId: string;
}

/**
 * Matches a reply to the approval it answers, by the bot's own message id.
 *
 * Only the exact match is used here. The looser fallbacks — most recent open question from
 * that sender inside a window — are fine for a verification, where a wrong match asks the
 * group to confirm something twice. For an approval a wrong match applies a change nobody
 * approved, so this refuses rather than widening.
 */
export async function matchApprovalReply(
  db: Executor,
  repliedToBotMessageId: number,
): Promise<ApprovalReplyMatch | null> {
  const question = await findAskedQuestionByBotMessageId(db, repliedToBotMessageId);
  if (question === null) return null;
  if (question.kind !== "approval") return null;
  if (question.pendingChangeId === null) return null;
  return { questionId: question.id, pendingChangeId: question.pendingChangeId };
}

export interface InterruptSummary {
  interruptId: string;
  interruptName: string;
  reason: string;
}

/** The interrupts a response carried, for a trace line or a log. */
export function summariseInterrupts(response: AgentResponse): InterruptSummary[] {
  return (response.interrupts ?? []).map((interrupt: AgentInterrupt) => ({
    interruptId: interrupt.interruptId,
    interruptName: interrupt.interruptName,
    reason: interrupt.reason,
  }));
}

export interface IncomingReply {
  /** The `messages.id` of the reply. */
  messageId: string;
  /** Who replied, resolved. Null means the gate cannot pass, whatever the text says. */
  senderPersonId: string | null;
  text: string;
  /** The bot message this replies to, from question detection. */
  repliedToBotMessageId: number | null;
  at: Date;
}

export type ReplyDisposition =
  | { kind: "approval_answer"; result: AnswerApprovalResult }
  | { kind: "verification_answer"; questionId: string }
  | { kind: "new_question" };

/**
 * Decides what an incoming reply to one of Baton's messages actually is.
 *
 * **This is the discrimination the intake loop cannot make**, and getting it wrong is not
 * subtle: a reply to an approval request treated as a new question would answer something
 * nobody asked while leaving the approval pending forever, and the coordinator would have no
 * way to tell their yes had gone nowhere.
 *
 * Only the store knows which bot message ids were questions, which is why this lives here and
 * the intake loop merely reports `repliedToBotMessageId`.
 *
 * A reply that matches no open question is a **new question** — the ordinary case of someone
 * following up on an answer Baton gave. That is the permissive direction, and it is the right
 * one: the cost is a model call, whereas refusing would silently ignore somebody talking
 * directly to the bot.
 */
export async function dispositionOfReply(
  deps: ApprovalDeps,
  reply: IncomingReply,
  permittedTelegramIds: readonly number[],
): Promise<ReplyDisposition> {
  if (reply.repliedToBotMessageId === null) return { kind: "new_question" };

  const question = await findAskedQuestionByBotMessageId(deps.db, reply.repliedToBotMessageId);
  if (question === null) return { kind: "new_question" };

  if (question.kind === "approval") {
    if (question.pendingChangeId === null) {
      // An approval question with no proposal attached cannot be applied. Treating it as a new
      // question at least gets the person an answer rather than silence.
      return { kind: "new_question" };
    }
    const result = await answerApproval(deps, {
      questionId: question.id,
      pendingChangeId: question.pendingChangeId,
      answeredByPersonId: reply.senderPersonId,
      answerText: reply.text,
      at: reply.at,
      permittedTelegramIds,
    });
    return { kind: "approval_answer", result };
  }

  // A verification or clarification. **Anyone in the group may answer these**, because they
  // are questions of fact and the group is the authority on its own facts — unlike an
  // approval, which is a question of authority.
  await resolveQuestion(deps.db, question.id, {
    answerText: reply.text,
    answeredByPersonId: reply.senderPersonId,
    resolution: "answered",
    at: reply.at,
  });
  return { kind: "verification_answer", questionId: question.id };
}
