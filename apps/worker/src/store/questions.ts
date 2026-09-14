/**
 * The `questions` table and the ask budget. `[F21]`
 *
 * **The budget is enforced in SQL, not in a prompt.** Both halves are plain counts —
 * `status = 'asked' and answer_text is null` for how many are open, and
 * `asked_at > now() - interval '24 hours'` for how many are new — and a prompt cannot
 * count what it already asked. This is the same reasoning as the sweep's short-circuit:
 * a limit a model is merely told about is a limit that holds until the week it matters.
 *
 * Four properties, each with a failure it prevents:
 *
 *   - **A blocked ask is stored, never dropped.** It goes in `queued` with a null
 *     `asked_at`. Nothing is discarded, and the claim behind it stays out of findings and
 *     briefs while it waits — so the cap produces a visible gap rather than an invented
 *     fact.
 *   - **`asked_at` is null until the message is actually sent.** A default of insertion
 *     time would make the rolling window count questions that were never sent, and the
 *     budget would silently throttle itself to nothing. That is why the column is
 *     nullable with no default, and why asking is a second step rather than part of the
 *     insert.
 *   - **Priority derives from `kind`.** An approval outranking a clarification outranking
 *     a verification is fixed policy, not a per-question judgment, so it is never stored.
 *     Without the ordering, the one ask that must not be delayed is exactly the one a
 *     stale-figure check displaces.
 *   - **Nothing is asked twice.** An identical unresolved ask returns the existing row
 *     instead of adding a second.
 *
 * The budget is deliberately independent of the outbound queue: the queue protects
 * Telegram's API, the budget protects the reader's patience. Twenty messages a minute is
 * fine for the API and would end the group's tolerance in an afternoon.
 */

import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import { ASK_BUDGET, ASK_PRIORITY, type QuestionKind, type QuestionTarget } from "@baton/core";
import type { Executor } from "./types.js";

const { questions } = schema;

/**
 * The priority ordering, as SQL, built from {@link ASK_PRIORITY}.
 *
 * Generated rather than written out so the two cannot drift. A hand-written `case` that
 * forgot a newly added kind would sort it last silently, which for an approval is the
 * worst possible default.
 */
function priorityOrder() {
  const branches = Object.entries(ASK_PRIORITY).map(
    ([kind, priority]) => sql`when ${kind}::question_kind then ${priority}`,
  );
  return sql.join([sql`case`, questions.kind, ...branches, sql`else 99 end`], sql` `);
}

export interface AskBudgetStatus {
  /** Asked and still unanswered. The reader is already waiting on these. */
  openCount: number;
  /** Actually sent inside the rolling window, whatever became of them since. */
  windowCount: number;
  /** How many more may be asked right now. Zero means queue it. */
  slots: number;
  available: boolean;
  /** One line, for the trace and for the activity panel. */
  reason: string;
}

/**
 * Counts both halves of the budget.
 *
 * The window count includes questions that have since been answered or gone obsolete. It
 * measures how much Baton has *said* in the last day, not how much is outstanding — those
 * are different things and the second is what `openCount` is for. A window that only
 * counted unanswered asks would let a burst of quickly-answered questions reset the cap.
 */
export async function askBudgetStatus(db: Executor, now: Date): Promise<AskBudgetStatus> {
  const cutoff = new Date(now.getTime() - ASK_BUDGET.rollingWindowHours * 3_600_000);

  const openRows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(questions)
    .where(and(eq(questions.status, "asked"), isNull(questions.answerText)));
  const openCount = Number(openRows[0]?.count ?? 0);

  const windowRows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(questions)
    .where(gt(questions.askedAt, cutoff));
  const windowCount = Number(windowRows[0]?.count ?? 0);

  const openSlots = Math.max(0, ASK_BUDGET.maxOpen - openCount);
  const windowSlots = Math.max(0, ASK_BUDGET.maxPerRollingWindow - windowCount);
  const slots = Math.min(openSlots, windowSlots);

  const reason =
    slots > 0
      ? `${slots} ask(s) available: ${openCount}/${ASK_BUDGET.maxOpen} open, ${windowCount}/${ASK_BUDGET.maxPerRollingWindow} in the last ${ASK_BUDGET.rollingWindowHours} hours.`
      : openSlots === 0
        ? `Already waiting on ${openCount} question(s); the limit is ${ASK_BUDGET.maxOpen}.`
        : `Already asked ${windowCount} question(s) in the last ${ASK_BUDGET.rollingWindowHours} hours; the limit is ${ASK_BUDGET.maxPerRollingWindow}.`;

  return { openCount, windowCount, slots, available: slots > 0, reason };
}

export interface QueueQuestionInput {
  kind: QuestionKind;
  /** Group, or the coordinator privately. Driven by the asset's sensitivity. */
  target: QuestionTarget;
  targetPersonId?: string | null;
  askedText: string;
  factId?: string | null;
  assetId?: string | null;
  pendingChangeId?: string | null;
  interruptId?: string | null;
  interruptName?: string | null;
}

export interface QueuedQuestion {
  questionId: string;
  /** False when an identical unresolved ask already existed. */
  created: boolean;
}

/**
 * Records a question, always as `queued`.
 *
 * **Never sets `asked_at`**, and asking is a separate step, because the rolling window
 * counts what was sent rather than what was thought of. Inserting as `asked` and hoping
 * the send succeeds would consume budget for a message nobody received.
 *
 * Duplicate suppression is on the exact `asked_text` among rows that are still `queued` or
 * `asked`. Exact text is the right granularity even though it looks crude: the thing being
 * prevented is a coordinator reading the same sentence twice, and two askings that differ
 * by a word are two sentences to read. It is also the only comparison available for a
 * question whose subject is an unresolved mention with no fact or asset to key on.
 */
export async function queueQuestion(
  db: Executor,
  input: QueueQuestionInput,
): Promise<QueuedQuestion> {
  const existing = await db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(eq(questions.askedText, input.askedText), inArray(questions.status, ["queued", "asked"])),
    )
    .limit(1);

  const found = existing[0];
  if (found !== undefined) return { questionId: found.id, created: false };

  const rows = await db
    .insert(questions)
    .values({
      kind: input.kind,
      target: input.target,
      targetPersonId: input.targetPersonId ?? null,
      askedText: input.askedText,
      status: "queued",
      factId: input.factId ?? null,
      assetId: input.assetId ?? null,
      pendingChangeId: input.pendingChangeId ?? null,
      interruptId: input.interruptId ?? null,
      interruptName: input.interruptName ?? null,
    })
    .returning({ id: questions.id });

  const row = rows[0];
  if (row === undefined) throw new Error("Failed to queue a question");
  return { questionId: row.id, created: true };
}

export interface AskableQuestion {
  id: string;
  kind: QuestionKind;
  target: QuestionTarget;
  targetPersonId: string | null;
  askedText: string;
  factId: string | null;
  assetId: string | null;
  pendingChangeId: string | null;
}

/**
 * The queued questions that may be asked now, worst-waited-first within priority.
 *
 * Capped by the budget, ordered by priority derived from `kind` and then by age. This is
 * what makes "an approval raised while the budget is full of verifications is asked next"
 * true: the approval does not jump an already-sent message, but it is first in line the
 * moment a slot frees.
 *
 * Selecting and marking are two steps on purpose. The message has to actually reach
 * Telegram before the budget is spent, and a single `update ... returning` would spend it
 * on a send that then failed. Nothing races on this in practice — every path that asks runs
 * under the pipeline advisory lock — and the ordering is chosen so that if something ever
 * did, the failure is a question asked later rather than budget consumed for nothing.
 */
export async function selectAskableQuestions(
  db: Executor,
  now: Date,
  cap?: number,
): Promise<AskableQuestion[]> {
  const budget = await askBudgetStatus(db, now);
  const limit = cap === undefined ? budget.slots : Math.min(cap, budget.slots);
  if (limit <= 0) return [];

  return db
    .select({
      id: questions.id,
      kind: questions.kind,
      target: questions.target,
      targetPersonId: questions.targetPersonId,
      askedText: questions.askedText,
      factId: questions.factId,
      assetId: questions.assetId,
      pendingChangeId: questions.pendingChangeId,
    })
    .from(questions)
    .where(eq(questions.status, "queued"))
    .orderBy(priorityOrder(), asc(questions.createdAt))
    .limit(limit);
}

/**
 * Stamps a question as asked, once.
 *
 * `where status = 'queued'` plus `returning` means this succeeds exactly once per question,
 * so a retried send cannot consume two slots of budget for one sentence.
 */
export async function markQuestionAsked(
  db: Executor,
  questionId: string,
  { botTelegramMessageId, at }: { botTelegramMessageId: number | null; at: Date },
): Promise<boolean> {
  const rows = await db
    .update(questions)
    .set({ status: "asked", askedAt: at, botTelegramMessageId })
    .where(and(eq(questions.id, questionId), eq(questions.status, "queued")))
    .returning({ id: questions.id });
  return rows.length > 0;
}

export interface ResolveQuestionInput {
  answerText: string;
  answeredByPersonId: string | null;
  /** How it ended, in words: approved, rejected, answered. */
  resolution: string;
  at: Date;
}

/**
 * Records an answer.
 *
 * Only an `asked` question can be answered. A `queued` one was never sent, so an answer to
 * it would be an answer to a question nobody heard — and accepting it would let a reply to
 * something else resolve a pending ask by coincidence.
 */
export async function resolveQuestion(
  db: Executor,
  questionId: string,
  { answerText, answeredByPersonId, resolution, at }: ResolveQuestionInput,
): Promise<boolean> {
  const rows = await db
    .update(questions)
    .set({
      status: "resolved",
      answerText,
      answeredByPersonId,
      answeredAt: at,
      resolution,
      resolvedAt: at,
    })
    .where(and(eq(questions.id, questionId), eq(questions.status, "asked")))
    .returning({ id: questions.id });
  return rows.length > 0;
}

/**
 * Retires a question whose subject has moved on.
 *
 * The third outcome, and the reason `obsolete` exists: an answer arriving after the claim
 * it was about had already been superseded must not be applied, and must not sit open
 * forever either. It consumed budget when it was asked and it does not get that back —
 * which is correct, because the reader did read it.
 */
export async function markQuestionObsolete(
  db: Executor,
  questionId: string,
  reason: string,
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(questions)
    .set({ status: "obsolete", resolution: reason, resolvedAt: at })
    .where(and(eq(questions.id, questionId), inArray(questions.status, ["queued", "asked"])))
    .returning({ id: questions.id });
  return rows.length > 0;
}

export interface OpenQuestion {
  id: string;
  kind: QuestionKind;
  status: "queued" | "asked";
  target: QuestionTarget;
  askedText: string;
  askedAt: Date | null;
  botTelegramMessageId: number | null;
  pendingChangeId: string | null;
  factId: string | null;
  createdAt: Date;
}

/**
 * Everything Baton is waiting on: queued and asked together.
 *
 * Rendered as one list, because to a coordinator both mean the same thing — Baton is
 * holding something back pending an answer — and splitting them would invite the question
 * "why is that one different", whose answer is an implementation detail.
 */
export async function selectWaitingOn(db: Executor): Promise<OpenQuestion[]> {
  return db
    .select({
      id: questions.id,
      kind: questions.kind,
      status: sql<"queued" | "asked">`${questions.status}`,
      target: questions.target,
      askedText: questions.askedText,
      askedAt: questions.askedAt,
      botTelegramMessageId: questions.botTelegramMessageId,
      pendingChangeId: questions.pendingChangeId,
      factId: questions.factId,
      createdAt: questions.createdAt,
    })
    .from(questions)
    .where(inArray(questions.status, ["queued", "asked"]))
    .orderBy(priorityOrder(), asc(questions.createdAt));
}

/** An asked, unanswered question by the bot's own message id. The exact reply match. */
export async function findAskedQuestionByBotMessageId(
  db: Executor,
  botTelegramMessageId: number,
): Promise<OpenQuestion | null> {
  const rows = await db
    .select({
      id: questions.id,
      kind: questions.kind,
      status: sql<"queued" | "asked">`${questions.status}`,
      target: questions.target,
      askedText: questions.askedText,
      askedAt: questions.askedAt,
      botTelegramMessageId: questions.botTelegramMessageId,
      pendingChangeId: questions.pendingChangeId,
      factId: questions.factId,
      createdAt: questions.createdAt,
    })
    .from(questions)
    .where(
      and(
        eq(questions.botTelegramMessageId, botTelegramMessageId),
        eq(questions.status, "asked"),
        isNull(questions.answerText),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The most recently asked open question, for the reply that did not use Telegram's reply
 * feature.
 *
 * Deliberately returns **at most one** and only within a window. Beyond that the match is a
 * guess, and a guess here attaches an answer to the wrong question — which for an approval
 * means applying a change nobody approved. The caller treats an empty result as ambiguous
 * rather than widening the search.
 */
export async function findMostRecentAskedQuestion(
  db: Executor,
  now: Date,
  withinHours: number,
): Promise<OpenQuestion | null> {
  const cutoff = new Date(now.getTime() - withinHours * 3_600_000);

  const rows = await db
    .select({
      id: questions.id,
      kind: questions.kind,
      status: sql<"queued" | "asked">`${questions.status}`,
      target: questions.target,
      askedText: questions.askedText,
      askedAt: questions.askedAt,
      botTelegramMessageId: questions.botTelegramMessageId,
      pendingChangeId: questions.pendingChangeId,
      factId: questions.factId,
      createdAt: questions.createdAt,
    })
    .from(questions)
    .where(
      and(
        eq(questions.status, "asked"),
        isNull(questions.answerText),
        gt(questions.askedAt, cutoff),
      ),
    )
    .orderBy(desc(questions.askedAt))
    .limit(2);

  // Two open asks and no reply pointer is genuinely ambiguous. Picking the newer one would
  // be a coin flip dressed as a resolution.
  if (rows.length !== 1) return null;
  return rows[0] ?? null;
}

/** How many asks are waiting for a slot. For the activity panel and for tests. */
export async function countQueuedQuestions(db: Executor): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(questions)
    .where(eq(questions.status, "queued"));
  return Number(rows[0]?.count ?? 0);
}
