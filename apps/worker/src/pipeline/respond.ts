/**
 * Answering a question in the group. `[F20]` `[F21]`
 *
 * The four outcomes are not four degrees of success. Three of them are the valuable ones —
 * *that figure is five months old and worth confirming*, *two people are recorded as holding
 * this and I cannot tell which*, and plainly *nobody has told me that* — because a tool that
 * only speaks when it is certain is a tool nobody can calibrate. This module's job is to make
 * each of the four land somewhere a human will see, and to send **nothing** when Restraint
 * withheld the answer.
 *
 * What the worker decides rather than the model:
 *
 *   - **Whether an answer is sent at all.** `withheld` means Restraint vetoed it, and the
 *     group hears nothing. The quiet decision is the record.
 *   - **Where it goes.** The Respondent proposes a target; the worker enforces it. An
 *     ambiguous holder routes privately, because "I think one of these two people has the
 *     bank login" said to twenty people is a worse outcome than saying nothing.
 *   - **Whether a follow-up may be asked.** The `unknown` branch proposes a question. It
 *     goes through the ask budget like every other ask, and is queued rather than dropped
 *     when there is no room.
 *
 * Ordering, and the reason for it: **`question_answered_at` is stamped after the reply is
 * sent.** A crash between the model call and the send leaves the question unanswered, so the
 * next pass retries it. Stamping first would drop the question silently — and unlike a
 * missed curation, nobody would ever find out, because the person who asked would simply
 * assume Baton had nothing to say.
 */

import {
  respondResultSchema,
  type AgentRequest,
  type QuestionTarget,
  type RespondContext,
  type RespondResult,
  type RespondentOutcome,
  type RunKind,
  type RunStatus,
  type TraceEntry,
} from "@baton/core";
import type { Database } from "@baton/core/db";
import type { AgentTransport } from "../agent/transport.js";
import { getAppSettings } from "../store/app-settings.js";
import { markQuestionAnswered, selectUnansweredQuestions } from "../store/messages.js";
import { queueQuestion } from "../store/questions.js";
import { recordQuietDecisions } from "../store/quiet-decisions.js";
import { closeRun, openRun } from "../store/runs.js";
import { sendToCoordinator } from "../telegram/private-delivery.js";
import type { OutboundQueue } from "../telegram/outbound-queue.js";
import { hydrateRespondContext } from "./hydrate.js";

/**
 * How many questions one pass answers.
 *
 * Small on purpose. Each one is a model call, and a burst of five replies in a row reads as
 * a bot talking to itself even when every answer is correct. The rest wait for the next
 * tick, which is seconds away.
 */
export const DEFAULT_RESPOND_LIMIT = 3;

export interface RespondDeps {
  db: Database;
  transport: AgentTransport;
  queue: OutboundQueue;
  now?: () => Date;
}

export interface RespondOptions {
  limit?: number;
  kind?: RunKind;
  runId?: string;
}

export interface AnsweredQuestion {
  /** The `messages.id` of the question. */
  questionMessageId: string;
  outcome: RespondentOutcome;
  /** False when Restraint withheld it, or when delivery failed. */
  replied: boolean;
  withheld: boolean;
  target: QuestionTarget;
  /** Set when the `unknown` branch produced a follow-up that was queued. */
  followUpQuestionId: string | null;
}

export interface RespondPassResult {
  runId: string | null;
  status: RunStatus | "skipped";
  pending: number;
  answered: AnsweredQuestion[];
  quietDecisions: number;
  trace: TraceEntry[];
}

/**
 * Sends one question for answering.
 *
 * An interrupt is rejected. The Respondent has no approval gate — it reads the register and
 * does not write to it — so an interrupt here means the contract changed, and continuing
 * would report success for an answer that was never produced.
 */
async function invokeRespond(
  transport: AgentTransport,
  request: AgentRequest,
  trace: TraceEntry[],
): Promise<RespondResult> {
  const response = await transport.invoke(request);
  trace.push(...response.trace);

  if (response.stopReason === "error") {
    throw new Error(`Agent respond failed: ${response.error ?? "no error was reported"}`);
  }
  if (response.stopReason === "interrupt") {
    throw new Error(
      "Agent respond raised an interrupt, which the respond path does not implement. " +
        "The Respondent reads the register and never writes to it.",
    );
  }

  return respondResultSchema.parse(response.result);
}

/**
 * Where an answer actually goes.
 *
 * The model proposes and the worker decides, and there is one override: **an ambiguous
 * holder always routes privately**, whatever the model said. "I think one of these two
 * people has the bank login" said in front of twenty people is worse than silence — it
 * names two people in connection with something neither may hold, and no correction
 * afterwards unsays it.
 */
export function resolveTarget(result: RespondResult): QuestionTarget {
  if (result.reply.outcome === "ambiguous_holder") return "coordinator";
  return result.reply.target;
}

/** Deliberately not exported as a general helper: this phrasing belongs to this path. */
function unknownFollowUpText(question: string, followUp: string): string {
  return followUp.trim() === "" ? `Does anyone know: ${question}` : followUp;
}

/**
 * One pass of the respond loop.
 *
 * **Runs outside the pipeline advisory lock.** Answering reads the register and writes only
 * to `questions` and to `messages.question_answered_at`; it derives nothing and supersedes
 * nothing, so it cannot race the order-dependent parts of the pipeline. Holding the lock
 * here would mean a group question waits behind a backfill, which during a demo is the one
 * delay anybody notices.
 */
export async function runRespondPass(
  deps: RespondDeps,
  options: RespondOptions = {},
): Promise<RespondPassResult> {
  const { db, transport, queue } = deps;
  const now = deps.now?.() ?? new Date();
  const limit = options.limit ?? DEFAULT_RESPOND_LIMIT;
  const kind: RunKind = options.kind ?? "respond";
  const ownsRun = options.runId === undefined;

  const trace: TraceEntry[] = [];
  const answered: AnsweredQuestion[] = [];
  let quietDecisions = 0;
  let runId: string | null = options.runId ?? null;

  const pending = await selectUnansweredQuestions(db, limit);
  if (pending.length === 0) {
    return { runId, status: "complete", pending: 0, answered, quietDecisions, trace };
  }

  if (runId === null) runId = await openRun(db, kind);

  try {
    // Hydrated once for the pass. The fact index is the same for every question in it, and
    // re-reading a couple of hundred claims per question would be the dominant cost of a
    // path whose whole point is to be quick.
    const context: RespondContext = await hydrateRespondContext(db, now);
    const settings = await getAppSettings(db);

    for (const question of pending) {
      const request: AgentRequest = {
        task: "respond",
        runId,
        payload: {
          questionText: question.text,
          questionMessageId: question.id,
          askedByPersonId: question.senderPersonId,
          askedByMention: question.senderMention,
        },
        context,
      };

      const result = await invokeRespond(transport, request, trace);
      quietDecisions += await recordQuietDecisions(db, result.quietDecisions, runId);

      const target = resolveTarget(result);
      let replied = false;

      if (result.withheld) {
        // Restraint vetoed it. The group hears nothing, and the quiet decision above is the
        // whole record — which is what makes an agent that declines to speak accountable
        // rather than merely quiet.
        await markQuestionAnswered(db, question.id, now);
      } else if (target === "coordinator") {
        const text = result.reply.answerText;
        const delivery =
          text === null || text.trim() === ""
            ? { delivered: false as const }
            : await sendToCoordinator(db, queue, text, "answer");
        replied = delivery.delivered === true;
        if (replied) await markQuestionAnswered(db, question.id, now);
      } else {
        const text = result.reply.answerText;
        if (text !== null && text.trim() !== "" && settings.chatId !== null) {
          const outcome = await queue.enqueue({
            chatId: settings.chatId,
            text,
            // Threaded as a reply **to the question itself**, so an answer arriving twenty
            // messages later is still legible as an answer to that question. Replying to
            // whatever the question replied to would thread it to the wrong message.
            replyToMessageId: question.telegramMessageId,
            purpose: "answer",
          });
          replied = outcome.ok;
          if (replied) await markQuestionAnswered(db, question.id, now);
        }
      }

      // An `unknown` with nothing to say is still an outcome, and leaving the question
      // permanently unanswered would make every later pass retry it forever.
      if (result.reply.outcome === "unknown" && !replied && !result.withheld) {
        await markQuestionAnswered(db, question.id, now);
      }

      let followUpQuestionId: string | null = null;
      if (
        result.reply.outcome === "unknown" &&
        result.reply.followUpQuestion !== null &&
        context.askBudgetAvailable
      ) {
        // Queued rather than sent. The budget decides when, and `runAskPass` sends it —
        // one path for every ask, so the cap cannot be bypassed by a new caller.
        const queued = await queueQuestion(db, {
          kind: "verification",
          target: "group",
          askedText: unknownFollowUpText(question.text, result.reply.followUpQuestion),
          targetPersonId: null,
        });
        followUpQuestionId = queued.questionId;
      }

      answered.push({
        questionMessageId: question.id,
        outcome: result.reply.outcome,
        replied,
        withheld: result.withheld,
        target,
        followUpQuestionId,
      });
    }

    if (ownsRun) {
      await closeRun(db, runId, { status: "complete", trace });
    }
    return { runId, status: "complete", pending: pending.length, answered, quietDecisions, trace };
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
