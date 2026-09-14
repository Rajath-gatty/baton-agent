/**
 * The `briefs` and `brief_lines` tables. `[F23]` `[F25]`
 *
 * **Lines are rows, not prose.** That is a storage requirement rather than a stylistic
 * one: each line is individually assignable and each carries its own evidence reference,
 * so a brief returned as three paragraphs could not be assigned, could not be clicked
 * through to the five-month-old message it came from, and would lose the single most
 * persuasive thing the product does.
 *
 * **The empty brief is a first-class row.** A departing volunteer who held nothing gets a
 * brief that says so in one sentence. Three empty sections read as broken software, and a
 * coordinator who sees that once stops opening briefs — which costs more than the brief
 * was worth.
 *
 * One brief per transition, not per event. Telegram can deliver the same `chat_member`
 * update more than once, and a second identical handover document is worse than noise: it
 * makes a coordinator wonder which one is current.
 */

import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import type { BriefKind, BriefSection, BrieferOutput } from "@baton/core";
import type { Executor } from "./types.js";

const { briefLines, briefs } = schema;

export interface StoreBriefInput {
  brief: BrieferOutput;
  runId: string | null;
  /** The message that triggered it, where there was one. A `chat_member` event has none. */
  triggeredByMessageId?: string | null;
  generatedAt: Date;
}

export interface StoredBrief {
  briefId: string;
  lineCount: number;
}

/**
 * Writes a brief and its lines.
 *
 * `position` is assigned per section from the order the Briefer returned, because the three
 * sections are ordered and so is the reading within them. Deriving it from array index
 * across the whole list would break the unique index the moment two sections interleaved.
 */
export async function storeBrief(
  db: Executor,
  { brief, runId, triggeredByMessageId = null, generatedAt }: StoreBriefInput,
): Promise<StoredBrief> {
  const inserted = await db
    .insert(briefs)
    .values({
      kind: brief.kind,
      subjectPersonId: brief.subjectPersonId,
      runId,
      triggeredByMessageId,
      openingLine: brief.openingLine,
      isEmpty: brief.isEmpty,
      generatedAt,
    })
    .returning({ id: briefs.id });

  const briefId = inserted[0]?.id;
  if (briefId === undefined) throw new Error("Failed to store a brief");

  if (brief.lines.length === 0) return { briefId, lineCount: 0 };

  const positions = new Map<BriefSection, number>();
  const rows = brief.lines.map((line) => {
    const next = positions.get(line.section) ?? 0;
    positions.set(line.section, next + 1);
    return {
      briefId,
      section: line.section,
      position: next,
      text: line.text,
      evidenceFactIds: line.evidenceFactIds,
      evidenceMessageIds: line.evidenceMessageIds,
      subjectAssetId: line.subjectAssetId,
      subjectCapabilityId: line.subjectCapabilityId,
      subjectCommitmentId: line.subjectCommitmentId,
    };
  });

  await db.insert(briefLines).values(rows);
  return { briefId, lineCount: rows.length };
}

export interface BriefLineRow {
  id: string;
  section: BriefSection;
  position: number;
  text: string;
  evidenceFactIds: string[];
  evidenceMessageIds: string[];
  assignedToPersonId: string | null;
  assignedAt: Date | null;
}

export interface BriefRow {
  id: string;
  kind: BriefKind;
  subjectPersonId: string;
  openingLine: string;
  isEmpty: boolean;
  generatedAt: Date;
  readAt: Date | null;
  lines: BriefLineRow[];
}

/** One brief with its lines, in section-then-position order. */
export async function findBrief(db: Executor, briefId: string): Promise<BriefRow | null> {
  const rows = await db
    .select({
      id: briefs.id,
      kind: briefs.kind,
      subjectPersonId: briefs.subjectPersonId,
      openingLine: briefs.openingLine,
      isEmpty: briefs.isEmpty,
      generatedAt: briefs.generatedAt,
      readAt: briefs.readAt,
    })
    .from(briefs)
    .where(eq(briefs.id, briefId))
    .limit(1);

  const brief = rows[0];
  if (brief === undefined) return null;

  const lines = await db
    .select({
      id: briefLines.id,
      section: briefLines.section,
      position: briefLines.position,
      text: briefLines.text,
      evidenceFactIds: briefLines.evidenceFactIds,
      evidenceMessageIds: briefLines.evidenceMessageIds,
      assignedToPersonId: briefLines.assignedToPersonId,
      assignedAt: briefLines.assignedAt,
    })
    .from(briefLines)
    .where(eq(briefLines.briefId, briefId))
    // Section order comes from the enum's declaration order, which is the reading order the
    // design fixes: only_they_held, they_had_promised, nobody_else_seen.
    .orderBy(asc(briefLines.section), asc(briefLines.position));

  return { ...brief, lines };
}

/**
 * Whether a brief already exists for this transition.
 *
 * Keyed on the transition instant rather than on the triggering event, because a
 * `chat_member` update carries no message id to key on and Telegram can deliver the same
 * update twice. `since` is the person's `left_at` or `joined_at` — so a *later* departure by
 * the same person legitimately produces a second brief, while a duplicated delivery of one
 * departure does not.
 */
export async function findBriefForTransition(
  db: Executor,
  subjectPersonId: string,
  kind: BriefKind,
  since: Date,
): Promise<string | null> {
  const rows = await db
    .select({ id: briefs.id })
    .from(briefs)
    .where(
      and(
        eq(briefs.subjectPersonId, subjectPersonId),
        eq(briefs.kind, kind),
        gte(briefs.generatedAt, since),
      ),
    )
    .orderBy(desc(briefs.generatedAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Marks a brief read, which is what clears the unread banner. */
export async function markBriefRead(db: Executor, briefId: string, at: Date): Promise<boolean> {
  const rows = await db
    .update(briefs)
    .set({ readAt: at })
    .where(and(eq(briefs.id, briefId), isNull(briefs.readAt)))
    .returning({ id: briefs.id });
  return rows.length > 0;
}

/**
 * Assigns one line to a person.
 *
 * **A record, not a notification.** Baton does not chase people, and it does not message
 * the assignee: the assignment is something the coordinator did and something the UI shows.
 * Sending a message here would turn a handover checklist into a task manager that nags.
 */
export async function assignBriefLine(
  db: Executor,
  lineId: string,
  personId: string | null,
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(briefLines)
    .set({
      assignedToPersonId: personId,
      assignedAt: personId === null ? null : at,
    })
    .where(eq(briefLines.id, lineId))
    .returning({ id: briefLines.id });
  return rows.length > 0;
}

/** Briefs nobody has opened. Drives the banner. */
export async function countUnreadBriefs(db: Executor): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(briefs)
    .where(isNull(briefs.readAt));
  return Number(rows[0]?.count ?? 0);
}

/** Every brief, newest first. For the briefs page. */
export async function selectBriefs(db: Executor, limit = 20): Promise<Omit<BriefRow, "lines">[]> {
  return db
    .select({
      id: briefs.id,
      kind: briefs.kind,
      subjectPersonId: briefs.subjectPersonId,
      openingLine: briefs.openingLine,
      isEmpty: briefs.isEmpty,
      generatedAt: briefs.generatedAt,
      readAt: briefs.readAt,
    })
    .from(briefs)
    .orderBy(desc(briefs.generatedAt))
    .limit(limit);
}
