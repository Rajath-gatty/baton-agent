/**
 * Membership, the introduction, and what an edit costs the register.
 *
 * Three assertions here cover failures that produce no error at all: a departure that
 * updates nothing (so the brief has no subject), an introduction sent twice (the most
 * visible way to look broken), and an edit that leaves a claim standing on text that no
 * longer says it.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { contentHash, type MembershipEvent, type NormalisedMessage } from "@baton/core";
import {
  INTRODUCTION_TEXT,
  applyMembershipEvent,
  canReceiveMembershipEvents,
  countActiveMembers,
  handleBotMembershipEvent,
} from "../src/pipeline/lifecycle.js";
import { applyEditConsequences } from "../src/pipeline/edits.js";
import {
  getAppSettings,
  seedAppSettings,
  setCoordinatorPerson,
} from "../src/store/app-settings.js";
import { persistMessage } from "../src/store/messages.js";
import { upsertPersonByTelegramId } from "../src/store/people.js";
import { TelegramClient } from "../src/telegram/client.js";
import { IntakeLoop } from "../src/telegram/intake-loop.js";
import { FakeTelegram } from "./helpers/fake-telegram.js";

const { appSettings, facts, people } = schema;
const CHAT_ID = -1001234567890;

function membership(
  transition: "joined" | "left" | "unchanged",
  overrides: Partial<MembershipEvent> = {},
): MembershipEvent {
  return {
    chatId: CHAT_ID,
    at: new Date("2026-06-18T10:00:00Z"),
    telegramUserId: 424242,
    displayName: "Divya Nair",
    transition,
    status: transition === "left" ? "left" : "member",
    ...overrides,
  };
}

function normalised(text: string, telegramMessageId: number): NormalisedMessage {
  return {
    source: "telegram",
    chatId: CHAT_ID,
    telegramMessageId,
    senderTelegramUserId: 588068795,
    senderDisplayName: "Priya Raghavan",
    sentAt: new Date("2026-04-13T09:00:00Z"),
    text,
    contentHash: contentHash(text),
    replyToTelegramMessageId: null,
    isForwarded: false,
    forwardedFrom: null,
    isEdited: false,
    editedAt: null,
    isUnprocessed: false,
    mediaKind: null,
  };
}

describe("membership lifecycle", () => {
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

  it("records a departure and asks for a brief", async () => {
    const outcome = await applyMembershipEvent(harness.db, membership("left"));

    expect(outcome.briefWorthy).toBe(true);
    const rows = await harness.db
      .select({ status: people.status, leftAt: people.leftAt })
      .from(people)
      .where(eq(people.id, outcome.personId));
    expect(rows[0]?.status).toBe("left");
    expect(rows[0]?.leftAt?.toISOString()).toBe("2026-06-18T10:00:00.000Z");
  });

  it("records an arrival and asks for a brief", async () => {
    const outcome = await applyMembershipEvent(
      harness.db,
      membership("joined", { at: new Date("2026-07-06T10:00:00Z") }),
    );

    expect(outcome.briefWorthy).toBe(true);
    const rows = await harness.db
      .select({ status: people.status, joinedAt: people.joinedAt })
      .from(people)
      .where(eq(people.id, outcome.personId));
    expect(rows[0]?.status).toBe("member");
    expect(rows[0]?.joinedAt?.toISOString()).toBe("2026-07-06T10:00:00.000Z");
  });

  it("does not ask for a brief when nobody came or went", async () => {
    // Otherwise being made an administrator would produce a handover document.
    const outcome = await applyMembershipEvent(harness.db, membership("unchanged"));
    expect(outcome.briefWorthy).toBe(false);
  });

  it("reactivates a rejoining volunteer and clears their departure", async () => {
    // Membership reactivating is what lets orphan findings about them close through
    // ordinary dedupe_key re-evaluation rather than a special path.
    await applyMembershipEvent(harness.db, membership("left"));
    const outcome = await applyMembershipEvent(
      harness.db,
      membership("joined", { at: new Date("2026-08-01T10:00:00Z") }),
    );

    const rows = await harness.db
      .select({ status: people.status, leftAt: people.leftAt })
      .from(people)
      .where(eq(people.id, outcome.personId));
    expect(rows[0]?.status).toBe("member");
    expect(rows[0]?.leftAt).toBeNull();
  });

  it("creates the person if the first thing Baton sees of them is their arrival", async () => {
    await applyMembershipEvent(harness.db, membership("joined"));
    const rows = await harness.db.select().from(people);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.telegramUserId).toBe(424242);
  });

  it("counts only current members", async () => {
    await applyMembershipEvent(harness.db, membership("joined", { telegramUserId: 1 }));
    await applyMembershipEvent(harness.db, membership("joined", { telegramUserId: 2 }));
    await applyMembershipEvent(harness.db, membership("left", { telegramUserId: 2 }));

    await expect(countActiveMembers(harness.db)).resolves.toBe(1);
  });

  it("knows which bot statuses can receive membership events at all", () => {
    // A non-admin bot misses every departure, silently.
    expect(canReceiveMembershipEvents("administrator")).toBe(true);
    expect(canReceiveMembershipEvents("creator")).toBe(true);
    expect(canReceiveMembershipEvents("member")).toBe(false);
    expect(canReceiveMembershipEvents("left")).toBe(false);
  });
});

describe("the introduction", () => {
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

  it("is sent once when Baton is added", async () => {
    const outcome = await handleBotMembershipEvent(harness.db, {
      chatId: CHAT_ID,
      at: new Date(),
      status: "administrator",
      isNowMember: true,
    });
    expect(outcome.shouldSend).toBe(true);
    expect(outcome.text).toBe(INTRODUCTION_TEXT);
  });

  it("is never sent twice for the same chat", async () => {
    // Telegram can deliver my_chat_member more than once for one addition, and the bot
    // gets removed and re-added repeatedly during testing.
    const event = {
      chatId: CHAT_ID,
      at: new Date(),
      status: "administrator",
      isNowMember: true,
    } as const;

    const first = await handleBotMembershipEvent(harness.db, event);
    const second = await handleBotMembershipEvent(harness.db, event);
    const third = await handleBotMembershipEvent(harness.db, event);

    expect([first.shouldSend, second.shouldSend, third.shouldSend]).toEqual([true, false, false]);
  });

  it("records the chat it introduced itself to", async () => {
    await handleBotMembershipEvent(harness.db, {
      chatId: CHAT_ID,
      at: new Date(),
      status: "administrator",
      isNowMember: true,
    });
    const settings = await getAppSettings(harness.db);
    expect(settings.introducedChatIds).toEqual([CHAT_ID]);
  });

  it("introduces itself separately in a second chat", async () => {
    const base = { at: new Date(), status: "administrator", isNowMember: true } as const;
    const first = await handleBotMembershipEvent(harness.db, { ...base, chatId: CHAT_ID });
    const other = await handleBotMembershipEvent(harness.db, { ...base, chatId: -100999 });

    expect(first.shouldSend).toBe(true);
    expect(other.shouldSend).toBe(true);
    const settings = await getAppSettings(harness.db);
    expect(settings.introducedChatIds).toEqual([CHAT_ID, -100999]);
  });

  it("says nothing when Baton is removed", async () => {
    const outcome = await handleBotMembershipEvent(harness.db, {
      chatId: CHAT_ID,
      at: new Date(),
      status: "left",
      isNowMember: false,
    });
    expect(outcome.shouldSend).toBe(false);
    const settings = await getAppSettings(harness.db);
    expect(settings.introducedChatIds).toEqual([]);
  });

  it("names what it does not record, not only what it does", () => {
    // The privacy guarantee is enforced by the schema. Saying it out loud is what
    // makes it worth anything to the people in the group.
    expect(INTRODUCTION_TEXT).toMatch(/no attendance register/i);
    expect(INTRODUCTION_TEXT).toMatch(/no score/i);
    expect(INTRODUCTION_TEXT).toMatch(/not what its people do/i);
  });
});

describe("app settings", () => {
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

  it("returns IST rather than UTC before it is seeded", async () => {
    // Relative dates resolve against this. UTC would shift dates by a day at IST and
    // look like a bug in provenance.
    const settings = await getAppSettings(harness.db);
    expect(settings.timezone).toBe("Asia/Kolkata");
  });

  it("seeds from configuration", async () => {
    await seedAppSettings(harness.db, { chatId: CHAT_ID, orgName: "Paws & Claws Collective" });
    const settings = await getAppSettings(harness.db);
    expect(settings.chatId).toBe(CHAT_ID);
    expect(settings.orgName).toBe("Paws & Claws Collective");
  });

  it("does not clobber a value already set on a later start", async () => {
    await seedAppSettings(harness.db, { chatId: CHAT_ID, orgName: "Paws & Claws Collective" });
    await seedAppSettings(harness.db, { chatId: -100999, orgName: "Something Else" });

    const settings = await getAppSettings(harness.db);
    expect(settings.chatId).toBe(CHAT_ID);
    expect(settings.orgName).toBe("Paws & Claws Collective");
  });

  it("keeps one row however many times it is seeded", async () => {
    await seedAppSettings(harness.db, { chatId: CHAT_ID });
    await seedAppSettings(harness.db, { chatId: CHAT_ID });
    await expect(harness.db.select().from(appSettings)).resolves.toHaveLength(1);
  });

  it("assigns the coordinator, who is the only person who may approve", async () => {
    const personId = await upsertPersonByTelegramId(harness.db, {
      telegramUserId: 588068795,
      displayName: "Priya Raghavan",
    });
    await setCoordinatorPerson(harness.db, personId);
    await expect(getAppSettings(harness.db)).resolves.toMatchObject({
      coordinatorPersonId: personId,
    });
  });
});

describe("what an edit costs the register", () => {
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

  /** A claim sourced from `sourceId`, with whatever evidence is given. */
  async function seedFact(sourceId: string, evidence: string[], matchKey: string): Promise<string> {
    const rows = await harness.db
      .insert(facts)
      .values({
        claim: "Sunrise Clinic lets us settle at month end",
        matchKey,
        confidence: 0.9,
        status: "active",
        sourceMessageId: sourceId,
        statedAt: new Date("2026-04-13T09:00:00Z"),
        lastConfirmedAt: new Date("2026-04-13T09:00:00Z"),
        evidenceMessageIds: evidence,
      })
      .returning({ id: facts.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("failed to seed fact");
    return id;
  }

  it("supersedes a claim whose only support was the edited text", async () => {
    const message = await persistMessage(harness.db, normalised("settles at month end", 1));
    const factId = await seedFact(message.id, [message.id], "relationship:clinic#attribute");

    const result = await applyEditConsequences(harness.db, message.id);

    expect(result.factsSuperseded).toBe(1);
    const rows = await harness.db
      .select({ status: facts.status, claim: facts.claim })
      .from(facts)
      .where(eq(facts.id, factId));
    expect(rows[0]?.status).toBe("superseded");
    // Superseded, not mutated: the claim text is untouched, so the record of what
    // Baton once believed survives.
    expect(rows[0]?.claim).toBe("Sunrise Clinic lets us settle at month end");
  });

  it("supersedes a claim with no accumulated evidence at all", async () => {
    const message = await persistMessage(harness.db, normalised("settles at month end", 1));
    await seedFact(message.id, [], "relationship:clinic#attribute");

    const result = await applyEditConsequences(harness.db, message.id);
    expect(result.factsSuperseded).toBe(1);
  });

  it("keeps a claim a later message also supports", async () => {
    // Retiring this would delete something the group has said twice, because its first
    // mention happened to be corrected.
    const first = await persistMessage(harness.db, normalised("settles at month end", 1));
    const restatement = await persistMessage(harness.db, normalised("month end is fine", 2));
    const factId = await seedFact(
      first.id,
      [first.id, restatement.id],
      "relationship:clinic#attribute",
    );

    const result = await applyEditConsequences(harness.db, first.id);

    expect(result.factsSuperseded).toBe(0);
    expect(result.factsRetained).toBe(1);
    const rows = await harness.db
      .select({ status: facts.status })
      .from(facts)
      .where(eq(facts.id, factId));
    expect(rows[0]?.status).toBe("active");
  });

  it("leaves claims from other messages alone", async () => {
    const edited = await persistMessage(harness.db, normalised("settles at month end", 1));
    const other = await persistMessage(harness.db, normalised("Anil has the van keys", 2));
    await seedFact(edited.id, [edited.id], "relationship:clinic#attribute");
    const untouched = await seedFact(other.id, [other.id], "physical_item:van keys#holder");

    await applyEditConsequences(harness.db, edited.id);

    const rows = await harness.db
      .select({ status: facts.status })
      .from(facts)
      .where(eq(facts.id, untouched));
    expect(rows[0]?.status).toBe("active");
  });

  it("does not touch a claim already superseded", async () => {
    const message = await persistMessage(harness.db, normalised("settles at month end", 1));
    const factId = await seedFact(message.id, [message.id], "relationship:clinic#attribute");
    await harness.db.update(facts).set({ status: "retired" }).where(eq(facts.id, factId));

    const result = await applyEditConsequences(harness.db, message.id);

    expect(result.factsSuperseded).toBe(0);
    const rows = await harness.db
      .select({ status: facts.status })
      .from(facts)
      .where(eq(facts.id, factId));
    expect(rows[0]?.status).toBe("retired");
  });

  it("is safe to run for a message that produced nothing", async () => {
    const message = await persistMessage(harness.db, normalised("haha same", 1));
    await expect(applyEditConsequences(harness.db, message.id)).resolves.toEqual({
      factsSuperseded: 0,
      factsRetained: 0,
    });
  });
});

describe("the intake loop driving the real lifecycle handlers", () => {
  /**
   * Each half of this is tested above in isolation. This is the seam: the loop
   * classifies an update, the handler acts on it, and the database ends up right. A
   * handler that is never wired in is the failure this catches, and it is the one that
   * looks like everything works until the demo.
   */
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

  function loopWithHandlers(fake: FakeTelegram, sent: string[]): IntakeLoop {
    return new IntakeLoop({
      db: harness.db,
      telegram: new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl }),
      chatId: CHAT_ID,
      handlers: {
        onMembershipEvent: async (event) => {
          await applyMembershipEvent(harness.db, event);
        },
        onBotMembershipEvent: async (event) => {
          const outcome = await handleBotMembershipEvent(harness.db, event);
          // Stands in for the outbound queue, which Task 9 owns.
          if (outcome.shouldSend) sent.push(outcome.text);
        },
        onEditedMessage: async (messageId) => {
          await applyEditConsequences(harness.db, messageId);
        },
      },
    });
  }

  it("turns a polled departure into a departed volunteer", async () => {
    const fake = new FakeTelegram();
    fake.queue("getMe", { id: 8871830879, is_bot: true, first_name: "Baton" });
    fake.queueUpdates([
      {
        update_id: 501,
        chat_member: {
          chat: { id: CHAT_ID },
          from: { id: 1, first_name: "Priya" },
          date: 1_781_000_000,
          old_chat_member: {
            user: { id: 424242, first_name: "Divya", last_name: "Nair" },
            status: "member",
          },
          new_chat_member: {
            user: { id: 424242, first_name: "Divya", last_name: "Nair" },
            status: "left",
          },
        },
      },
    ]);

    const loop = loopWithHandlers(fake, []);
    await loop.start();
    await loop.runOnce();

    const rows = await harness.db
      .select({ status: people.status, leftAt: people.leftAt })
      .from(people)
      .where(eq(people.telegramUserId, 424242));
    expect(rows[0]?.status).toBe("left");
    expect(rows[0]?.leftAt).not.toBeNull();
  });

  it("introduces itself once across two polls", async () => {
    const fake = new FakeTelegram();
    fake.queue("getMe", { id: 8871830879, is_bot: true, first_name: "Baton" });
    const addition = {
      update_id: 601,
      my_chat_member: {
        chat: { id: CHAT_ID },
        from: { id: 1, first_name: "Priya" },
        date: 1_781_000_000,
        old_chat_member: { user: { id: 8871830879, first_name: "Baton" }, status: "left" },
        new_chat_member: { user: { id: 8871830879, first_name: "Baton" }, status: "administrator" },
      },
    };
    fake.queueUpdates([addition]);
    fake.queueUpdates([{ ...addition, update_id: 602 }]);

    const sent: string[] = [];
    const loop = loopWithHandlers(fake, sent);
    await loop.start();
    await loop.runOnce();
    await loop.runOnce();

    expect(sent).toHaveLength(1);
  });

  it("re-curates an edited message and drops what the old text claimed", async () => {
    const fake = new FakeTelegram();
    fake.queue("getMe", { id: 8871830879, is_bot: true, first_name: "Baton" });

    // The original arrives and is stored.
    fake.queueUpdates([
      {
        update_id: 701,
        message: {
          message_id: 7000,
          from: { id: 588068795, first_name: "Priya" },
          date: 1_776_000_000,
          chat: { id: CHAT_ID, type: "supergroup" },
          text: "Sunrise Clinic lets us settle at month end",
        },
      },
    ]);
    const loop = loopWithHandlers(fake, []);
    await loop.start();
    await loop.runOnce();

    // Curation happens later in the real pipeline; stand in for its output so the
    // edit has something to invalidate.
    const stored = await harness.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.telegramMessageId, 7000));
    const messageId = stored[0]?.id;
    expect(messageId).toBeDefined();
    await harness.db.insert(facts).values({
      claim: "Sunrise Clinic lets us settle at month end",
      matchKey: "relationship:sunrise clinic#attribute",
      confidence: 0.9,
      status: "active",
      sourceMessageId: messageId as string,
      statedAt: new Date("2026-04-13T09:00:00Z"),
      lastConfirmedAt: new Date("2026-04-13T09:00:00Z"),
      evidenceMessageIds: [messageId as string],
    });
    await harness.db
      .update(schema.messages)
      .set({ curatedAt: new Date("2026-04-14T00:00:00Z") })
      .where(eq(schema.messages.id, messageId as string));

    // Now the edit.
    fake.queueUpdates([
      {
        update_id: 702,
        edited_message: {
          message_id: 7000,
          from: { id: 588068795, first_name: "Priya" },
          date: 1_776_000_000,
          edit_date: 1_776_600_000,
          chat: { id: CHAT_ID, type: "supergroup" },
          text: "Sunrise Clinic wants payment within 7 days now",
        },
      },
    ]);
    const result = await loop.runOnce();

    expect(result.editsStored).toBe(1);

    // The claim from the vanished text is superseded, not rewritten.
    const factRows = await harness.db
      .select({ status: facts.status, claim: facts.claim })
      .from(facts);
    expect(factRows[0]?.status).toBe("superseded");
    expect(factRows[0]?.claim).toBe("Sunrise Clinic lets us settle at month end");

    // And the message is queued for re-curation, because its content hash changed.
    const messageRows = await harness.db
      .select({ curatedAt: schema.messages.curatedAt, text: schema.messages.text })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId as string));
    expect(messageRows[0]?.curatedAt).toBeNull();
    expect(messageRows[0]?.text).toBe("Sunrise Clinic wants payment within 7 days now");
  });
});
