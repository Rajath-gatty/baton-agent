/**
 * Briefs from lifecycle events — against real Postgres and a fake agent.
 *
 * The claim being tested is the product's central one: **the brief fires from a Telegram
 * membership event, not from a button.** Nobody presses "generate handover notes" on the day
 * a volunteer leaves, which is exactly the day the knowledge walks out. So the last block
 * here drives a real `IntakeLoop` with a real `chat_member` update and asserts a brief exists
 * afterwards — the seam being connected is the whole feature, and it is the failure that
 * looks fine until the demo.
 *
 * Three other assertions carry weight:
 *
 *   - **The empty brief is generated and stored**, not skipped. Silence and three empty
 *     sections both read as broken software.
 *   - **One brief per transition, not per event.** Telegram can deliver the same update twice.
 *   - **An undeliverable brief is still a stored brief.** For most of a twenty-person roster
 *     the subject cannot be messaged at all, and a departing member least of all.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { contentHash, type BriefPayload, type NormalisedMessage } from "@baton/core";
import { persistMessage } from "../src/store/messages.js";
import {
  assignBriefLine,
  countUnreadBriefs,
  findBrief,
  markBriefRead,
  selectBriefs,
} from "../src/store/briefs.js";
import { countQuietDecisions } from "../src/store/quiet-decisions.js";
import { findRun } from "../src/store/runs.js";
import { hydrateBriefContext } from "../src/pipeline/hydrate.js";
import { briefOnMembership, renderBrief, runBriefPass } from "../src/pipeline/brief.js";
import { applyMembershipEvent } from "../src/pipeline/lifecycle.js";
import { IntakeLoop } from "../src/telegram/intake-loop.js";
import { OutboundQueue } from "../src/telegram/outbound-queue.js";
import { TelegramClient } from "../src/telegram/client.js";
import { FakeTelegram } from "./helpers/fake-telegram.js";
import { FakeBriefer, brief, briefLine, type BriefResponder } from "./helpers/fake-agent.js";

const {
  appSettings,
  assets,
  briefs,
  capabilities,
  capabilityCoverage,
  commitments,
  facts,
  holdings,
  people,
} = schema;

const CHAT_ID = -1001234567890;
const BOT_ID = 8871830879;
const NOW = new Date("2026-06-01T10:00:00Z");
const LEFT_AT = new Date("2026-05-30T10:00:00Z");

describe("briefs", () => {
  let harness: TestDatabase;
  let coordinator: string;
  let meera: string;
  let anil: string;
  let nextTelegramId = 1;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    nextTelegramId = 1;

    const inserted = await harness.db
      .insert(people)
      .values([
        {
          displayName: "Priya Raghavan",
          status: "member",
          telegramUserId: 5001,
          privateChatId: 5001,
        },
        {
          displayName: "Meera Sundaram",
          status: "left",
          telegramUserId: 5002,
          privateChatId: 5002,
          joinedAt: new Date("2026-01-01T10:00:00Z"),
          leftAt: LEFT_AT,
        },
        { displayName: "Anil Kumar", status: "member" },
      ])
      .returning({ id: people.id, displayName: people.displayName });
    coordinator = inserted.find((row) => row.displayName === "Priya Raghavan")?.id ?? "";
    meera = inserted.find((row) => row.displayName === "Meera Sundaram")?.id ?? "";
    anil = inserted.find((row) => row.displayName === "Anil Kumar")?.id ?? "";

    await harness.db.insert(appSettings).values({
      id: 1,
      chatId: CHAT_ID,
      orgName: "Kolam Collective",
      timezone: "Asia/Kolkata",
      coordinatorPersonId: coordinator,
    });
  });

  // ── fixtures ───────────────────────────────────────────────────────────────

  async function message(text: string): Promise<string> {
    const telegramMessageId = nextTelegramId++;
    const normalised: NormalisedMessage = {
      source: "telegram",
      chatId: CHAT_ID,
      telegramMessageId,
      senderTelegramUserId: 5001,
      senderDisplayName: "Priya Raghavan",
      sentAt: new Date("2026-05-01T10:00:00Z"),
      text,
      contentHash: contentHash(`${text}#${telegramMessageId}`),
      replyToTelegramMessageId: null,
      isForwarded: false,
      forwardedFrom: null,
      isEdited: false,
      editedAt: null,
      isUnprocessed: false,
      mediaKind: null,
    };
    return (await persistMessage(harness.db, normalised)).id;
  }

  /** An asset held by one person, with an active claim behind it. */
  async function heldAsset(name: string, holderPersonId: string | null): Promise<string> {
    const assetRows = await harness.db
      .insert(assets)
      .values({ kind: "physical_item", name, normalisedKey: name.toLowerCase() })
      .returning({ id: assets.id });
    const assetId = assetRows[0]?.id as string;
    const sourceMessageId = await message(`${name} is with someone`);

    const factRows = await harness.db
      .insert(facts)
      .values({
        assetId,
        claim: `${name} is held`,
        matchKey: `k:${name}`,
        confidence: 0.9,
        status: "active",
        sourceMessageId,
        statedAt: new Date("2026-05-01T10:00:00Z"),
        lastConfirmedAt: new Date("2026-05-01T10:00:00Z"),
        evidenceMessageIds: [sourceMessageId],
      })
      .returning({ id: facts.id });

    await harness.db.insert(holdings).values({
      assetId,
      holderPersonId,
      status: "active",
      acquiredAt: new Date("2026-05-01T10:00:00Z"),
      evidenceFactId: factRows[0]?.id as string,
    });
    return assetId;
  }

  async function observedCapability(name: string, personIds: string[]): Promise<string> {
    const rows = await harness.db
      .insert(capabilities)
      .values({ name, normalisedKey: name.toLowerCase() })
      .returning({ id: capabilities.id });
    const capabilityId = rows[0]?.id as string;
    const messageId = await message(`thanks for ${name}`);

    for (const personId of personIds) {
      await harness.db.insert(capabilityCoverage).values({
        capabilityId,
        personId,
        firstObservedAt: new Date("2026-05-01T10:00:00Z"),
        lastObservedAt: new Date("2026-05-01T10:00:00Z"),
        evidenceMessageIds: [messageId],
      });
    }
    return capabilityId;
  }

  async function openCommitment(substance: string, ownerPersonId: string | null): Promise<string> {
    const sourceMessageId = await message(substance);
    const rows = await harness.db
      .insert(commitments)
      .values({
        substance,
        ownerPersonId,
        promisedAt: new Date("2026-05-01T10:00:00Z"),
        deadline: new Date("2026-05-20T00:00:00Z"),
        sourceMessageId,
        status: "open",
      })
      .returning({ id: commitments.id });
    return rows[0]?.id as string;
  }

  function harnessFor(responder: BriefResponder, at: Date = NOW) {
    const telegram = new FakeTelegram();
    const queue = new OutboundQueue({
      telegram: new TelegramClient({ token: "t", fetchImpl: telegram.fetchImpl }),
      sleep: () => Promise.resolve(),
      now: () => at.getTime(),
    });
    const transport = new FakeBriefer(responder);
    return {
      telegram,
      queue,
      transport,
      deps: { db: harness.db, transport, queue, now: () => at },
    };
  }

  /** Lines for whatever the context actually contained, so the fake tracks the fixture. */
  const fromContext: BriefResponder = (payload, context) =>
    brief(payload, [
      ...context.holdings.map((entry) =>
        briefLine({
          section: "only_they_held",
          text: entry.assetName,
          subjectAssetId: entry.assetId,
          evidenceFactIds: entry.evidenceFactIds,
          evidenceMessageIds: entry.evidenceMessageIds,
        }),
      ),
      ...context.openCommitments.map((entry) =>
        briefLine({
          section: "they_had_promised",
          text: entry.substance,
          subjectCommitmentId: entry.commitmentId,
        }),
      ),
      ...context.coverage.map((entry) =>
        briefLine({
          section: "nobody_else_seen",
          text: entry.capabilityName,
          subjectCapabilityId: entry.capabilityId,
        }),
      ),
    ]);

  // ─────────────────────────────────────────────────────────────────────────
  describe("the departure brief", () => {
    it("stores the brief and its lines, in section order", async () => {
      await heldAsset("store room key", meera);
      await openCommitment("book the hall", meera);
      await observedCapability("running the stall", [meera]);

      const { deps } = harnessFor(fromContext);
      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      expect(result.isEmpty).toBe(false);
      expect(result.lineCount).toBe(3);

      const stored = await findBrief(harness.db, result.briefId as string);
      expect(stored?.kind).toBe("departure");
      expect(stored?.subjectPersonId).toBe(meera);
      // The three sections are ordered, and the order is part of the contract.
      expect(stored?.lines.map((line) => line.section)).toEqual([
        "only_they_held",
        "they_had_promised",
        "nobody_else_seen",
      ]);
      // Lines are rows, each with its own evidence — which is what makes them assignable and
      // clickable through to the message they came from.
      expect(stored?.lines[0]?.evidenceMessageIds).toHaveLength(1);
    });

    it("numbers positions per section rather than across the whole list", async () => {
      const { deps } = harnessFor((payload) =>
        brief(payload, [
          briefLine({ section: "only_they_held", text: "the key" }),
          briefLine({ section: "nobody_else_seen", text: "the stall" }),
          briefLine({ section: "only_they_held", text: "the tin" }),
        ]),
      );
      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      const stored = await findBrief(harness.db, result.briefId as string);
      // A global index would collide with the unique (brief, section, position) index the
      // moment two sections interleaved.
      expect(stored?.lines.map((line) => [line.section, line.position])).toEqual([
        ["only_they_held", 0],
        ["only_they_held", 1],
        ["nobody_else_seen", 0],
      ]);
    });

    it("renders the brief as something a person can read", async () => {
      const payload: BriefPayload = {
        kind: "departure",
        subjectPersonId: meera,
        subjectDisplayName: "Meera Sundaram",
      };
      const text = renderBrief(
        brief(payload, [
          briefLine({ section: "only_they_held", text: "the store room key" }),
          briefLine({ section: "nobody_else_seen", text: "running the stall" }),
        ]),
      );

      expect(text).toContain("Only they held:");
      expect(text).toContain("• the store room key");
      expect(text).toContain("Nobody else has been seen doing:");
      // The section with no lines gets no heading, which is what keeps the sparse case from
      // reading as broken.
      expect(text).not.toContain("They had promised:");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("the empty brief", () => {
    it("is generated and stored rather than skipped", async () => {
      const { deps } = harnessFor(fromContext);
      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      expect(result.isEmpty).toBe(true);
      expect(result.lineCount).toBe(0);
      expect(result.briefId).not.toBeNull();

      const stored = await findBrief(harness.db, result.briefId as string);
      // One plain sentence. Three empty sections, or silence, both read as broken software —
      // and a coordinator who sees that once stops opening briefs.
      expect(stored?.isEmpty).toBe(true);
      expect(stored?.openingLine).toBe("Nothing appears to have left with them.");
      expect(stored?.lines).toHaveLength(0);
    });

    it("renders as the opening line alone", () => {
      const payload: BriefPayload = {
        kind: "departure",
        subjectPersonId: meera,
        subjectDisplayName: "Meera Sundaram",
      };
      expect(renderBrief(brief(payload, []))).toBe("Nothing appears to have left with them.");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("one brief per transition", () => {
    it("does not generate a second brief for the same departure", async () => {
      await heldAsset("store room key", meera);

      const first = harnessFor(fromContext);
      const one = await runBriefPass(first.deps, { kind: "departure", subjectPersonId: meera });

      const second = harnessFor(fromContext);
      const two = await runBriefPass(second.deps, { kind: "departure", subjectPersonId: meera });

      expect(two.duplicate).toBe(true);
      expect(two.briefId).toBe(one.briefId);
      // Never asked. A second handover document makes a coordinator wonder which is current.
      expect(second.transport.requests).toHaveLength(0);
      expect(await selectBriefs(harness.db)).toHaveLength(1);
    });

    it("generates a second brief for a later departure by the same person", async () => {
      const { deps } = harnessFor(fromContext);
      await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      // They rejoined and left again, a day after the first brief was written.
      const secondDeparture = new Date("2026-06-02T09:00:00Z");
      await harness.db.update(people).set({ leftAt: secondDeparture }).where(eq(people.id, meera));

      // The guard asks "has a brief been generated since this transition?", so the second
      // pass has to run after the second departure — which is what actually happens.
      const again = harnessFor(fromContext, new Date("2026-06-02T10:00:00Z"));
      const result = await runBriefPass(again.deps, { kind: "departure", subjectPersonId: meera });

      expect(result.duplicate).toBe(false);
      expect(await selectBriefs(harness.db)).toHaveLength(2);
    });

    it("does not confuse an arrival brief with a departure brief", async () => {
      const { deps } = harnessFor(fromContext);
      await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      const arrival = harnessFor(fromContext);
      const result = await runBriefPass(arrival.deps, { kind: "arrival", subjectPersonId: meera });

      expect(result.duplicate).toBe(false);
      expect(arrival.transport.requests[0]?.payload.kind).toBe("arrival");
    });

    it("can be forced past the guard", async () => {
      const { deps } = harnessFor(fromContext);
      await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      const forced = harnessFor(fromContext);
      const result = await runBriefPass(forced.deps, {
        kind: "departure",
        subjectPersonId: meera,
        force: true,
      });

      expect(result.duplicate).toBe(false);
      expect(forced.transport.requests).toHaveLength(1);
    });

    it("still briefs a person with no recorded transition date", async () => {
      const { deps, transport } = harnessFor(fromContext);
      // Anil has no joined_at or left_at. Refusing to brief because a timestamp is missing
      // would lose the handover for the one case the product exists to serve.
      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: anil });

      expect(result.duplicate).toBe(false);
      expect(transport.requests).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("delivery", () => {
    it("sends to the coordinator and to the subject", async () => {
      await heldAsset("store room key", meera);
      const { telegram, deps } = harnessFor(fromContext);
      telegram.queue("sendMessage", { message_id: 1, chat: { id: 5001 } });
      telegram.queue("sendMessage", { message_id: 2, chat: { id: 5002 } });

      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      expect(result.toCoordinator).toBe("sent");
      expect(result.toSubject).toBe("sent");
      const recipients = telegram.callsTo("sendMessage").map((call) => call.payload.chat_id);
      expect(recipients).toEqual([5001, 5002]);
    });

    it("stores the brief even when nobody can be reached", async () => {
      await heldAsset("store room key", anil);
      // Anil has no private chat, and neither does a coordinator we remove.
      await harness.db.update(appSettings).set({ coordinatorPersonId: null });

      const { telegram, deps } = harnessFor(fromContext);
      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: anil });

      expect(telegram.callsTo("sendMessage")).toHaveLength(0);
      expect(result.toCoordinator).toBe("undeliverable");
      expect(result.toSubject).toBe("undeliverable");
      // The document is the valuable part; delivery is a convenience on top of a record the UI
      // can always render.
      expect(result.briefId).not.toBeNull();
      expect(result.text).toContain("store room key");
      expect(await selectBriefs(harness.db)).toHaveLength(1);
    });

    it("reaches the coordinator even when the departing member cannot be messaged", async () => {
      await heldAsset("store room key", anil);
      const { telegram, deps } = harnessFor(fromContext);
      telegram.queue("sendMessage", { message_id: 1, chat: { id: 5001 } });

      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: anil });

      // The common case for a twenty-person roster, and for a departing member most of all.
      expect(result.toCoordinator).toBe("sent");
      expect(result.toSubject).toBe("undeliverable");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("Restraint on the brief path", () => {
    it("records a withheld line under the brief_line scope", async () => {
      await heldAsset("store room key", meera);
      const { deps } = harnessFor((payload, context) =>
        brief(
          payload,
          [briefLine({ section: "only_they_held", text: context.holdings[0]?.assetName ?? "" })],
          {
            quietDecisions: [
              {
                scope: "brief_line",
                withheld: "A line about the petty cash tin",
                reason: "Too thin to state as fact.",
                findingDedupeKey: null,
              },
            ],
          },
        ),
      );

      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      expect(result.quietDecisions).toBe(1);
      // Stored under its own scope, which is how a test proves the veto has not silently
      // narrowed to findings — leaving ungated the two surfaces a human reads aloud.
      expect(await countQuietDecisions(harness.db, "brief_line")).toBe(1);
      expect(await countQuietDecisions(harness.db, "finding")).toBe(0);
      expect(await countQuietDecisions(harness.db, "answer")).toBe(0);
    });

    it("stores a brief whose every line was withheld as an empty one", async () => {
      await heldAsset("store room key", meera);
      const { deps } = harnessFor((payload) =>
        brief(payload, [], {
          quietDecisions: [
            {
              scope: "brief_line",
              withheld: "A line about the store room key",
              reason: "The group already arranged this.",
              findingDedupeKey: null,
            },
          ],
        }),
      );

      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      // Everything vetoed still produces a readable brief rather than nothing at all.
      expect(result.isEmpty).toBe(true);
      expect(result.briefId).not.toBeNull();
      expect(await countQuietDecisions(harness.db, "brief_line")).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("the brief context", () => {
    it("scopes a departure to the subject", async () => {
      await heldAsset("store room key", meera);
      await heldAsset("the projector", anil);
      await openCommitment("book the hall", meera);
      await openCommitment("sort the printers", anil);
      await observedCapability("running the stall", [meera]);
      await observedCapability("doing the sound", [anil]);

      const context = await hydrateBriefContext(harness.db, NOW, {
        kind: "departure",
        subjectPersonId: meera,
      });

      expect(Object.keys(context).sort()).toEqual([
        "coverage",
        "holdings",
        "openCommitments",
        "org",
      ]);
      // Not the whole register: sending that would multiply cost by its size and invite a
      // document about the organisation rather than about the handover.
      expect(context.holdings.map((entry) => entry.assetName)).toEqual(["store room key"]);
      expect(context.openCommitments.map((entry) => entry.substance)).toEqual(["book the hall"]);
      expect(context.coverage.map((entry) => entry.capabilityName)).toEqual(["running the stall"]);
    });

    it("counts other holders so a shared thing is not a handover item", async () => {
      const assetId = await heldAsset("the projector", meera);
      const factRows = await harness.db.select({ id: facts.id }).from(facts);
      await harness.db.insert(holdings).values({
        assetId,
        holderPersonId: anil,
        status: "active",
        acquiredAt: new Date("2026-05-02T10:00:00Z"),
        evidenceFactId: factRows[0]?.id as string,
      });

      const context = await hydrateBriefContext(harness.db, NOW, {
        kind: "departure",
        subjectPersonId: meera,
      });

      // One other holder means the group has not lost access, so this does not belong in
      // "only they held".
      expect(context.holdings[0]?.otherActiveHolders).toBe(1);
    });

    it("keeps a pending claim out of a brief", async () => {
      await heldAsset("the bank login", meera);
      await harness.db.update(facts).set({ status: "pending_approval" });

      const context = await hydrateBriefContext(harness.db, NOW, {
        kind: "departure",
        subjectPersonId: meera,
      });

      // The F33 promise again, on a third route: a handover document is as much a surface a
      // human reads aloud as a finding is.
      expect(context.holdings).toHaveLength(0);
    });

    it("scopes an arrival to the register's gaps instead of to the subject", async () => {
      // Held by exactly one person: a gap a new volunteer could fill.
      await heldAsset("store room key", meera);
      // Held by two: not a gap.
      const shared = await heldAsset("the projector", meera);
      const factRows = await harness.db
        .select({ id: facts.id, assetId: facts.assetId })
        .from(facts);
      await harness.db.insert(holdings).values({
        assetId: shared,
        holderPersonId: anil,
        status: "active",
        acquiredAt: NOW,
        evidenceFactId: factRows.find((row) => row.assetId === shared)?.id as string,
      });

      await openCommitment("book the hall", meera);
      await openCommitment("sort the printers", null);
      await observedCapability("running the stall", [meera]);
      await observedCapability("doing the sound", [meera, anil]);

      const context = await hydrateBriefContext(harness.db, NOW, {
        kind: "arrival",
        subjectPersonId: anil,
      });

      // An arriving volunteer holds nothing, so the same three sections are scoped to what
      // currently has no owner or a single holder.
      expect(context.holdings.map((entry) => entry.assetName)).toEqual(["store room key"]);
      // The arrival analogue of an unowned asset: the loose end nobody's name is on.
      expect(context.openCommitments.map((entry) => entry.substance)).toEqual([
        "sort the printers",
      ]);
      expect(context.coverage.map((entry) => entry.capabilityName)).toEqual(["running the stall"]);
    });

    it("is what the pass actually sends", async () => {
      await heldAsset("store room key", meera);
      const { transport, deps } = harnessFor(fromContext);
      await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      expect(transport.requests[0]?.payload).toEqual({
        kind: "departure",
        subjectPersonId: meera,
        subjectDisplayName: "Meera Sundaram",
      });
      expect(transport.requests[0]?.context.org.orgName).toBe("Kolam Collective");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("runs and failure", () => {
    it("records a completed run with the trace", async () => {
      const { deps } = harnessFor(fromContext);
      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      const run = await findRun(harness.db, result.runId as string);
      expect(run?.kind).toBe("brief");
      expect(run?.status).toBe("complete");
      expect(run?.trace.map((entry) => entry.node)).toEqual(["briefer"]);
    });

    it("records a failed run and writes no brief", async () => {
      const failing = new FakeBriefer(() => {
        throw new Error("the model refused");
      });
      const telegram = new FakeTelegram();
      const queue = new OutboundQueue({
        telegram: new TelegramClient({ token: "t", fetchImpl: telegram.fetchImpl }),
        sleep: () => Promise.resolve(),
        now: () => NOW.getTime(),
      });

      await expect(
        runBriefPass(
          { db: harness.db, transport: failing, queue, now: () => NOW },
          { kind: "departure", subjectPersonId: meera },
        ),
      ).rejects.toThrow(/the model refused/);

      const runs = await harness.db.select({ id: schema.runs.id }).from(schema.runs);
      const run = await findRun(harness.db, runs[0]?.id as string);
      expect(run?.status).toBe("failed");
      expect(await selectBriefs(harness.db)).toHaveLength(0);
    });

    it("refuses to brief a person who does not exist", async () => {
      const { deps } = harnessFor(fromContext);
      await expect(
        runBriefPass(deps, {
          kind: "departure",
          subjectPersonId: "00000000-0000-0000-0000-000000000000",
        }),
      ).rejects.toThrow(/unknown person/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("reading and assigning", () => {
    it("clears the unread banner once, and only once", async () => {
      const { deps } = harnessFor(fromContext);
      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      expect(await countUnreadBriefs(harness.db)).toBe(1);
      expect(await markBriefRead(harness.db, result.briefId as string, NOW)).toBe(true);
      expect(await markBriefRead(harness.db, result.briefId as string, NOW)).toBe(false);
      expect(await countUnreadBriefs(harness.db)).toBe(0);
    });

    it("assigns a line without sending anything", async () => {
      await heldAsset("store room key", meera);
      const { telegram, deps } = harnessFor(fromContext);
      telegram.queue("sendMessage", { message_id: 1, chat: { id: 5001 } });
      telegram.queue("sendMessage", { message_id: 2, chat: { id: 5002 } });
      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });

      const stored = await findBrief(harness.db, result.briefId as string);
      const lineId = stored?.lines[0]?.id as string;
      const before = telegram.callsTo("sendMessage").length;

      expect(await assignBriefLine(harness.db, lineId, anil, NOW)).toBe(true);

      // A record, not a notification. Baton does not chase people, and messaging the assignee
      // would turn a handover checklist into a task manager that nags.
      expect(telegram.callsTo("sendMessage")).toHaveLength(before);
      const after = await findBrief(harness.db, result.briefId as string);
      expect(after?.lines[0]?.assignedToPersonId).toBe(anil);
      expect(after?.lines[0]?.assignedAt).not.toBeNull();
    });

    it("clears an assignment and its timestamp together", async () => {
      await heldAsset("store room key", meera);
      const { deps } = harnessFor(fromContext);
      const result = await runBriefPass(deps, { kind: "departure", subjectPersonId: meera });
      const stored = await findBrief(harness.db, result.briefId as string);
      const lineId = stored?.lines[0]?.id as string;

      await assignBriefLine(harness.db, lineId, anil, NOW);
      await assignBriefLine(harness.db, lineId, null, NOW);

      const after = await findBrief(harness.db, result.briefId as string);
      expect(after?.lines[0]?.assignedToPersonId).toBeNull();
      // Left set, it would render as "unassigned, since Tuesday".
      expect(after?.lines[0]?.assignedAt).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("firing from a Telegram membership event", () => {
    it("produces a departure brief from a chat_member update, with no button pressed", async () => {
      await heldAsset("store room key", meera);

      const telegram = new FakeTelegram();
      telegram.queue("getMe", {
        id: BOT_ID,
        is_bot: true,
        first_name: "Baton",
        username: "batonbot",
      });
      const queue = new OutboundQueue({
        telegram: new TelegramClient({ token: "t", fetchImpl: telegram.fetchImpl }),
        sleep: () => Promise.resolve(),
        now: () => NOW.getTime(),
      });
      const transport = new FakeBriefer(fromContext);
      const onMembership = briefOnMembership({
        db: harness.db,
        transport,
        queue,
        now: () => NOW,
      });

      const loop = new IntakeLoop({
        db: harness.db,
        telegram: new TelegramClient({ token: "t", fetchImpl: telegram.fetchImpl }),
        chatId: CHAT_ID,
        handlers: {
          onMembershipEvent: async (event) => {
            const outcome = await applyMembershipEvent(harness.db, event);
            await onMembership(outcome);
          },
        },
      });

      telegram.queue("getUpdates", [
        {
          update_id: 101,
          chat_member: {
            chat: { id: CHAT_ID },
            from: { id: 5001, first_name: "Priya" },
            date: Math.floor(NOW.getTime() / 1000),
            old_chat_member: { user: { id: 5002, first_name: "Meera" }, status: "member" },
            new_chat_member: { user: { id: 5002, first_name: "Meera" }, status: "left" },
          },
        },
      ]);

      await loop.start();
      const cycle = await loop.runOnce();

      expect(cycle.membershipEvents).toBe(1);
      // The product's central claim: nobody presses "generate handover notes" on the day a
      // volunteer leaves, which is exactly the day the knowledge walks out.
      const stored = await harness.db
        .select({ kind: briefs.kind, subjectPersonId: briefs.subjectPersonId })
        .from(briefs);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.kind).toBe("departure");
      expect(transport.requests).toHaveLength(1);
    });

    it("produces no brief for a promotion", async () => {
      const transport = new FakeBriefer(fromContext);
      const telegram = new FakeTelegram();
      const queue = new OutboundQueue({
        telegram: new TelegramClient({ token: "t", fetchImpl: telegram.fetchImpl }),
        sleep: () => Promise.resolve(),
        now: () => NOW.getTime(),
      });
      const onMembership = briefOnMembership({
        db: harness.db,
        transport,
        queue,
        now: () => NOW,
      });

      // A member becoming an administrator is still a member. A promotion is not a handover.
      const result = await onMembership({
        personId: meera,
        briefWorthy: false,
        transition: "unchanged",
      });

      expect(result).toBeNull();
      expect(transport.requests).toHaveLength(0);
      expect(await selectBriefs(harness.db)).toHaveLength(0);
    });

    it("produces an arrival brief when someone joins", async () => {
      await heldAsset("store room key", meera);
      const transport = new FakeBriefer(fromContext);
      const telegram = new FakeTelegram();
      const queue = new OutboundQueue({
        telegram: new TelegramClient({ token: "t", fetchImpl: telegram.fetchImpl }),
        sleep: () => Promise.resolve(),
        now: () => NOW.getTime(),
      });
      const onMembership = briefOnMembership({
        db: harness.db,
        transport,
        queue,
        now: () => NOW,
      });

      const result = await onMembership({
        personId: anil,
        briefWorthy: true,
        transition: "joined",
      });

      expect(result?.briefId).not.toBeNull();
      expect(transport.requests[0]?.payload.kind).toBe("arrival");
      // Same generator, same three sections, scoped to the gaps.
      expect(transport.requests[0]?.context.holdings.map((entry) => entry.assetName)).toEqual([
        "store room key",
      ]);
    });
  });
});
