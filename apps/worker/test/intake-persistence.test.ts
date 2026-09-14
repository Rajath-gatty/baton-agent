/**
 * Intake persistence, against real Postgres.
 *
 * The behaviours asserted here are the ones whose failure is invisible: a duplicate
 * row after a restart, a lost reply pointer, a resurrected departed volunteer, and
 * re-curating the whole transcript on every crash.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { contentHash, type NormalisedMessage } from "@baton/core";
import {
  findMessageIdByTelegramId,
  persistMessage,
  persistMessages,
} from "../src/store/messages.js";
import { upsertPersonByTelegramId } from "../src/store/people.js";

const { messages, people } = schema;
const CHAT_ID = -1001234567890;

function normalised(overrides: Partial<NormalisedMessage> = {}): NormalisedMessage {
  const text = overrides.text ?? "Sunrise Clinic lets us settle at month end";
  return {
    source: "telegram",
    chatId: CHAT_ID,
    telegramMessageId: 4021,
    senderTelegramUserId: 588068795,
    senderDisplayName: "Priya Raghavan",
    sentAt: new Date("2026-04-12T13:20:00Z"),
    text,
    replyToTelegramMessageId: null,
    isForwarded: false,
    forwardedFrom: null,
    isEdited: false,
    editedAt: null,
    isUnprocessed: false,
    mediaKind: null,
    ...overrides,
    // Derived last, and from whatever text the override supplied, so no test can
    // assert against a hash that does not match its own text — which would make the
    // content-driven curation reset look broken when it is not.
    contentHash: overrides.contentHash ?? contentHash(text),
  };
}

describe("intake persistence", () => {
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

  describe("upsert on (chat_id, telegram_message_id)", () => {
    it("stores a message and returns its local id", async () => {
      const result = await persistMessage(harness.db, normalised());
      expect(result.isNew).toBe(true);
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);

      const rows = await harness.db.select().from(messages);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.text).toBe("Sunrise Clinic lets us settle at month end");
      expect(rows[0]?.source).toBe("telegram");
    });

    it("reprocessing the same update produces one row, not two", async () => {
      // The polling offset is committed after processing, so this is the expected
      // path after a crash rather than an exceptional one.
      const first = await persistMessage(harness.db, normalised());
      const second = await persistMessage(harness.db, normalised());

      expect(second.id).toBe(first.id);
      expect(first.isNew).toBe(true);
      expect(second.isNew).toBe(false);
      await expect(harness.db.select().from(messages)).resolves.toHaveLength(1);
    });

    it("keeps a whole batch idempotent", async () => {
      const batch = [
        normalised({ telegramMessageId: 1, text: "one" }),
        normalised({ telegramMessageId: 2, text: "two" }),
        normalised({ telegramMessageId: 3, text: "three" }),
      ];
      await persistMessages(harness.db, batch);
      await persistMessages(harness.db, batch);
      await expect(harness.db.select().from(messages)).resolves.toHaveLength(3);
    });
  });

  describe("reply resolution", () => {
    it("links a reply to the parent it answers", async () => {
      const parent = await persistMessage(
        harness.db,
        normalised({ telegramMessageId: 4000, text: "what is the sterilisation rate?" }),
      );
      const child = await persistMessage(
        harness.db,
        normalised({ telegramMessageId: 4021, replyToTelegramMessageId: 4000, text: "47 a month" }),
      );

      const rows = await harness.db
        .select({ replyToMessageId: messages.replyToMessageId })
        .from(messages)
        .where(eq(messages.id, child.id));
      expect(rows[0]?.replyToMessageId).toBe(parent.id);
    });

    it("resolves a chain within one batch, given sent_at order", async () => {
      const persisted = await persistMessages(harness.db, [
        normalised({ telegramMessageId: 1, text: "first" }),
        normalised({ telegramMessageId: 2, text: "second", replyToTelegramMessageId: 1 }),
        normalised({ telegramMessageId: 3, text: "third", replyToTelegramMessageId: 2 }),
      ]);

      const rows = await harness.db
        .select({ id: messages.id, parent: messages.replyToMessageId })
        .from(messages)
        .orderBy(messages.telegramMessageId);
      expect(rows[1]?.parent).toBe(persisted[0]?.id);
      expect(rows[2]?.parent).toBe(persisted[1]?.id);
    });

    it("leaves the pointer null when the parent is not held, without failing", async () => {
      // A reply to a message from before Baton joined the group. Ordinary, not an
      // error — and the foreign key would reject a fabricated pointer.
      const result = await persistMessage(
        harness.db,
        normalised({ replyToTelegramMessageId: 999_999 }),
      );
      const rows = await harness.db
        .select({
          replyToMessageId: messages.replyToMessageId,
          replyToTelegramMessageId: messages.replyToTelegramMessageId,
        })
        .from(messages)
        .where(eq(messages.id, result.id));
      expect(rows[0]?.replyToMessageId).toBeNull();
      // Telegram's own pointer is still recorded, so it can resolve later.
      expect(rows[0]?.replyToTelegramMessageId).toBe(999_999);
    });

    it("resolves a pointer later, once the parent arrives", async () => {
      await persistMessage(
        harness.db,
        normalised({ telegramMessageId: 2, replyToTelegramMessageId: 1 }),
      );
      const parent = await persistMessage(
        harness.db,
        normalised({ telegramMessageId: 1, text: "parent" }),
      );
      // Re-processing the child now that the parent is held.
      await persistMessage(
        harness.db,
        normalised({ telegramMessageId: 2, replyToTelegramMessageId: 1 }),
      );

      const rows = await harness.db
        .select({ parent: messages.replyToMessageId })
        .from(messages)
        .where(and(eq(messages.chatId, CHAT_ID), eq(messages.telegramMessageId, 2)));
      expect(rows[0]?.parent).toBe(parent.id);
    });

    it("finds a message by its Telegram id within the chat", async () => {
      const stored = await persistMessage(harness.db, normalised({ telegramMessageId: 77 }));
      await expect(findMessageIdByTelegramId(harness.db, CHAT_ID, 77)).resolves.toBe(stored.id);
      await expect(findMessageIdByTelegramId(harness.db, -999, 77)).resolves.toBeNull();
    });
  });

  describe("sender resolution", () => {
    it("creates one person per Telegram account, however many messages arrive", async () => {
      await persistMessages(harness.db, [
        normalised({ telegramMessageId: 1, text: "one" }),
        normalised({ telegramMessageId: 2, text: "two" }),
      ]);
      const rows = await harness.db.select().from(people);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.telegramUserId).toBe(588068795);
    });

    it("links the message to the person", async () => {
      const stored = await persistMessage(harness.db, normalised());
      const personRows = await harness.db.select({ id: people.id }).from(people);
      const messageRows = await harness.db
        .select({ senderPersonId: messages.senderPersonId })
        .from(messages)
        .where(eq(messages.id, stored.id));
      expect(messageRows[0]?.senderPersonId).toBe(personRows[0]?.id);
    });

    it("refreshes a display name someone changed in Telegram", async () => {
      await persistMessage(harness.db, normalised({ telegramMessageId: 1 }));
      await persistMessage(
        harness.db,
        normalised({ telegramMessageId: 2, senderDisplayName: "Priya R." }),
      );
      const rows = await harness.db.select({ displayName: people.displayName }).from(people);
      expect(rows[0]?.displayName).toBe("Priya R.");
    });

    it("does not resurrect a departed volunteer when an old message is reprocessed", async () => {
      // Membership belongs to the chat_member path, which is the only thing that
      // knows. A resurrected member is a departure brief that never fires.
      const personId = await upsertPersonByTelegramId(harness.db, {
        telegramUserId: 588068795,
        displayName: "Priya Raghavan",
      });
      await harness.db.update(people).set({ status: "left" }).where(eq(people.id, personId));

      await persistMessage(harness.db, normalised());

      const rows = await harness.db.select({ status: people.status }).from(people);
      expect(rows[0]?.status).toBe("left");
    });

    it("accepts a seeded message whose sender the caller resolved", async () => {
      // Seventeen of the twenty seeded volunteers have no Telegram account at all.
      const personId = await upsertPersonByTelegramId(harness.db, {
        telegramUserId: 111,
        displayName: "Divya Nair",
      });
      const stored = await persistMessage(
        harness.db,
        normalised({ source: "seed", senderTelegramUserId: null, senderDisplayName: "Divya Nair" }),
        { senderPersonId: personId },
      );
      const rows = await harness.db
        .select({ senderPersonId: messages.senderPersonId, source: messages.source })
        .from(messages)
        .where(eq(messages.id, stored.id));
      expect(rows[0]?.senderPersonId).toBe(personId);
      expect(rows[0]?.source).toBe("seed");
    });

    it("stores a message with no resolvable sender rather than dropping it", async () => {
      const stored = await persistMessage(
        harness.db,
        normalised({ senderTelegramUserId: null, senderDisplayName: "Someone" }),
      );
      const rows = await harness.db
        .select({
          senderPersonId: messages.senderPersonId,
          senderDisplayName: messages.senderDisplayName,
        })
        .from(messages)
        .where(eq(messages.id, stored.id));
      expect(rows[0]?.senderPersonId).toBeNull();
      expect(rows[0]?.senderDisplayName).toBe("Someone");
      await expect(harness.db.select().from(people)).resolves.toHaveLength(0);
    });
  });

  describe("the curation reset is driven by content, not by update type", () => {
    /** Marks a message as already curated and pre-filtered, as the loops would. */
    async function markCurated(id: string): Promise<void> {
      await harness.db
        .update(messages)
        .set({
          curatedAt: new Date("2026-04-13T00:00:00Z"),
          prefilterVerdict: "candidate",
          prefilterVersion: 1,
        })
        .where(eq(messages.id, id));
    }

    async function curationState(id: string) {
      const rows = await harness.db
        .select({
          curatedAt: messages.curatedAt,
          prefilterVerdict: messages.prefilterVerdict,
          prefilterVersion: messages.prefilterVersion,
        })
        .from(messages)
        .where(eq(messages.id, id));
      return rows[0];
    }

    it("preserves curation when identical text is replayed after a crash", async () => {
      // Without this, every restart re-curates the whole transcript at real cost.
      const stored = await persistMessage(harness.db, normalised());
      await markCurated(stored.id);

      await persistMessage(harness.db, normalised());

      const state = await curationState(stored.id);
      expect(state?.curatedAt).not.toBeNull();
      expect(state?.prefilterVerdict).toBe("candidate");
      expect(state?.prefilterVersion).toBe(1);
    });

    it("clears curation when an edit changes the text", async () => {
      // The derived facts came from text that no longer exists, so the message must
      // be re-curated and the old facts superseded.
      const stored = await persistMessage(harness.db, normalised());
      await markCurated(stored.id);

      await persistMessage(
        harness.db,
        normalised({
          text: "Sunrise Clinic now wants payment within 7 days",
          isEdited: true,
          editedAt: new Date("2026-04-14T10:00:00Z"),
        }),
      );

      const state = await curationState(stored.id);
      expect(state?.curatedAt).toBeNull();
      expect(state?.prefilterVerdict).toBeNull();
      expect(state?.prefilterVersion).toBeNull();
    });

    it("records the edit on the same row rather than adding one", async () => {
      const stored = await persistMessage(harness.db, normalised());
      const edited = await persistMessage(
        harness.db,
        normalised({
          text: "corrected",
          isEdited: true,
          editedAt: new Date("2026-04-14T10:00:00Z"),
        }),
      );

      expect(edited.id).toBe(stored.id);
      const rows = await harness.db
        .select({ text: messages.text, isEdited: messages.isEdited, editedAt: messages.editedAt })
        .from(messages);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.text).toBe("corrected");
      expect(rows[0]?.isEdited).toBe(true);
      expect(rows[0]?.editedAt).not.toBeNull();
    });

    it("keeps a known edit timestamp when a later replay does not carry one", async () => {
      const stored = await persistMessage(
        harness.db,
        normalised({
          text: "corrected",
          isEdited: true,
          editedAt: new Date("2026-04-14T10:00:00Z"),
        }),
      );
      await persistMessage(harness.db, normalised({ text: "corrected", isEdited: true }));

      const rows = await harness.db
        .select({ editedAt: messages.editedAt })
        .from(messages)
        .where(eq(messages.id, stored.id));
      expect(rows[0]?.editedAt).not.toBeNull();
    });
  });

  describe("provenance and media flags survive the round trip", () => {
    it("records a forwarded message as the forwarder's, flagged", async () => {
      const stored = await persistMessage(
        harness.db,
        normalised({ isForwarded: true, forwardedFrom: "Ravi" }),
      );
      const rows = await harness.db
        .select({ isForwarded: messages.isForwarded, forwardedFrom: messages.forwardedFrom })
        .from(messages)
        .where(eq(messages.id, stored.id));
      expect(rows[0]?.isForwarded).toBe(true);
      expect(rows[0]?.forwardedFrom).toBe("Ravi");
    });

    it("logs a voice note as unprocessed rather than dropping it", async () => {
      const stored = await persistMessage(
        harness.db,
        normalised({ text: null, mediaKind: "voice", isUnprocessed: true }),
      );
      const rows = await harness.db
        .select({
          text: messages.text,
          mediaKind: messages.mediaKind,
          isUnprocessed: messages.isUnprocessed,
        })
        .from(messages)
        .where(eq(messages.id, stored.id));
      expect(rows[0]?.text).toBeNull();
      expect(rows[0]?.mediaKind).toBe("voice");
      expect(rows[0]?.isUnprocessed).toBe(true);
    });

    it("does not touch withdrawal, which is only ever a coordinator action", async () => {
      const stored = await persistMessage(harness.db, normalised());
      await harness.db
        .update(messages)
        .set({ isWithdrawn: true, withdrawnAt: new Date() })
        .where(eq(messages.id, stored.id));

      await persistMessage(harness.db, normalised());

      const rows = await harness.db
        .select({ isWithdrawn: messages.isWithdrawn })
        .from(messages)
        .where(eq(messages.id, stored.id));
      expect(rows[0]?.isWithdrawn).toBe(true);
    });
  });
});
