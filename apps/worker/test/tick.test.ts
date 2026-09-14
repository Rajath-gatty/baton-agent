/**
 * The processing tick.
 *
 * Three properties, each of which fails silently if it regresses:
 *
 *   1. **The pass order.** Sweep before respond, ask last. Reorder it and nothing
 *      errors — answers are simply computed against a register one tick stale, and
 *      questions raised this tick are sent next tick.
 *   2. **`respond` runs outside the pipeline lock.** Wrap the tick in one locked block
 *      while "tidying up" and nothing fails: group questions just start waiting behind
 *      backfills, which is the one delay anybody notices during a demo.
 *   3. **A failing pass does not abort the tick.** If ingest cannot reach the model,
 *      answering from the register that already exists is still the right thing to do.
 *
 * The lock property is asserted behaviourally — by holding the lock from another
 * connection and observing that respond still ran — and structurally, against the
 * exported `LOCKED_PASSES`, so a refactor cannot quietly widen it.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import type { AgentRequest, AgentResponse } from "@baton/core";
import { contentHash } from "@baton/core";
import type { AgentTransport } from "../src/agent/transport.js";
import { OutboundQueue } from "../src/telegram/outbound-queue.js";
import { TelegramClient } from "../src/telegram/client.js";
import { PIPELINE_LOCK_KEY } from "../src/store/lock.js";
import { seedAppSettings } from "../src/store/app-settings.js";
import { persistMessage } from "../src/store/messages.js";
import { runPrefilterPass } from "../src/pipeline/prefilter.js";
import { LOCKED_PASSES, TICK_PASSES, runTick, type TickPass } from "../src/runtime/tick.js";
import { FakeTelegram } from "./helpers/fake-telegram.js";

const { runs } = schema;
const CHAT_ID = -1001234567890;

/**
 * A transport that records which task it was asked for and answers emptily.
 *
 * Empty results are the point: this file tests the tick's control flow, and the passes'
 * own behaviour is covered by their own suites. What matters here is the sequence.
 */
class RecordingTransport implements AgentTransport {
  readonly kind = "http" as const;
  readonly tasks: string[] = [];
  /** Tasks to fail, so a pass can be made to throw without breaking the others. */
  failTasks = new Set<string>();

  invoke(request: AgentRequest): Promise<AgentResponse> {
    this.tasks.push(request.task);

    if (this.failTasks.has(request.task)) {
      return Promise.reject(new Error(`fake failure for task '${request.task}'`));
    }

    const base = { task: request.task, runId: request.runId, trace: [] };
    switch (request.task) {
      case "ingest":
        return Promise.resolve({
          ...base,
          stopReason: "complete",
          result: { messages: [] },
        } as AgentResponse);
      case "assess":
        return Promise.resolve({
          ...base,
          stopReason: "complete",
          result: { findings: [], quietDecisions: [] },
        } as AgentResponse);
      default:
        return Promise.resolve({ ...base, stopReason: "complete", result: {} } as AgentResponse);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function buildQueue(): OutboundQueue {
  const fake = new FakeTelegram();
  return new OutboundQueue({
    telegram: new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl }),
    sleep: () => Promise.resolve(),
  });
}

describe("the tick", () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await setupTestDatabase();
  });

  afterAll(async () => {
    await test.close();
  });

  beforeEach(async () => {
    await test.truncate();
    await seedAppSettings(test.db, { chatId: CHAT_ID, timezone: "Asia/Kolkata" });
  });

  describe("the pass order", () => {
    it("is ingest, sweep, respond, ask — and says so as a value a test can read", () => {
      // Named rather than inferred, so the intended order is reviewable in one place
      // instead of being spread across the body of runTick.
      expect(TICK_PASSES).toEqual(["ingest", "sweep", "respond", "ask"]);
    });

    it("runs every pass, in that order", async () => {
      const transport = new RecordingTransport();

      const result = await runTick({ db: test.db, transport, queue: buildQueue() });

      expect(result.failures).toEqual([]);
      expect(result.completed).toEqual([...TICK_PASSES]);
    });

    it("opens a run row per pass that did work, for the activity panel", async () => {
      const transport = new RecordingTransport();

      await runTick({ db: test.db, transport, queue: buildQueue() });

      const kinds = await test.db.select({ kind: runs.kind }).from(runs);
      // A short-circuited sweep still writes a run row, because "nothing had changed" is
      // a result and a silent sweep is indistinguishable from a scheduler that stopped.
      expect(kinds.map((row) => row.kind)).toContain("sweep");
    });
  });

  describe("the pipeline lock", () => {
    it("names only the passes that take it, so the set cannot widen unnoticed", () => {
      expect([...LOCKED_PASSES]).toEqual(["ingest", "sweep"]);
      expect(LOCKED_PASSES).not.toContain<TickPass>("respond");
      expect(LOCKED_PASSES).not.toContain<TickPass>("ask");
    });

    it("answers questions while another pass holds the lock", async () => {
      // The property that matters: a backfill holding the lock must not make a group
      // question wait. Held from a separate connection, because an advisory lock is
      // re-entrant within one session and taking it on `test.db` would prove nothing.
      const holder = await test.db.$client.reserve();

      try {
        await holder.unsafe(`select pg_advisory_lock(${PIPELINE_LOCK_KEY})`);

        const transport = new RecordingTransport();
        const result = await runTick({ db: test.db, transport, queue: buildQueue() });

        // Ingest and sweep found the lock held. Not an error: the work is being done by
        // whoever holds it, and the next tick finds what is left.
        expect(result.lockHeld).toBe(true);

        // Respond and ask ran regardless. This is the assertion the design turns on.
        expect(result.completed).toContain<TickPass>("respond");
        expect(result.completed).toContain<TickPass>("ask");
        expect(result.failures).toEqual([]);
      } finally {
        await holder.unsafe(`select pg_advisory_unlock(${PIPELINE_LOCK_KEY})`);
        holder.release();
      }
    });
  });

  describe("failure isolation", () => {
    /**
     * Stores one candidate message, so ingest actually invokes the transport.
     *
     * Without a candidate `runIngestPass` returns before calling anything, so injecting a
     * transport failure would prove nothing — which is itself worth knowing: an idle tick
     * cannot fail at the model, because it never reaches it.
     */
    async function seedCandidate(): Promise<void> {
      await persistMessage(test.db, {
        source: "telegram",
        chatId: CHAT_ID,
        telegramMessageId: 5001,
        senderTelegramUserId: 588068795,
        senderDisplayName: "Priya Raghavan",
        sentAt: new Date("2026-05-01T10:00:00.000Z"),
        text: "Sunrise Clinic lets us settle at month end",
        contentHash: contentHash("Sunrise Clinic lets us settle at month end"),
        replyToTelegramMessageId: null,
        isForwarded: false,
        forwardedFrom: null,
        isEdited: false,
        editedAt: null,
        isUnprocessed: false,
        mediaKind: null,
      });
      await runPrefilterPass(test.db, { limit: 10 });
    }

    it("keeps running the later passes when an earlier one throws", async () => {
      // If ingest cannot reach the model, answering from the register that already
      // exists is still worth doing. Aborting the tick would mean one broken pass takes
      // the whole worker down to nothing.
      await seedCandidate();

      const transport = new RecordingTransport();
      transport.failTasks.add("ingest");

      const result = await runTick({ db: test.db, transport, queue: buildQueue() });

      expect(result.failures.map((failure) => failure.pass)).toEqual(["ingest"]);
      expect(result.completed).toContain<TickPass>("sweep");
      expect(result.completed).toContain<TickPass>("respond");
      expect(result.completed).toContain<TickPass>("ask");
    });

    it("reports the failing pass by name, not just that something failed", async () => {
      await seedCandidate();

      const transport = new RecordingTransport();
      transport.failTasks.add("ingest");

      const result = await runTick({ db: test.db, transport, queue: buildQueue() });

      expect(result.failures[0]?.pass).toBe("ingest");
      expect(result.failures[0]?.error).toContain("ingest");
    });

    it("records the failed pass as a failed run, so the activity panel shows it", async () => {
      // A pass that failed must leave a record of having failed. A run row absent
      // entirely reads as a pass that was never scheduled, which sends a reader looking
      // in the wrong place.
      await seedCandidate();

      const transport = new RecordingTransport();
      transport.failTasks.add("ingest");

      await runTick({ db: test.db, transport, queue: buildQueue() });

      const rows = await test.db.select({ kind: runs.kind, status: runs.status }).from(runs);
      expect(rows.some((row) => row.kind === "ingest" && row.status === "failed")).toBe(true);
    });
  });

  describe("an idle system", () => {
    it("calls no model when there is nothing to do", async () => {
      // The sweep short-circuits in SQL when the candidate set is unchanged, which is
      // what makes a fifteen-second tick affordable. A demo system sitting idle between
      // judging sessions must not cost anything.
      const transport = new RecordingTransport();

      await runTick({ db: test.db, transport, queue: buildQueue() });
      transport.tasks.length = 0;

      const second = await runTick({ db: test.db, transport, queue: buildQueue() });

      expect(second.failures).toEqual([]);
      expect(transport.tasks).toEqual([]);
    });

    it("still records the tick, so a stopped scheduler is distinguishable from a quiet one", async () => {
      const transport = new RecordingTransport();

      await runTick({ db: test.db, transport, queue: buildQueue() });

      const [row] = await test.db.execute<{ total: number }>(
        sql`select count(*)::int as total from ${runs}`,
      );
      expect(row?.total ?? 0).toBeGreaterThan(0);
    });
  });
});
