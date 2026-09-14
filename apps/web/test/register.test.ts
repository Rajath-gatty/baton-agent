/**
 * The admin UI's seam, against a real Postgres.
 *
 * This suite exists because of a specific past failure mode rather than for
 * coverage: while the UI read fixtures, every one of these functions could return
 * a plausible shape and be wrong about the database, and nothing would have said
 * so. The page renders whatever it is handed. So the assertions here are about the
 * five properties the components cannot check for themselves:
 *
 *   1. A row written by the worker maps onto the shape the page renders.
 *   2. A pending or unverified claim stays out of the surfaces that read as truth.
 *   3. Every coordinator write actually persists, and refuses politely when the
 *      row has already moved on.
 *   4. A correction supersedes rather than overwrites.
 *   5. A credential never leaves the server in a field the browser receives.
 *
 * `lib/mutations.ts` is driven directly rather than through `app/actions.ts`: a
 * `"use server"` module calls `revalidatePath`, which needs a Next request, so
 * testing through it would test the wrapper and not the write.
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@baton/core/db";
import { resolveTestDatabaseUrl, setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";

const {
  appSettings,
  assets,
  briefLines,
  briefs,
  coordinatorState,
  facts,
  findings,
  holdings,
  messages,
  people,
  questions,
  quietDecisions,
  runs,
} = schema;

/**
 * Point the app's client at the test database **before** the seams are imported.
 *
 * `resolveTestDatabaseUrl` is core's own guard and it refuses a `TEST_DATABASE_URL`
 * equal to `DATABASE_URL`, so this cannot be made to truncate the development
 * database — which holds the seeded six months and the golden reset point — by
 * misconfiguration. The assignment is what makes `lib/db.ts` resolve to the test
 * URL; it reads the variable lazily on first query, so it must happen up here,
 * before any module-level import runs a statement.
 */
process.env.DATABASE_URL = resolveTestDatabaseUrl();

const { getBriefs, getDismissedFindings, getFact, getHoldingsByKind, getHoldingsForFact, getLastRun, getOpenQuestions, getQuietDecisions, getRegister, getRuns, getSinceYouLastLooked, getStateSentence, getUnreadBrief } =
  await import("@/lib/data");
const mutations = await import("@/lib/mutations");
const { loadFactDetail } = await import("@/app/panel-actions");

let harness: TestDatabase;

beforeAll(async () => {
  harness = await setupTestDatabase();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.truncate();
});

// ── seeding ─────────────────────────────────────────────────────────────────

/**
 * One person, one message, one asset, one claim, one holding.
 *
 * Deliberately hand-written rather than borrowed from the seed generator: these
 * tests assert on exact strings and a generated transcript would make every
 * assertion a moving target.
 */
interface Seeded {
  personId: string;
  messageId: string;
  assetId: string;
  factId: string;
}

const CREDENTIAL_TEXT = "The Instagram login is with Meera, password is streetpaws2024";

async function seedRegister(options: { messageText?: string } = {}): Promise<Seeded> {
  const db = harness.db;

  const [person] = await db
    .insert(people)
    .values({ displayName: "Meera Sundaram", status: "member", privateChatId: 4242 })
    .returning({ id: people.id });
  if (person === undefined) throw new Error("seed: person");

  const [message] = await db
    .insert(messages)
    .values({
      source: "seed",
      chatId: -100,
      telegramMessageId: -1,
      senderPersonId: person.id,
      senderDisplayName: "Meera Sundaram",
      sentAt: new Date("2026-04-02T10:00:00Z"),
      text: options.messageText ?? CREDENTIAL_TEXT,
      contentHash: "hash-1",
      prefilterVerdict: "candidate",
    })
    .returning({ id: messages.id });
  if (message === undefined) throw new Error("seed: message");

  const [asset] = await db
    .insert(assets)
    .values({
      kind: "account_login",
      name: "Instagram — @streetpaws.blr",
      normalisedKey: "instagram streetpaws blr",
      sensitivity: "sensitive",
    })
    .returning({ id: assets.id });
  if (asset === undefined) throw new Error("seed: asset");

  const [fact] = await db
    .insert(facts)
    .values({
      assetId: asset.id,
      claim: "The Instagram account is held by one person.",
      matchKey: "account_login:instagram streetpaws blr#holder",
      valueSignature: "holder:meera",
      confidence: 0.9,
      status: "active",
      sourceMessageId: message.id,
      statedByPersonId: person.id,
      statedAt: new Date("2026-04-02T10:00:00Z"),
      lastConfirmedAt: new Date("2026-04-02T10:00:00Z"),
      evidenceMessageIds: [message.id],
      curatorReasoning: "Names who holds an account the group depends on.",
    })
    .returning({ id: facts.id });
  if (fact === undefined) throw new Error("seed: fact");

  await db.insert(holdings).values({
    assetId: asset.id,
    holderPersonId: person.id,
    status: "active",
    acquiredAt: new Date("2026-04-02T10:00:00Z"),
    evidenceFactId: fact.id,
  });

  await db.insert(appSettings).values({ id: 1, coordinatorPersonId: person.id });

  return {
    personId: person.id,
    messageId: message.id,
    assetId: asset.id,
    factId: fact.id,
  };
}

async function seedFinding(seeded: Seeded, over: { severity?: "low" | "medium" | "high" } = {}) {
  const [row] = await harness.db
    .insert(findings)
    .values({
      type: "asset",
      subtype: "sole_holder",
      dedupeKey: `sole_holder:asset:${seeded.assetId}`,
      title: "The Instagram account is held by one person",
      whyItMatters: "If that person steps back, nobody else can post.",
      severity: over.severity ?? "high",
      confidence: 0.82,
      status: "open",
      subjectAssetId: seeded.assetId,
      holderPersonId: seeded.personId,
      evidenceFactIds: [seeded.factId],
      evidenceMessageIds: [seeded.messageId],
      assessorReasoning: "One active holder for an account the group publishes from.",
    })
    .returning({ id: findings.id });
  if (row === undefined) throw new Error("seed: finding");
  return row.id;
}

// ── reads ───────────────────────────────────────────────────────────────────

describe("the read seam", () => {
  it("maps a worker-written finding onto the register row the page renders", async () => {
    const seeded = await seedRegister();
    const findingId = await seedFinding(seeded);

    const register = await getRegister();

    expect(register).toHaveLength(1);
    expect(register[0]).toMatchObject({
      id: findingId,
      subtype: "sole_holder",
      severity: "high",
      status: "open",
      // The holder is present as an attribute, and the title is about the account.
      holderName: "Meera Sundaram",
      // Read from evidence_fact_ids, not parsed out of the dedupe key: the key
      // names the *asset*, and feeding that to the fact panel opens nothing.
      factId: seeded.factId,
      evidenceCount: 1,
    });
    expect(register[0]?.title).not.toContain("Meera");
  });

  it("ranks the register worst-first", async () => {
    const seeded = await seedRegister();
    await seedFinding(seeded, { severity: "low" });
    await harness.db.insert(findings).values({
      type: "capability",
      subtype: "no_owner",
      dedupeKey: "no_owner:asset:second",
      title: "Nobody is recorded as holding the donation page",
      whyItMatters: "Donations would stop with nobody able to act.",
      severity: "high",
      confidence: 0.5,
      status: "open",
    });

    const register = await getRegister();
    expect(register.map((f) => f.severity)).toEqual(["high", "low"]);
  });

  it("states the register in one sentence, and says so honestly when nothing has been derived", async () => {
    const seeded = await seedRegister();
    // Messages in, no findings: the one state that is neither good news nor an
    // exposure, and the sentence must not claim the register is clean.
    expect(await getStateSentence()).toContain("has not yet derived a register");

    await seedFinding(seeded);
    const sentence = await getStateSentence();
    expect(sentence).toContain("One exposure stands open");
    expect(sentence).toContain("single pair of hands");
  });

  it("groups the inventory by all six asset kinds, describing each asset by its claim", async () => {
    const seeded = await seedRegister();

    const groups = await getHoldingsByKind();

    expect(groups).toHaveLength(6);
    const logins = groups.find((group) => group.kind === "account_login");
    expect(logins?.entries).toHaveLength(1);
    const entry = logins?.entries[0];
    expect(entry?.asset).toMatchObject({
      id: seeded.assetId,
      label: "Instagram — @streetpaws.blr",
      sensitivity: "sensitive",
      description: "The Instagram account is held by one person.",
      factId: seeded.factId,
    });
    expect(entry?.holdings[0]).toMatchObject({ holder: "Meera Sundaram", isPersonalResource: false });
    // Every kind is present even when empty, because a kind the group depends on
    // nothing of is itself information.
    expect(groups.find((group) => group.kind === "physical_item")?.entries).toEqual([]);
  });

  it("keeps a released holding out of the inventory and in the fact's history", async () => {
    const seeded = await seedRegister();
    const [other] = await harness.db
      .insert(people)
      .values({ displayName: "Anil Kumar", status: "member" })
      .returning({ id: people.id });
    await harness.db.insert(holdings).values({
      assetId: seeded.assetId,
      holderPersonId: other?.id ?? null,
      status: "released",
      acquiredAt: new Date("2026-01-01T00:00:00Z"),
      releasedAt: new Date("2026-04-01T00:00:00Z"),
    });

    const groups = await getHoldingsByKind();
    const inventory = groups.find((group) => group.kind === "account_login")?.entries[0]?.holdings;
    expect(inventory?.map((holding) => holding.holder)).toEqual(["Meera Sundaram"]);

    // The released row is the point of the history: it is how a clean transfer is
    // told from a genuine gap.
    const history = await getHoldingsForFact(seeded.factId);
    expect(history).toHaveLength(2);
    expect(history.map((holding) => holding.holder)).toContain("Anil Kumar");
  });

  it("orders open questions by ask priority, approval first", async () => {
    await seedRegister();
    await harness.db.insert(questions).values([
      { kind: "verification", status: "asked", askedText: "Is the clinic rate still ₹1,200?" },
      { kind: "approval", status: "queued", askedText: "Should the bank mandate move to Anil?" },
    ]);

    const open = await getOpenQuestions();
    expect(open.map((question) => question.kind)).toEqual(["approval", "verification"]);
    // The rationale is the register's fixed policy for that kind, not a stored column.
    expect(open[0]?.rationale).toContain("never adopted on a timeout");
  });

  it("reads a run's own counts rather than deriving them", async () => {
    await harness.db.insert(runs).values({
      kind: "sweep",
      status: "complete",
      messagesRead: 400,
      factsExtracted: 3,
      candidatesSkipped: 380,
      findingsProduced: 2,
      finishedAt: new Date("2026-09-13T12:34:00Z"),
      trace: [{ node: "assessor", reasoning: "Raised one exposure." }],
    });

    const run = await getLastRun();
    expect(run).toMatchObject({
      messagesConsidered: 400,
      factsRecorded: 3,
      // 380, not 400 − 3. The difference between those figures is a different
      // quantity, and stating it as the pre-filter's count would be a lie.
      candidatesSkipped: 380,
      findingsTouched: 2,
      status: "complete",
    });
    expect(run?.trace).toHaveLength(1);
    expect(await getRuns()).toHaveLength(1);
  });

  it("carries a quiet decision's real scope and the run that recorded it", async () => {
    const [run] = await harness.db
      .insert(runs)
      .values({ kind: "sweep", status: "complete" })
      .returning({ id: runs.id });
    await harness.db.insert(quietDecisions).values({
      scope: "brief_line",
      withheld: "A line about the van keys",
      reason: "The same exposure is already on the register.",
      runId: run?.id ?? null,
    });

    const decisions = await getQuietDecisions();
    expect(decisions[0]).toMatchObject({
      scope: "brief_line",
      runId: run?.id,
      summary: "A line about the van keys",
    });
  });

  it("reads a brief with its lines, each line addressable and its filed state persisted", async () => {
    const seeded = await seedRegister();
    const [brief] = await harness.db
      .insert(briefs)
      .values({
        kind: "departure",
        subjectPersonId: seeded.personId,
        openingLine: "Meera stepped back on 2 September.",
        generatedAt: new Date("2026-09-02T06:00:00Z"),
      })
      .returning({ id: briefs.id });
    if (brief === undefined) throw new Error("seed: brief");

    await harness.db.insert(briefLines).values([
      {
        briefId: brief.id,
        section: "only_they_held",
        position: 0,
        text: "The Instagram account has no second holder.",
        evidenceFactIds: [seeded.factId],
      },
      {
        briefId: brief.id,
        section: "nobody_else_seen",
        position: 0,
        text: "No one else has been seen posting.",
        assignedToPersonId: seeded.personId,
        assignedAt: new Date("2026-09-03T06:00:00Z"),
      },
    ]);

    const [read] = await getBriefs();
    expect(read?.title).toBe(
      `Meera Sundaram stepped back — ${briefDate.format(new Date("2026-09-02T06:00:00Z"))}`,
    );
    expect(read?.trigger).toBe("Meera stepped back on 2 September.");
    expect(read?.read).toBe(false);
    // A private chat id is what makes a direct message possible at all.
    expect(read?.subject).toMatchObject({ name: "Meera Sundaram", canDirectMessage: true });

    const held = read?.sections.only_they_held[0];
    expect(held).toMatchObject({ factId: seeded.factId, filed: false });
    expect(held?.id).toBeTypeOf("string");
    // Already filed last week: it must not offer the button again.
    expect(read?.sections.nobody_else_seen[0]?.filed).toBe(true);
    // The third section has no lines and is still present, so it renders as empty
    // rather than absent.
    expect(read?.sections.they_had_promised).toEqual([]);

    expect((await getUnreadBrief())?.id).toBe(brief.id);
    await mutations.markBriefRead(brief.id);
    expect(await getUnreadBrief()).toBeNull();
  });

  it("shows what changed since the previous visit, and holds the window still within one visit", async () => {
    const seeded = await seedRegister();
    // A visit an hour ago, so this render counts as a new one.
    await harness.db.insert(coordinatorState).values({
      id: 1,
      lastSeenAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await seedFinding(seeded);

    const first = await getSinceYouLastLooked();
    expect(first.some((diff) => diff.kind === "added")).toBe(true);
    expect(first[0]?.factId).toBe(seeded.factId);

    // The second read is the same sitting — a revalidation after a write, or React
    // rendering twice — and must not empty the strip the coordinator is reading.
    const second = await getSinceYouLastLooked();
    expect(second.map((diff) => diff.id)).toEqual(first.map((diff) => diff.id));
  });
});

/** The date the brief title carries, formatted the way the seam formats it. */
const briefDate = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
});

// ── the fact panel's boundary ───────────────────────────────────────────────

describe("the fact panel's read", () => {
  it("redacts the quote on the server and never sends the raw text", async () => {
    const seeded = await seedRegister();

    const detail = await loadFactDetail(seeded.factId);

    expect(detail?.credentialRedacted).toBe(true);
    expect(detail?.sourceText).toContain("[redacted]");
    expect(detail?.sourceText).not.toContain("streetpaws2024");
    // Not merely hidden at render: the field the browser receives is empty.
    expect(detail?.fact.sourceMessage.text).toBe("");
    expect(JSON.stringify(detail)).not.toContain("streetpaws2024");
  });

  it("returns an empty answer for an id that names nothing, rather than throwing", async () => {
    await seedRegister();
    expect(await loadFactDetail("not-a-uuid")).toBeNull();
    expect(await loadFactDetail("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

// ── writes ──────────────────────────────────────────────────────────────────

describe("the write seam", () => {
  it("resolves a finding, and refuses a second press", async () => {
    const seeded = await seedRegister();
    const findingId = await seedFinding(seeded);

    expect(await mutations.resolveFinding(findingId)).toEqual({ ok: true });
    expect(await getRegister()).toEqual([]);

    const [row] = await harness.db
      .select({ status: findings.status, resolvedAt: findings.resolvedAt })
      .from(findings)
      .where(eq(findings.id, findingId));
    expect(row?.status).toBe("resolved");
    expect(row?.resolvedAt).not.toBeNull();

    const second = await mutations.resolveFinding(findingId);
    expect(second.ok).toBe(false);
  });

  it("records a backup as a resolution with its reason kept", async () => {
    const seeded = await seedRegister();
    const findingId = await seedFinding(seeded);

    expect(await mutations.markHasBackup(findingId)).toEqual({ ok: true });

    const [row] = await harness.db
      .select({ status: findings.status, reason: findings.dismissalReason })
      .from(findings)
      .where(eq(findings.id, findingId));
    expect(row).toMatchObject({ status: "resolved", reason: mutations.HAS_BACKUP_REASON });
  });

  it("dismisses a finding into the set-aside list, with its reason", async () => {
    const seeded = await seedRegister();
    const findingId = await seedFinding(seeded);

    expect(await mutations.dismissFinding(findingId)).toEqual({ ok: true });
    expect(await getRegister()).toEqual([]);

    const dismissed = await getDismissedFindings();
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0]).toMatchObject({
      id: findingId,
      status: "dismissed",
      dismissalReason: mutations.DISMISSED_REASON,
    });
  });

  it("withdraws provenance without touching the claim", async () => {
    const seeded = await seedRegister();

    expect(await mutations.withdrawProvenance(seeded.factId)).toEqual({ ok: true });

    const [message] = await harness.db
      .select({ isWithdrawn: messages.isWithdrawn, withdrawnAt: messages.withdrawnAt })
      .from(messages)
      .where(eq(messages.id, seeded.messageId));
    expect(message).toMatchObject({ isWithdrawn: true });
    expect(message?.withdrawnAt).not.toBeNull();

    // The fact, its status and its chain are untouched — deleting it would be the
    // larger lie — and the quote stops travelling as well as stops showing.
    const fact = await getFact(seeded.factId);
    expect(fact).toMatchObject({ status: "active", provenanceWithdrawn: true });
    const detail = await loadFactDetail(seeded.factId);
    expect(detail?.sourceText).toBeNull();
    expect(detail?.credentialRedacted).toBe(false);
  });

  it("retires a claim without replacing it", async () => {
    const seeded = await seedRegister();

    expect(await mutations.retireFact(seeded.factId)).toEqual({ ok: true });
    expect((await getFact(seeded.factId))?.status).toBe("retired");
    // No replacement row: the claim stops being true and nothing takes its place.
    const rows = await harness.db.select({ id: facts.id }).from(facts);
    expect(rows).toHaveLength(1);
    expect((await mutations.retireFact(seeded.factId)).ok).toBe(false);
  });

  it("confirms an unverified claim, and refuses one held for approval", async () => {
    const seeded = await seedRegister();
    await harness.db
      .update(facts)
      .set({ status: "unverified" })
      .where(eq(facts.id, seeded.factId));

    expect(await mutations.markFactVerified(seeded.factId)).toEqual({ ok: true });
    const [row] = await harness.db
      .select({ status: facts.status, verifiedAt: facts.verifiedAt })
      .from(facts)
      .where(eq(facts.id, seeded.factId));
    expect(row?.status).toBe("active");
    expect(row?.verifiedAt).not.toBeNull();

    // An approval belongs to the gate: it is answered in the group chat so the
    // agent can be resumed from its snapshot and the answerer checked.
    await harness.db
      .update(facts)
      .set({ status: "pending_approval" })
      .where(eq(facts.id, seeded.factId));
    const refused = await mutations.markFactVerified(seeded.factId);
    expect(refused.ok).toBe(false);
    expect((await getFact(seeded.factId))?.status).toBe("pending_approval");
  });

  it("corrects a claim by superseding it, keeping what the register used to say", async () => {
    const seeded = await seedRegister();

    expect(
      await mutations.correctFact(seeded.factId, "The Instagram account is held by Meera alone."),
    ).toEqual({ ok: true });

    const rows = await harness.db
      .select({
        id: facts.id,
        claim: facts.claim,
        status: facts.status,
        supersedes: facts.supersedesFactId,
        matchKey: facts.matchKey,
        reasoning: facts.curatorReasoning,
      })
      .from(facts);
    expect(rows).toHaveLength(2);

    const old = rows.find((row) => row.id === seeded.factId);
    const corrected = rows.find((row) => row.id !== seeded.factId);
    expect(old?.status).toBe("superseded");
    expect(old?.claim).toBe("The Instagram account is held by one person.");
    expect(corrected).toMatchObject({
      status: "active",
      supersedes: seeded.factId,
      // Inherited, not rebuilt: the subject and aspect are unchanged, and a new key
      // would put a later restatement in a different group.
      matchKey: old?.matchKey,
    });
    expect(corrected?.reasoning).toContain("Corrected by the coordinator");

    // The panel renders the correction as the history it is.
    const detail = await loadFactDetail(corrected?.id ?? "");
    expect(detail?.chain.map((prior) => prior.id)).toEqual([seeded.factId]);

    // History cannot be corrected again — the row that replaced it can.
    expect((await mutations.correctFact(seeded.factId, "Something else")).ok).toBe(false);
  });

  it("files a brief line against the coordinator, and sends nothing", async () => {
    const seeded = await seedRegister();
    const [brief] = await harness.db
      .insert(briefs)
      .values({
        kind: "departure",
        subjectPersonId: seeded.personId,
        openingLine: "Meera stepped back.",
      })
      .returning({ id: briefs.id });
    const [line] = await harness.db
      .insert(briefLines)
      .values({
        briefId: brief?.id ?? "",
        section: "only_they_held",
        position: 0,
        text: "The Instagram account has no second holder.",
      })
      .returning({ id: briefLines.id });

    expect(await mutations.fileBriefLine(line?.id ?? "")).toEqual({ ok: true });

    const [row] = await harness.db
      .select({
        assignedToPersonId: briefLines.assignedToPersonId,
        assignedAt: briefLines.assignedAt,
      })
      .from(briefLines)
      .where(eq(briefLines.id, line?.id ?? ""));
    expect(row?.assignedToPersonId).toBe(seeded.personId);
    expect(row?.assignedAt).not.toBeNull();

    // Filing is a record, not a notification, and this process has no route to the
    // outbound queue at all — there is nothing here that could have sent one.
    expect((await getBriefs())[0]?.sections.only_they_held[0]?.filed).toBe(true);
  });

  it("says so plainly when there is no coordinator to file against", async () => {
    const seeded = await seedRegister();
    // Reachable for real: if the coordinator is the person who left, it must be
    // reassigned before anything can be filed against them.
    await harness.db.update(appSettings).set({ coordinatorPersonId: null });
    const [brief] = await harness.db
      .insert(briefs)
      .values({ kind: "arrival", subjectPersonId: seeded.personId, openingLine: "Anil arrived." })
      .returning({ id: briefs.id });
    const [line] = await harness.db
      .insert(briefLines)
      .values({
        briefId: brief?.id ?? "",
        section: "nobody_else_seen",
        position: 0,
        text: "Nobody else has been seen doing the vet run.",
      })
      .returning({ id: briefLines.id });

    const result = await mutations.fileBriefLine(line?.id ?? "");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("No coordinator is on record");
  });
});
