/**
 * The runtime supervisor.
 *
 * **This file is the one that proves the worker is a service rather than a library.**
 * Everything under `pipeline/` and `telegram/` was reachable only from tests until
 * `startWorkerRuntime` existed, and the ticks in those suites all meant "the behaviour is
 * correct when something calls it". These tests are about the something.
 *
 * The seam is the fake Telegram and the fake transport, so no bot, no token, no network
 * and no model are involved — Telegram setup is an unproven Phase 0 gate and the runtime
 * should not have to wait on it.
 *
 * Note what is still *not* proved here: a real container, a real bot, a real model. This
 * is test-proved wiring, not deployment-proved.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import type { AgentRequest, AgentResponse, TelegramUpdate } from "@baton/core";
import { contentHash } from "@baton/core";
import type { AgentTransport } from "../src/agent/transport.js";
import { TelegramClient } from "../src/telegram/client.js";
import { OutboundQueue } from "../src/telegram/outbound-queue.js";
import { persistMessage } from "../src/store/messages.js";
import { runPrefilterPass } from "../src/pipeline/prefilter.js";
import { loadConfig, type WorkerConfig } from "../src/config.js";
import { startWorkerRuntime, buildIntakeHandlers } from "../src/runtime/worker.js";
import { FakeTelegram } from "./helpers/fake-telegram.js";

const { runs, people, appSettings, briefs } = schema;

const CHAT_ID = -1001234567890;
const BOT_ID = 8871830879;
const LEAVER_ID = 588068795;

function config(overrides: Partial<NodeJS.ProcessEnv> = {}): WorkerConfig {
  return loadConfig({
    DATABASE_URL: "postgres://unused",
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_CHAT_ID: String(CHAT_ID),
    COORDINATOR_TELEGRAM_ID: "489705226",
    AGENT_TRANSPORT: "http",
    AGENT_HTTP_URL: "http://localhost:8080",
    DATA_API_TOKEN: "t",
    ...overrides,
  });
}

/** Answers every task emptily, and records which were asked for. */
class QuietTransport implements AgentTransport {
  readonly kind = "http" as const;
  readonly tasks: string[] = [];
  failEverything = false;

  invoke(request: AgentRequest): Promise<AgentResponse> {
    this.tasks.push(request.task);
    if (this.failEverything) return Promise.reject(new Error("transport is down"));

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
      case "brief":
        return Promise.resolve({
          ...base,
          stopReason: "complete",
          result: {
            brief: {
              kind: "departure",
              subjectPersonId: (request.payload as { subjectPersonId: string }).subjectPersonId,
              // The empty case is stated plainly rather than rendered as three empty
              // sections, which is what the schema enforces and what a reader needs.
              openingLine: "Nothing appears to have left with them.",
              isEmpty: true,
              lines: [],
              reasoning: "fake",
            },
            quietDecisions: [],
          },
        } as AgentResponse);
      default:
        return Promise.resolve({ ...base, stopReason: "complete", result: {} } as AgentResponse);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function membershipUpdate(updateId: number, status: string): TelegramUpdate {
  return {
    update_id: updateId,
    chat_member: {
      chat: { id: CHAT_ID, type: "supergroup" },
      from: { id: LEAVER_ID, first_name: "Meera" },
      date: 1_776_000_000 + updateId,
      old_chat_member: { user: { id: LEAVER_ID, first_name: "Meera" }, status: "member" },
      new_chat_member: { user: { id: LEAVER_ID, first_name: "Meera" }, status },
    },
  };
}

/**
 * Waits until `check` is true, or fails with the log attached.
 *
 * Polls rather than sleeping a guess, and reports the captured log lines on timeout —
 * a bare "timed out" in a test that drives two background loops tells you nothing about
 * which one stalled.
 */
async function until(
  check: () => Promise<boolean> | boolean,
  label: string,
  lines: readonly string[] = [],
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `timed out waiting for: ${label}\nlog:\n${lines.map((line) => `  ${line}`).join("\n")}`,
  );
}

describe("the runtime supervisor", () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await setupTestDatabase();
  });

  afterAll(async () => {
    await test.close();
  });

  beforeEach(async () => {
    await test.truncate();
  });

  /** Stores one pre-filtered candidate, so the ingest pass reaches the transport. */
  async function seedCandidate(): Promise<void> {
    await persistMessage(test.db, {
      source: "telegram",
      chatId: CHAT_ID,
      telegramMessageId: 7001,
      senderTelegramUserId: 489705226,
      senderDisplayName: "Anil Kumar",
      sentAt: new Date("2026-05-02T09:00:00.000Z"),
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

  function harness(overrides: { chatMemberStatus?: string } = {}): {
    telegram: FakeTelegram;
    client: TelegramClient;
    queue: OutboundQueue;
    transport: QuietTransport;
    lines: string[];
  } {
    const telegram = new FakeTelegram();
    telegram.queue("getMe", { id: BOT_ID, is_bot: true, username: "baton_bot" });
    telegram.queue("getChatMember", { status: overrides.chatMemberStatus ?? "administrator" });

    const client = new TelegramClient({ token: "t", fetchImpl: telegram.fetchImpl });
    const queue = new OutboundQueue({ telegram: client, sleep: () => Promise.resolve() });

    return { telegram, client, queue, transport: new QuietTransport(), lines: [] };
  }

  describe("startup", () => {
    it("seeds app settings before the loops, because every hydration path reads them", async () => {
      const { client, queue, transport, lines } = harness();

      const runtime = await startWorkerRuntime({
        db: test.db,
        config: config(),
        transport,
        telegram: client,
        queue,
        log: (line) => lines.push(line),
      });

      try {
        const rows = await test.db
          .select({ chatId: appSettings.chatId, timezone: appSettings.timezone })
          .from(appSettings);
        expect(rows[0]?.chatId).toBe(CHAT_ID);
        // Never UTC: at IST, UTC shifts a relative date by a day and reads as a
        // provenance bug rather than a timezone one.
        expect(rows[0]?.timezone).toBe("Asia/Kolkata");
      } finally {
        await runtime.stop();
      }
    });

    it("resolves the bot's identity before polling", async () => {
      // Until the bot's user id is known nothing can be recognised as Baton's own
      // message, so it would ingest its own answers — a corruption loop with no symptom.
      const { telegram, client, queue, transport, lines } = harness();

      const runtime = await startWorkerRuntime({
        db: test.db,
        config: config(),
        transport,
        telegram: client,
        queue,
        log: (line) => lines.push(line),
      });

      try {
        const calls = telegram.calls.map((call) => call.method);
        expect(calls.indexOf("getMe")).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf("getMe")).toBeLessThan(
          calls.indexOf("getUpdates") === -1
            ? Number.MAX_SAFE_INTEGER
            : calls.indexOf("getUpdates"),
        );
        expect(lines.some((line) => line.includes(String(BOT_ID)))).toBe(true);
      } finally {
        await runtime.stop();
      }
    });

    it("warns when the bot is not a group administrator", async () => {
      // Telegram delivers chat_member only to administrators. A non-admin bot misses
      // every join and departure, so the brief never fires — and nothing errors. One
      // line in the deploy log is the difference between finding this now and finding it
      // on camera.
      const { client, queue, transport, lines } = harness({ chatMemberStatus: "member" });

      const runtime = await startWorkerRuntime({
        db: test.db,
        config: config(),
        transport,
        telegram: client,
        queue,
        log: (line) => lines.push(line),
      });

      try {
        expect(lines.some((line) => line.includes("not administrator"))).toBe(true);
      } finally {
        await runtime.stop();
      }
    });
  });

  describe("the loops", () => {
    it("polls and writes a runs row per tick", async () => {
      // The item that turns every test-proved tick into a running service: something
      // actually calls the passes on a schedule.
      const { telegram, client, queue, transport, lines } = harness();

      const runtime = await startWorkerRuntime({
        db: test.db,
        config: config(),
        transport,
        telegram: client,
        queue,
        intakeIdleMs: 5,
        tickIdleMs: 5,
        log: (line) => lines.push(line),
      });

      try {
        await until(() => telegram.callsTo("getUpdates").length > 0, "a poll", lines);
        await until(
          async () => {
            const [row] = await test.db.execute<{ total: number }>(
              sql`select count(*)::int as total from ${runs}`,
            );
            return (row?.total ?? 0) > 0;
          },
          "a runs row",
          lines,
        );
      } finally {
        await runtime.stop();
      }
    });

    it("fires a brief from a membership event, with no button pressed", async () => {
      // The seam *is* the feature, and it is the failure that looks fine until the demo:
      // every part works in isolation while nothing connects the event to the brief.
      const { telegram, client, queue, transport, lines } = harness();
      telegram.queueUpdates([membershipUpdate(1, "left")]);

      const runtime = await startWorkerRuntime({
        db: test.db,
        config: config(),
        transport,
        telegram: client,
        queue,
        intakeIdleMs: 5,
        tickIdleMs: 5_000,
        log: (line) => lines.push(line),
      });

      try {
        await until(
          async () => {
            const rows = await test.db
              .select({ id: people.id, status: people.status })
              .from(people);
            return rows.some((row) => row.status === "left");
          },
          "the person marked as left",
          lines,
        );

        await until(
          async () => {
            const rows = await test.db.select({ id: briefs.id }).from(briefs);
            return rows.length > 0;
          },
          "a brief row",
          lines,
        );

        expect(transport.tasks).toContain("brief");
      } finally {
        await runtime.stop();
      }
    }, 20_000);

    it("stops both loops and drains the queue on shutdown", async () => {
      // A queued outbound message lost on redeploy is a question a volunteer was about
      // to be asked, dropped with nothing recording that it happened.
      const { client, queue, transport, lines } = harness();

      const runtime = await startWorkerRuntime({
        db: test.db,
        config: config(),
        transport,
        telegram: client,
        queue,
        intakeIdleMs: 5,
        tickIdleMs: 5,
        log: (line) => lines.push(line),
      });

      await queue.enqueue({ chatId: CHAT_ID, text: "queued before shutdown" });
      await runtime.stop();

      expect(queue.depth).toBe(0);
      // `stopped` resolving is the assertion that neither loop is still running.
      await expect(runtime.stopped).resolves.toBeUndefined();
    });

    it("stops the tick loop after the failure cap without exiting the process", async () => {
      // Exiting would have Coolify restart the container, which resets the counter and
      // defeats the cap entirely — the restart loop the health-check design exists to
      // avoid. A stopped loop in a live container keeps /health green.
      //
      // A candidate message is seeded so the ingest pass actually reaches the transport:
      // an idle tick never calls a model, so it cannot fail at one. No membership update
      // is queued, because the brief handler runs *inside* the intake loop and would
      // make that loop fail too — which would prove the loops fail together rather than
      // independently, the opposite of what this asserts.
      const { client, queue, transport, lines } = harness();
      await seedCandidate();
      transport.failEverything = true;

      const runtime = await startWorkerRuntime({
        db: test.db,
        config: config(),
        transport,
        telegram: client,
        queue,
        intakeIdleMs: 20,
        tickIdleMs: 1,
        backoff: { initialDelayMs: 1, maxDelayMs: 2, maxConsecutiveFailures: 2, jitter: 0 },
        log: (line) => lines.push(line),
      });

      try {
        await until(
          () => lines.some((line) => line.includes("[tick] stopping after")),
          "the tick loop to give up",
          lines,
        );
        expect(lines.some((line) => line.includes("container stays up"))).toBe(true);
        // The intake loop was never failing, so it must not have stopped with it.
        expect(lines.some((line) => line.includes("[intake] stopping after"))).toBe(false);
      } finally {
        await runtime.stop();
      }
    }, 20_000);
  });

  describe("the intake handlers", () => {
    it("wires all four, because each omission is a distinct silent failure", () => {
      const { queue, transport } = harness();

      const handlers = buildIntakeHandlers({
        db: test.db,
        transport,
        queue,
        chatId: CHAT_ID,
        permittedTelegramIds: [1],
        log: () => {},
      });

      // Asserted as a set rather than individually: the loop's interface makes every
      // handler optional, so a handler dropped during a refactor would not fail to
      // compile and would not fail any other test.
      expect(Object.keys(handlers).sort()).toEqual([
        "onBotMembershipEvent",
        "onEditedMessage",
        "onMembershipEvent",
        "onQuestionToBot",
      ]);
    });

    it("ignores a bot membership change in a chat that is not the configured one", async () => {
      // `normaliseUpdate` filters messages by chat id but not `my_chat_member`, so
      // without this guard adding the bot to any other group has it introduce itself
      // there — confusing, and a bad way to learn a token was reused between the demo
      // bot and the development bot.
      const { queue, transport, lines } = harness();

      const handlers = buildIntakeHandlers({
        db: test.db,
        transport,
        queue,
        chatId: CHAT_ID,
        permittedTelegramIds: [1],
        log: (line) => lines.push(line),
      });

      await handlers.onBotMembershipEvent?.({
        chatId: -1009999999999,
        at: new Date(),
        status: "member",
        isNowMember: true,
      });

      expect(lines.some((line) => line.includes("foreign chat"))).toBe(true);
      expect(queue.depth).toBe(0);
    });
  });
});
