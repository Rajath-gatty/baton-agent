/**
 * The read seam.
 *
 * This is the single place the UI reaches for data, and it now reaches Postgres.
 * Every function below is a Drizzle query against `@baton/core/db` plus the
 * mapping from a persisted row to the render types in `./types`. The signatures
 * are unchanged from the fixture era on purpose: the swap this file was built to
 * absorb has happened here and nowhere else, and no page or component changed
 * shape because of it.
 *
 * Three properties this file is responsible for, all of them enforced in SQL
 * rather than in the components that render the result:
 *
 *   1. **A pending or unverified claim never reaches a surface that reads as
 *      truth.** The inventory and the register are filtered to `active`, which is
 *      the same filter detection uses — so the promise that a change held for
 *      approval is invisible is kept in one place for reads as it is for writes.
 *   2. **Nothing here counts, ranks or scores a person.** People are joined only
 *      to resolve a display name for a holder, which is an attribute of a holding.
 *   3. **The raw text of a message leaves this file.** Redaction happens at the
 *      boundary the browser reads from, in `app/panel-actions.ts`, because that is
 *      the only place a message's text is sent anywhere. Nothing else here selects
 *      `messages.text` at all.
 *
 * Everything is async, everything is one round trip per surface, and the page
 * fires them in parallel.
 */

import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { AssetKind, BriefSection, TraceEntry } from "@baton/core";
import { ASSET_KINDS, BRIEF_SECTIONS } from "@baton/core";
import { schema } from "@baton/core/db";
import { getDb } from "./db";
import { openVisitWindow } from "./visit";
import type {
  Asset,
  Brief,
  BriefLine,
  Diff,
  Fact,
  Finding,
  Holding,
  IsoTimestamp,
  QuietDecision,
  Question,
  Run,
} from "./types";

const {
  appSettings,
  assets,
  briefLines,
  briefs,
  facts,
  findings,
  holdings,
  messages,
  people,
  questions,
  quietDecisions,
  runs,
} = schema;

/** How many rows a strip or a list will ever render. Reading, not reporting. */
const LIST_LIMIT = 50;
/** The since-you-last-looked strip is four lines of a fold budget, not a feed. */
const DIFF_LIMIT = 8;

function iso(value: Date): IsoTimestamp {
  return value.toISOString();
}

function isoOrNull(value: Date | null): IsoTimestamp | null {
  return value === null ? null : value.toISOString();
}

// ── runs ────────────────────────────────────────────────────────────────────

/** `runs.status` narrowed to the three states the activity panel renders. */
function runStatus(status: string): Run["status"] {
  switch (status) {
    case "running":
      return "running";
    case "failed":
      return "error";
    // `interrupted` is a successful pause — the run stopped to ask something and
    // its snapshot is waiting — so it reads as complete rather than as an error.
    default:
      return "complete";
  }
}

const RUN_COLUMNS = {
  id: runs.id,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
  messagesRead: runs.messagesRead,
  factsExtracted: runs.factsExtracted,
  candidatesSkipped: runs.candidatesSkipped,
  findingsProduced: runs.findingsProduced,
  status: runs.status,
  trace: runs.trace,
} as const;

interface RunRow {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  messagesRead: number;
  factsExtracted: number;
  candidatesSkipped: number;
  findingsProduced: number;
  status: string;
  trace: TraceEntry[];
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    startedAt: iso(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
    messagesConsidered: row.messagesRead,
    factsRecorded: row.factsExtracted,
    candidatesSkipped: row.candidatesSkipped,
    findingsTouched: row.findingsProduced,
    status: runStatus(row.status),
    trace: row.trace,
  };
}

/** The most recent run, or null if the register has never run. */
export async function getLastRun(): Promise<Run | null> {
  const rows = await getDb()
    .select(RUN_COLUMNS)
    .from(runs)
    .orderBy(desc(runs.startedAt))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toRun(row);
}

/** Every run, newest first. */
export async function getRuns(): Promise<Run[]> {
  const rows = await getDb()
    .select(RUN_COLUMNS)
    .from(runs)
    .orderBy(desc(runs.startedAt))
    .limit(LIST_LIMIT);
  return rows.map(toRun);
}

// ── the state sentence ──────────────────────────────────────────────────────

const NUMBER_WORDS = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
] as const;

/** "Seven", "Three" — words up to twelve, digits past it. The line is prose. */
function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/**
 * The state of the organisation as one sentence.
 *
 * Composed from counts rather than written by a model, for the same reason
 * detection is SQL: this line has to be true, and a model asked to summarise the
 * register would occasionally round seven exposures to "several". The three cases
 * it distinguishes are the three that are actually different — a register that has
 * never been derived, a register with nothing open, and a register with exposures
 * in it.
 */
export async function getStateSentence(): Promise<string> {
  const db = getDb();

  const [counts] = await db
    .select({
      open: sql<string>`count(*) filter (where ${findings.status} = 'open')::text`,
      sole: sql<string>`count(*) filter (where ${findings.status} = 'open' and ${findings.subtype} = 'sole_holder')::text`,
      unowned: sql<string>`count(*) filter (where ${findings.status} = 'open' and ${findings.subtype} = 'no_owner')::text`,
      total: sql<string>`count(*)::text`,
    })
    .from(findings);

  const open = Number(counts?.open ?? 0);
  const sole = Number(counts?.sole ?? 0);
  const unowned = Number(counts?.unowned ?? 0);
  const everDerived = Number(counts?.total ?? 0) > 0;

  if (!everDerived) {
    // Honest about the one state that is neither good news nor an exposure: the
    // messages are in, and nothing has been derived from them yet.
    const [messageCount] = await db.select({ n: sql<string>`count(*)::text` }).from(messages);
    const read = Number(messageCount?.n ?? 0);
    return read === 0
      ? "Baton has read nothing yet — the register is empty because there is no history in it."
      : `Baton has read ${read.toLocaleString("en-IN")} messages and has not yet derived a register from them.`;
  }

  if (open === 0) {
    return "Nothing stands exposed — every capability the group relies on has been seen in more than one pair of hands.";
  }

  const noun = open === 1 ? "exposure stands" : "exposures stand";

  if (sole > 0) {
    const clause =
      sole === open
        ? sole === 1
          ? "a capability the group relies on has been seen in a single pair of hands"
          : "each one a capability the group relies on that has been seen in a single pair of hands"
        : `${numberWord(sole).toLowerCase()} of them where a capability the group relies on has been seen in a single pair of hands`;
    return `${numberWord(open)} ${noun} open — ${clause}.`;
  }

  if (unowned > 0) {
    const clause =
      unowned === open
        ? unowned === 1
          ? "nobody is recorded as holding it"
          : "nobody is recorded as holding any of them"
        : `${numberWord(unowned).toLowerCase()} of them with nobody recorded as holding it`;
    return `${numberWord(open)} ${noun} open — ${clause}.`;
  }

  return `${numberWord(open)} ${noun} open on the register.`;
}

// ── since you last looked ───────────────────────────────────────────────────

/**
 * What changed since the coordinator last looked, newest first.
 *
 * Four queries rather than one union, because the four kinds of change live in
 * different tables and each needs a different sentence. The window comes from
 * `coordinator_state` — see `./visit`, which also advances it.
 */
export async function getSinceYouLastLooked(): Promise<Diff[]> {
  const db = getDb();
  const since = await openVisitWindow();

  const [raised, revised, closed, withheld] = await Promise.all([
    // Raised: a finding first seen after the last visit and still standing.
    db
      .select({
        id: findings.id,
        title: findings.title,
        firstSeenAt: findings.firstSeenAt,
        evidenceFactIds: findings.evidenceFactIds,
      })
      .from(findings)
      .where(and(eq(findings.status, "open"), gte(findings.firstSeenAt, since)))
      .orderBy(desc(findings.firstSeenAt))
      .limit(DIFF_LIMIT),

    // Revised: a claim that superseded an earlier one. The supersession, not the
    // insertion, is the change worth a line.
    db
      .select({ id: facts.id, claim: facts.claim, createdAt: facts.createdAt })
      .from(facts)
      .where(and(isNotNull(facts.supersedesFactId), gte(facts.createdAt, since)))
      .orderBy(desc(facts.createdAt))
      .limit(DIFF_LIMIT),

    // Closed: resolved or dismissed since the last visit. Both are closures, and
    // the sentence says which.
    db
      .select({
        id: findings.id,
        title: findings.title,
        status: findings.status,
        dismissalReason: findings.dismissalReason,
        resolvedAt: findings.resolvedAt,
        dismissedAt: findings.dismissedAt,
        evidenceFactIds: findings.evidenceFactIds,
      })
      .from(findings)
      .where(
        or(gte(findings.resolvedAt, since), gte(findings.dismissedAt, since)),
      )
      .orderBy(desc(findings.lastSeenAt))
      .limit(DIFF_LIMIT),

    // Held back: Restraint's own decisions, on the same strip as the rest. What
    // Baton declined to say is a change in the register too.
    db
      .select({
        id: quietDecisions.id,
        withheld: quietDecisions.withheld,
        createdAt: quietDecisions.createdAt,
      })
      .from(quietDecisions)
      .where(gte(quietDecisions.createdAt, since))
      .orderBy(desc(quietDecisions.createdAt))
      .limit(DIFF_LIMIT),
  ]);

  const lines: Diff[] = [
    ...raised.map((row) => ({
      id: `raised-${row.id}`,
      kind: "added" as const,
      text: `A new exposure: ${row.title}`,
      factId: row.evidenceFactIds[0] ?? null,
      at: iso(row.firstSeenAt),
    })),
    ...revised.map((row) => ({
      id: `revised-${row.id}`,
      kind: "changed" as const,
      text: `Revised — ${row.claim}`,
      factId: row.id,
      at: iso(row.createdAt),
    })),
    ...closed.map((row) => ({
      id: `closed-${row.id}`,
      kind: "resolved" as const,
      text:
        row.status === "dismissed"
          ? `Dismissed — ${row.title}${row.dismissalReason === null ? "" : ` (${row.dismissalReason})`}`
          : `Closed — ${row.title}`,
      factId: row.evidenceFactIds[0] ?? null,
      at: iso(row.dismissedAt ?? row.resolvedAt ?? since),
    })),
    ...withheld.map((row) => ({
      id: `withheld-${row.id}`,
      kind: "withheld" as const,
      text: row.withheld,
      factId: null,
      at: iso(row.createdAt),
    })),
  ];

  return lines
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, DIFF_LIMIT);
}

// ── questions ───────────────────────────────────────────────────────────────

/**
 * Why Baton is asking, by kind.
 *
 * Derived rather than stored: the `questions` table keeps the text asked and not a
 * rationale, and priority is derived from kind for the same reason — that a
 * verification outranks nothing and an approval outranks everything is fixed
 * policy, not a per-question judgement. So the rationale is the policy, stated.
 */
const QUESTION_RATIONALE: Record<Question["kind"], string> = {
  approval:
    "A consequential change is held out of the register until the coordinator agrees to it. It is never adopted on a timeout.",
  clarification:
    "Baton could not tell who or what this refers to, so it is asking rather than guessing.",
  verification:
    "The claim reached Baton second-hand, so it is held as unverified and out of every finding until the group confirms it.",
};

/** Open questions (queued or asked), approvals first, then by age. */
export async function getOpenQuestions(): Promise<Question[]> {
  const rows = await getDb()
    .select({
      id: questions.id,
      kind: questions.kind,
      status: questions.status,
      askedText: questions.askedText,
      factId: questions.factId,
      createdAt: questions.createdAt,
      askedAt: questions.askedAt,
    })
    .from(questions)
    .where(inArray(questions.status, ["queued", "asked"]))
    // Approval before clarification before verification, then oldest first. The
    // enum is declared verification → clarification → approval, so descending on
    // the kind is the ask priority the constants fix.
    .orderBy(sql`${questions.kind} desc`, questions.createdAt)
    .limit(LIST_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    text: row.askedText,
    rationale: QUESTION_RATIONALE[row.kind],
    factId: row.factId,
    createdAt: iso(row.createdAt),
    askedAt: isoOrNull(row.askedAt),
  }));
}

// ── findings ────────────────────────────────────────────────────────────────

const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
});

interface FindingRow {
  id: string;
  subtype: Finding["subtype"];
  severity: Finding["severity"];
  status: Finding["status"];
  title: string;
  whyItMatters: string;
  confidence: number;
  dedupeKey: string;
  evidenceFactIds: string[];
  evidenceMessageIds: string[];
  assessorReasoning: string | null;
  dismissalReason: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  holderName: string | null;
}

const FINDING_COLUMNS = {
  id: findings.id,
  subtype: findings.subtype,
  severity: findings.severity,
  status: findings.status,
  title: findings.title,
  whyItMatters: findings.whyItMatters,
  confidence: findings.confidence,
  dedupeKey: findings.dedupeKey,
  evidenceFactIds: findings.evidenceFactIds,
  evidenceMessageIds: findings.evidenceMessageIds,
  assessorReasoning: findings.assessorReasoning,
  dismissalReason: findings.dismissalReason,
  firstSeenAt: findings.firstSeenAt,
  lastSeenAt: findings.lastSeenAt,
  holderName: people.displayName,
} as const;

/**
 * The Assessor's reasoning, or the register's own rule when a finding was written
 * without one. The panel and the set-aside card both show this field, so it is
 * never left empty — but a rule is labelled as a rule rather than dressed up as a
 * judgement about this particular exposure.
 */
const SUBTYPE_RULE: Record<Finding["subtype"], string> = {
  sole_holder:
    "Raised by the register's own rule: the detection query found exactly one active holder for this, and one holder is one departure away from none.",
  no_owner:
    "Raised by the register's own rule: this is active on the inventory and no active holding names anyone at all.",
  not_ours:
    "Raised by the register's own rule: the holding is flagged as a volunteer's personal resource, so the group relies on something it does not own.",
  loose_end:
    "Raised by the register's own rule: the commitment is still open past the point where it was expected to close.",
};

function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    subtype: row.subtype,
    severity: row.severity,
    status: row.status,
    title: row.title,
    whyItMatters: row.whyItMatters,
    // The count is of source messages, which is what the Assessor's suppression
    // threshold turns on — not of facts.
    evidenceCount: row.evidenceMessageIds.length,
    confidence: row.confidence,
    holderName: row.holderName,
    dedupeKey: row.dedupeKey,
    factId: row.evidenceFactIds[0] ?? null,
    firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt),
    assessorReasoning: row.assessorReasoning ?? SUBTYPE_RULE[row.subtype],
    dismissalReason: row.dismissalReason,
  };
}

/**
 * The register: open findings, ranked. Severity descending, then confidence
 * descending, so the exposures a coordinator must act on rise to the top.
 *
 * `severity desc` works in SQL because the enum is declared low → medium → high;
 * this is the index `findings(status, severity desc)` exists for.
 */
export async function getRegister(): Promise<Finding[]> {
  const rows = await getDb()
    .select(FINDING_COLUMNS)
    .from(findings)
    .leftJoin(people, eq(people.id, findings.holderPersonId))
    .where(eq(findings.status, "open"))
    .orderBy(sql`${findings.severity} desc`, desc(findings.confidence))
    .limit(LIST_LIMIT);
  return rows.map(toFinding);
}

/** Findings the coordinator dismissed, newest first. */
export async function getDismissedFindings(): Promise<Finding[]> {
  const rows = await getDb()
    .select(FINDING_COLUMNS)
    .from(findings)
    .leftJoin(people, eq(people.id, findings.holderPersonId))
    .where(eq(findings.status, "dismissed"))
    .orderBy(desc(findings.lastSeenAt))
    .limit(LIST_LIMIT);
  return rows.map(toFinding);
}

// ── quiet decisions ─────────────────────────────────────────────────────────

/** The quiet decisions, newest first — restraint made visible. */
export async function getQuietDecisions(): Promise<QuietDecision[]> {
  const rows = await getDb()
    .select({
      id: quietDecisions.id,
      withheld: quietDecisions.withheld,
      reason: quietDecisions.reason,
      scope: quietDecisions.scope,
      runId: quietDecisions.runId,
      createdAt: quietDecisions.createdAt,
    })
    .from(quietDecisions)
    .orderBy(desc(quietDecisions.createdAt))
    .limit(LIST_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    summary: row.withheld,
    reasoning: row.reason,
    scope: row.scope,
    runId: row.runId,
    decidedAt: iso(row.createdAt),
  }));
}

// ── the inventory ───────────────────────────────────────────────────────────

/**
 * One asset kind with the assets of that kind and each asset's holdings. Every
 * one of the six kinds is present, even when empty, so the register reads as a
 * complete accounting rather than only the kinds that happen to have entries.
 */
export interface HoldingsGroup {
  kind: AssetKind;
  entries: { asset: Asset; holdings: Holding[] }[];
}

/**
 * Holdings grouped by asset kind, in the fixed `ASSET_KINDS` order.
 *
 * Two queries and a stitch rather than one join, because joining holdings to
 * assets multiplies the asset row per holder and the caller has to undo it —
 * and the asset's describing claim is a third shape again.
 *
 * Retired assets and released holdings are both excluded: the inventory answers
 * "who holds what now", and a released row shown without its release date would
 * name the wrong person as the current holder. The history is not lost — it is
 * what the fact panel's holder history renders.
 */
export async function getHoldingsByKind(): Promise<HoldingsGroup[]> {
  const db = getDb();

  const assetRows = await db
    .select({
      id: assets.id,
      kind: assets.kind,
      sensitivity: assets.sensitivity,
      name: assets.name,
      createdAt: assets.createdAt,
      /**
       * The claim that put this asset on the register, and its text as the row's
       * description. `distinct on` takes the most recently confirmed active fact
       * per asset, so an asset described by several claims shows the current one.
       */
      factId: sql<string | null>`(
        select f.id from ${facts} f
        where f.asset_id = ${assets.id} and f.status = 'active'
        order by f.last_confirmed_at desc
        limit 1
      )`,
      description: sql<string | null>`(
        select f.claim from ${facts} f
        where f.asset_id = ${assets.id} and f.status = 'active'
        order by f.last_confirmed_at desc
        limit 1
      )`,
    })
    .from(assets)
    .where(eq(assets.status, "active"))
    .orderBy(assets.name);

  const holdingRows =
    assetRows.length === 0
      ? []
      : await db
          .select({
            id: holdings.id,
            assetId: holdings.assetId,
            holderName: people.displayName,
            holderExternal: holdings.holderExternal,
            isPersonalResource: holdings.isPersonalResource,
            acquiredAt: holdings.acquiredAt,
            evidenceFactId: holdings.evidenceFactId,
            lastConfirmedAt: facts.lastConfirmedAt,
            claim: facts.claim,
          })
          .from(holdings)
          .leftJoin(people, eq(people.id, holdings.holderPersonId))
          .leftJoin(facts, eq(facts.id, holdings.evidenceFactId))
          .where(
            and(
              eq(holdings.status, "active"),
              inArray(
                holdings.assetId,
                assetRows.map((row) => row.id),
              ),
            ),
          )
          .orderBy(sql`${holdings.acquiredAt} asc nulls last`);

  const byAsset = new Map<string, Holding[]>();
  for (const row of holdingRows) {
    const holder = row.holderName ?? row.holderExternal;
    const list = byAsset.get(row.assetId) ?? [];
    list.push({
      id: row.id,
      assetId: row.assetId,
      holder,
      isPersonalResource: row.isPersonalResource,
      // When the holder was last *seen* exercising it: the confirming date of the
      // claim this holding rests on, falling back to when it was acquired.
      lastSeenAt: isoOrNull(row.lastConfirmedAt ?? row.acquiredAt),
      note: holdingNote(row.claim, row.isPersonalResource, holder),
    });
    byAsset.set(row.assetId, list);
  }

  return ASSET_KINDS.map((kind) => ({
    kind,
    entries: assetRows
      .filter((row) => row.kind === kind)
      .map((row) => ({
        asset: {
          id: row.id,
          kind: row.kind,
          sensitivity: row.sensitivity,
          label: row.name,
          description:
            row.description ??
            "No claim on the register describes this yet — it is known only from who holds it.",
          recordedAt: iso(row.createdAt),
          factId: row.factId,
        },
        holdings: byAsset.get(row.id) ?? [],
      })),
  }));
}

/** The row's secondary line: the claim behind the holding, or what its shape means. */
function holdingNote(
  claim: string | null,
  isPersonalResource: boolean,
  holder: string | null,
): string {
  if (claim !== null) return claim;
  if (holder === null) return "No claim names a holder for this.";
  if (isPersonalResource) return "Relied on by the group but owned by the holder.";
  return "Recorded from conversation, with no separate claim behind it.";
}

// ── briefs ──────────────────────────────────────────────────────────────────

/** An empty three-section map, so a section with no lines renders as empty, not absent. */
function emptySections(): Record<BriefSection, BriefLine[]> {
  return BRIEF_SECTIONS.reduce(
    (acc, section) => {
      acc[section] = [];
      return acc;
    },
    {} as Record<BriefSection, BriefLine[]>,
  );
}

/**
 * Briefs with their lines, newest first.
 *
 * The title is composed here rather than stored, because `briefs` holds the
 * *event* — a kind, a subject and an instant — and the title is a rendering of it.
 * `opening_line` is the Briefer's own sentence and becomes the trigger line, which
 * is what carries the empty brief: a departure that left nothing behind says so in
 * one sentence rather than in three empty sections.
 */
async function loadBriefs(limit: number, onlyUnread: boolean): Promise<Brief[]> {
  const db = getDb();

  const briefRows = await db
    .select({
      id: briefs.id,
      kind: briefs.kind,
      openingLine: briefs.openingLine,
      generatedAt: briefs.generatedAt,
      readAt: briefs.readAt,
      subjectName: people.displayName,
      privateChatId: people.privateChatId,
    })
    .from(briefs)
    .innerJoin(people, eq(people.id, briefs.subjectPersonId))
    .where(onlyUnread ? isNull(briefs.readAt) : undefined)
    .orderBy(desc(briefs.generatedAt))
    .limit(limit);

  if (briefRows.length === 0) return [];

  const lineRows = await db
    .select({
      id: briefLines.id,
      briefId: briefLines.briefId,
      section: briefLines.section,
      text: briefLines.text,
      evidenceFactIds: briefLines.evidenceFactIds,
      assignedAt: briefLines.assignedAt,
    })
    .from(briefLines)
    .where(
      inArray(
        briefLines.briefId,
        briefRows.map((row) => row.id),
      ),
    )
    // Section order is the enum's declaration order, which is the reading order
    // the design fixes; position orders within a section.
    .orderBy(briefLines.section, briefLines.position);

  const sectionsByBrief = new Map<string, Record<BriefSection, BriefLine[]>>();
  for (const row of lineRows) {
    const sections = sectionsByBrief.get(row.briefId) ?? emptySections();
    sections[row.section].push({
      id: row.id,
      text: row.text,
      factId: row.evidenceFactIds[0] ?? null,
      filed: row.assignedAt !== null,
    });
    sectionsByBrief.set(row.briefId, sections);
  }

  return briefRows.map((row) => ({
    id: row.id,
    title: `${row.subjectName} ${row.kind === "departure" ? "stepped back" : "arrived"} — ${dateFormatter.format(row.generatedAt)}`,
    trigger: row.openingLine,
    generatedAt: iso(row.generatedAt),
    read: row.readAt !== null,
    subject: {
      name: row.subjectName,
      // A bot cannot write to someone who has never written to it, so a direct
      // message is possible only where Telegram gave us a private chat id.
      canDirectMessage: row.privateChatId !== null,
    },
    sections: sectionsByBrief.get(row.id) ?? emptySections(),
  }));
}

/** Every brief, newest first. */
export async function getBriefs(): Promise<Brief[]> {
  return loadBriefs(LIST_LIMIT, false);
}

/** The most recent unread brief, or null if the coordinator is caught up. */
export async function getUnreadBrief(): Promise<Brief | null> {
  const unread = await loadBriefs(1, true);
  return unread[0] ?? null;
}

// ── facts ───────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A single fact by id, or null if unknown.
 *
 * The id is checked against the uuid shape first: Postgres raises a type error on
 * a malformed uuid rather than returning no rows, and the panel's honest answer to
 * a claim it cannot find is an empty state, not an error dialog.
 *
 * `sourceMessage.text` is the **raw** text. It is redacted at the boundary that
 * sends it to the browser — `app/panel-actions.ts` — and nothing else reads it.
 */
export async function getFact(id: string): Promise<Fact | null> {
  if (!UUID.test(id)) return null;

  const rows = await getDb()
    .select({
      id: facts.id,
      status: facts.status,
      claim: facts.claim,
      supersedesFactId: facts.supersedesFactId,
      statedAt: facts.statedAt,
      curatorReasoning: facts.curatorReasoning,
      assetId: facts.assetId,
      assetName: assets.name,
      assetKind: assets.kind,
      messageId: messages.id,
      messageText: messages.text,
      messageSentAt: messages.sentAt,
      messageAuthor: messages.senderDisplayName,
      messageWithdrawn: messages.isWithdrawn,
    })
    .from(facts)
    .innerJoin(messages, eq(messages.id, facts.sourceMessageId))
    .leftJoin(assets, eq(assets.id, facts.assetId))
    .where(eq(facts.id, id))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  return {
    id: row.id,
    status: row.status,
    statement: row.claim,
    sourceMessage: {
      id: row.messageId,
      authorName: row.messageAuthor ?? "Someone in the group",
      text: row.messageText ?? "",
      sentAt: iso(row.messageSentAt),
    },
    supersedes: row.supersedesFactId,
    topic: row.assetName ?? "A claim with no asset behind it",
    recordedAt: iso(row.statedAt),
    curatorReasoning: row.curatorReasoning,
    provenanceWithdrawn: row.messageWithdrawn,
  };
}

/**
 * Every holding recorded against a fact's asset, current and released.
 *
 * A real join on `asset_id`, which is what the fact panel's holder history needs:
 * the released rows are the point, because an asset with no current holder may
 * have had one last month and telling a clean transfer from a genuine gap is
 * impossible without them.
 */
export async function getHoldingsForFact(factId: string): Promise<Holding[]> {
  if (!UUID.test(factId)) return [];
  const db = getDb();

  // The fact's asset first, in its own statement rather than as a subquery: a
  // fact with no asset is an ordinary case — it is answerable but can never
  // produce a finding — and this way that case costs no second query at all.
  const factRows = await db
    .select({ assetId: facts.assetId })
    .from(facts)
    .where(eq(facts.id, factId))
    .limit(1);
  const assetId = factRows[0]?.assetId ?? null;
  if (assetId === null) return [];

  const rows = await db
    .select({
      id: holdings.id,
      assetId: holdings.assetId,
      holderName: people.displayName,
      holderExternal: holdings.holderExternal,
      isPersonalResource: holdings.isPersonalResource,
      acquiredAt: holdings.acquiredAt,
      releasedAt: holdings.releasedAt,
      status: holdings.status,
      claim: facts.claim,
      lastConfirmedAt: facts.lastConfirmedAt,
    })
    .from(holdings)
    .leftJoin(people, eq(people.id, holdings.holderPersonId))
    .leftJoin(facts, eq(facts.id, holdings.evidenceFactId))
    .where(eq(holdings.assetId, assetId))
    .orderBy(sql`${holdings.acquiredAt} asc nulls first`);

  return rows.map((row) => {
    const holder = row.holderName ?? row.holderExternal;
    const released = row.status === "released";
    return {
      id: row.id,
      assetId: row.assetId,
      holder,
      isPersonalResource: row.isPersonalResource,
      lastSeenAt: isoOrNull(row.lastConfirmedAt ?? row.releasedAt ?? row.acquiredAt),
      note: released
        ? `Released${row.releasedAt === null ? "" : ` on ${dateFormatter.format(row.releasedAt)}`}. Kept as history.`
        : holdingNote(row.claim, row.isPersonalResource, holder),
    };
  });
}

// ── settings ────────────────────────────────────────────────────────────────

/**
 * The coordinator on record, if there is one.
 *
 * Read by the write seam rather than by a page: filing a brief line records it
 * against a person, and the coordinator is the only person the admin UI can
 * legitimately act as. Null is a real state — if the coordinator is the volunteer
 * who left, it must be reassigned before an approval can resolve — and the write
 * says so rather than filing against nobody.
 */
export async function getCoordinatorPersonId(): Promise<string | null> {
  const rows = await getDb()
    .select({ coordinatorPersonId: appSettings.coordinatorPersonId })
    .from(appSettings)
    .limit(1);
  return rows[0]?.coordinatorPersonId ?? null;
}
