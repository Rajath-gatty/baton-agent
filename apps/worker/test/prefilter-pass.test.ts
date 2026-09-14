/**
 * The pre-filter pass, against real Postgres.
 *
 * Two behaviours here are the ones that would fail silently: a verdict not written
 * for a discarded message (so an improved filter can never find it again), and a
 * re-evaluation that quietly re-curates messages whose text never changed.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { PREFILTER_VERSION, contentHash, type NormalisedMessage } from "@baton/core";
import { persistMessages } from "../src/store/messages.js";
import {
  countUnfiltered,
  runPrefilterPass,
  selectCurationCandidates,
} from "../src/pipeline/prefilter.js";

const { messages } = schema;
const CHAT_ID = -1001234567890;

let nextId = 1;

function normalised(
  text: string | null,
  overrides: Partial<NormalisedMessage> = {},
): NormalisedMessage {
  return {
    source: "telegram",
    chatId: CHAT_ID,
    telegramMessageId: nextId++,
    senderTelegramUserId: 588068795,
    senderDisplayName: "Priya Raghavan",
    sentAt: new Date(`2026-04-${String((nextId % 27) + 1).padStart(2, "0")}T10:00:00Z`),
    text,
    replyToTelegramMessageId: null,
    isForwarded: false,
    forwardedFrom: null,
    isEdited: false,
    editedAt: null,
    isUnprocessed: false,
    mediaKind: null,
    ...overrides,
    contentHash: contentHash(text),
  };
}

describe("the pre-filter pass", () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    nextId = 1;
  });

  it("writes a verdict for every message, kept and discarded alike", async () => {
    // A discard is a decision, not an absence. Without the row saying so, an
    // improved filter has no way to find what a worse one threw away.
    await persistMessages(harness.db, [
      normalised("Sunrise Clinic lets us settle at month end"),
      normalised("haha same"),
      normalised("I have the shelter keys"),
      normalised("ok"),
    ]);

    const result = await runPrefilterPass(harness.db);

    expect(result.evaluated).toBe(4);
    expect(result.candidates).toBe(2);
    expect(result.discarded).toBe(2);

    const rows = await harness.db
      .select({
        text: messages.text,
        verdict: messages.prefilterVerdict,
        version: messages.prefilterVersion,
      })
      .from(messages);

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.verdict, `${row.text}`).not.toBeNull();
      expect(row.version).toBe(PREFILTER_VERSION);
    }
  });

  it("leaves nothing unjudged once it has run", async () => {
    await persistMessages(harness.db, [normalised("I have the keys"), normalised("ok")]);
    await expect(countUnfiltered(harness.db)).resolves.toBe(2);

    await runPrefilterPass(harness.db);
    await expect(countUnfiltered(harness.db)).resolves.toBe(0);
  });

  it("is idempotent — a second pass has nothing to do", async () => {
    await persistMessages(harness.db, [normalised("I have the keys")]);
    await runPrefilterPass(harness.db);

    const second = await runPrefilterPass(harness.db);
    expect(second.evaluated).toBe(0);
  });

  it("discards media with no caption while leaving it stored and flagged", async () => {
    await persistMessages(harness.db, [
      normalised(null, { isUnprocessed: true, mediaKind: "voice" }),
    ]);
    await runPrefilterPass(harness.db);

    const rows = await harness.db
      .select({
        verdict: messages.prefilterVerdict,
        isUnprocessed: messages.isUnprocessed,
        mediaKind: messages.mediaKind,
      })
      .from(messages);
    expect(rows[0]?.verdict).toBe("discarded");
    expect(rows[0]?.isUnprocessed).toBe(true);
    expect(rows[0]?.mediaKind).toBe("voice");
  });

  it("honours a cap and works from the oldest end", async () => {
    await persistMessages(harness.db, [
      normalised("I have the keys", { sentAt: new Date("2026-04-01T10:00:00Z") }),
      normalised("Meera runs the donation page", { sentAt: new Date("2026-04-02T10:00:00Z") }),
      normalised("Anil holds the van keys", { sentAt: new Date("2026-04-03T10:00:00Z") }),
    ]);

    const first = await runPrefilterPass(harness.db, { limit: 2 });
    expect(first.evaluated).toBe(2);
    await expect(countUnfiltered(harness.db)).resolves.toBe(1);

    // The one left is the newest.
    const remaining = await harness.db
      .select({ text: messages.text })
      .from(messages)
      .where(sql`${messages.prefilterVersion} is null`);
    expect(remaining[0]?.text).toBe("Anil holds the van keys");
  });

  describe("re-evaluation when the version moves", () => {
    it("re-examines prior discards rather than losing them permanently", async () => {
      await persistMessages(harness.db, [normalised("where is everyone")]);
      await runPrefilterPass(harness.db);

      const before = await harness.db.select({ verdict: messages.prefilterVerdict }).from(messages);
      expect(before[0]?.verdict).toBe("discarded");

      // Simulate an older filter having judged it: the pass must pick it up again.
      await harness.db.update(messages).set({ prefilterVersion: PREFILTER_VERSION - 1 });
      await expect(countUnfiltered(harness.db)).resolves.toBe(1);

      const result = await runPrefilterPass(harness.db);
      expect(result.evaluated).toBe(1);
      const after = await harness.db.select({ version: messages.prefilterVersion }).from(messages);
      expect(after[0]?.version).toBe(PREFILTER_VERSION);
    });

    it("does not re-curate a message whose text never changed", async () => {
      // Re-judging a verdict is cheap. Re-curating is a model call per message, and
      // doing it on every filter revision would make improving the filter expensive
      // enough that nobody would.
      await persistMessages(harness.db, [normalised("I have the shelter keys")]);
      await runPrefilterPass(harness.db);

      const curatedAt = new Date("2026-05-01T00:00:00Z");
      await harness.db.update(messages).set({ curatedAt, prefilterVersion: PREFILTER_VERSION - 1 });

      await runPrefilterPass(harness.db);

      const rows = await harness.db.select({ curatedAt: messages.curatedAt }).from(messages);
      expect(rows[0]?.curatedAt).toEqual(curatedAt);
    });
  });

  describe("selecting curation candidates", () => {
    it("returns kept, uncurated messages in sent_at order", async () => {
      // Order matters: supersession is order-dependent, and a contradiction
      // processed backwards silently inverts a fact.
      await persistMessages(harness.db, [
        normalised("clinic wants payment within 7 days now", {
          sentAt: new Date("2026-06-01T10:00:00Z"),
        }),
        normalised("Sunrise Clinic lets us settle at month end", {
          sentAt: new Date("2026-04-01T10:00:00Z"),
        }),
        normalised("ok", { sentAt: new Date("2026-05-01T10:00:00Z") }),
      ]);
      await runPrefilterPass(harness.db);

      const candidates = await selectCurationCandidates(harness.db, 10);
      expect(candidates.map((row) => row.text)).toEqual([
        "Sunrise Clinic lets us settle at month end",
        "clinic wants payment within 7 days now",
      ]);
    });

    it("excludes messages already curated", async () => {
      await persistMessages(harness.db, [normalised("I have the shelter keys")]);
      await runPrefilterPass(harness.db);
      await expect(selectCurationCandidates(harness.db, 10)).resolves.toHaveLength(1);

      await harness.db.update(messages).set({ curatedAt: new Date() });
      await expect(selectCurationCandidates(harness.db, 10)).resolves.toHaveLength(0);
    });

    it("excludes discarded messages", async () => {
      const stored = await persistMessages(harness.db, [normalised("ok")]);
      await runPrefilterPass(harness.db);
      const candidates = await selectCurationCandidates(harness.db, 10);
      expect(candidates.find((row) => row.id === stored[0]?.id)).toBeUndefined();
    });

    it("excludes media with no text even if a verdict said candidate", async () => {
      // Defensive: there is nothing to send to a model, and a null-text candidate
      // would fail the ingest payload schema, which requires a non-empty string.
      await persistMessages(harness.db, [
        normalised(null, { isUnprocessed: true, mediaKind: "photo" }),
      ]);
      await harness.db
        .update(messages)
        .set({ prefilterVerdict: "candidate", prefilterVersion: PREFILTER_VERSION });

      await expect(selectCurationCandidates(harness.db, 10)).resolves.toHaveLength(0);
    });

    it("honours its limit, so a batch stays a batch", async () => {
      await persistMessages(harness.db, [
        normalised("Anil holds the van keys"),
        normalised("Meera runs the donation page"),
        normalised("Divya is our contact at the vet college"),
      ]);
      await runPrefilterPass(harness.db);
      await expect(selectCurationCandidates(harness.db, 2)).resolves.toHaveLength(2);
    });
  });
});

describe("the discarded count that feeds runs", () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("reports what was skipped, so a low extraction count reads as sane", async () => {
    // A coordinator reading "read 400, extracted 3" needs to know 380 were never
    // candidates, or the number reads as a broken pipeline.
    await harness.truncate();
    nextId = 1;
    await persistMessages(harness.db, [
      normalised("I have the shelter keys"),
      normalised("ok"),
      normalised("lol"),
      normalised("thanks"),
    ]);

    const result = await runPrefilterPass(harness.db);
    expect(result.evaluated).toBe(4);
    expect(result.discarded).toBe(3);
    expect(result.candidates).toBe(1);
  });
});
