/**
 * backfill.ts — the seeded transcript into Postgres.
 *
 * **Stage one of backfill: intake only.** This loads the roster and the transcript
 * through the same normaliser and pre-filter that live traffic uses, and stops there.
 * Curation — sending candidates to `ingest` in batches of ten, then one `assess` pass —
 * is stage two and needs a working model call, which is gate G1. Splitting them means
 * the intake half can be run, inspected and corrected for free, before any tokens are
 * spent on a transcript that might have loaded wrongly.
 *
 * It holds the pipeline advisory lock throughout, so a running worker's live ingest
 * waits rather than interleaving. The lock is taken with `pg_try_advisory_lock` rather
 * than the blocking form: a backfill that silently queues behind another process looks
 * identical to one that has hung.
 *
 * Idempotent. `people` are keyed on display name, aliases on their normalised triple,
 * and messages upsert on `(chat_id, telegram_message_id)`, so a second run reports the
 * same totals with nothing inserted.
 *
 * Usage:
 *   pnpm backfill
 *   pnpm backfill -- --chat-id -1001234567890   override the configured chat
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDatabase, messages, PIPELINE_LOCK_KEY } from "@baton/core/db";
import { loadDotEnv } from "@baton/core";
import type { SeedMessage } from "@baton/core/intake";
import { PLAN_FIXTURE_PATH, TRANSCRIPT_PATH } from "./src/seed/paths.js";
import { loadIdentity, type AccountBinding, type PlanIdentity } from "./src/backfill/identity.js";
import { loadMessages } from "./src/backfill/messages.js";

interface Transcript {
  planVersion: number;
  months: number;
  windowStart: string;
  windowEnd: string;
  accountBindings: AccountBinding[];
  messages: SeedMessage[];
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Reads the repository-root `.env`.
 *
 * `loadDotEnv` rather than `process.loadEnvFile`: the built-in refuses to override a name
 * already in the environment, and counts one set to the empty string as set — so a shell
 * that exports empty placeholders silently beats a correctly filled `.env`, and the error
 * you get names a variable you can see is populated. Only the CLI does this; the worker
 * validates its real environment, because absorbing a stray `.env` inside a container
 * would be a way to write to the wrong database.
 */
function loadEnv(): void {
  loadDotEnv(fileURLToPath(new URL("../.env", import.meta.url)));
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`${name} is not set, and no .env at the repository root supplied it.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  loadEnv();

  const databaseUrl = required("DATABASE_URL");

  // A seeded transcript is a historical import: it predates the bot joining any group,
  // so a real chat id may not exist yet. `--chat-id 0` is the documented placeholder for
  // that case, and it is warned about rather than accepted silently — the live poll loop
  // filters on the configured chat, so messages loaded under a placeholder are invisible
  // to it, and that failure looks like the pipeline having lost the history.
  const configured = process.env["TELEGRAM_CHAT_ID"];
  const chatIdRaw =
    arg("chat-id") ?? (configured === undefined || configured === "" ? undefined : configured);

  if (chatIdRaw === undefined) {
    console.error(
      "No chat id. TELEGRAM_CHAT_ID is unset and --chat-id was not passed.\n" +
        "Pass `--chat-id 0` to load the transcript under the placeholder chat, or set\n" +
        "TELEGRAM_CHAT_ID once the bot is in a real group.",
    );
    process.exit(1);
  }

  const chatId = Number(chatIdRaw);
  if (!Number.isSafeInteger(chatId)) {
    console.error(`Chat id must be an integer, got '${chatIdRaw}'`);
    process.exit(1);
  }

  const plan = JSON.parse(readFileSync(PLAN_FIXTURE_PATH, "utf8")) as PlanIdentity & {
    planVersion: number;
  };

  let transcript: Transcript;
  try {
    transcript = JSON.parse(readFileSync(TRANSCRIPT_PATH, "utf8")) as Transcript;
  } catch {
    console.error(
      `No transcript at ${TRANSCRIPT_PATH}.\nRun \`pnpm seed:transcript\` first — it is gitignored and derived, so a fresh clone has none.`,
    );
    process.exit(1);
  }

  // The transcript records which plan it was rendered from. A mismatch means the plan
  // changed since, so the messages describe a roster that is no longer the roster.
  if (transcript.planVersion !== plan.planVersion) {
    console.error(
      `The transcript was rendered from plan version ${transcript.planVersion}, but the fixture is version ${plan.planVersion}.\nRun \`pnpm seed:transcript\` again.`,
    );
    process.exit(1);
  }

  const db = createDatabase({ url: databaseUrl, max: 1 });

  try {
    // Non-blocking: a backfill queued behind another pipeline task is indistinguishable
    // from one that has hung, so failing loudly is better than waiting quietly.
    const [lock] = await db.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_lock(${PIPELINE_LOCK_KEY}) as locked`,
    );

    if (lock?.locked !== true) {
      console.error(
        "Another pipeline task holds the advisory lock — a worker is probably running. Stop it and retry.",
      );
      process.exit(1);
    }

    try {
      console.log(`backfill: ${transcript.months}-month slice, chat ${chatId}`);
      console.log(`  window      ${transcript.windowStart} → ${transcript.windowEnd}`);

      if (chatId === 0) {
        console.log(
          "  NOTE        chat id 0 is the placeholder — no real Telegram group yet.\n" +
            "              The live poll loop filters on the configured chat, so re-run this\n" +
            "              with --chat-id <real id> once the bot is in a group, or the history\n" +
            "              will be invisible to it.",
        );
      }

      const identity = await loadIdentity(db, plan, transcript.accountBindings, chatId);
      console.log(
        `  identity    ${identity.personIdByPlanId.size} people ` +
          `(+${identity.peopleInserted} new, +${identity.aliasesInserted} aliases, ` +
          `${identity.boundAccounts} bound to Telegram)`,
      );

      const loaded = await loadMessages(db, transcript.messages, {
        chatId,
        personIdByPlanId: identity.personIdByPlanId,
      });

      const kept = loaded.read === 0 ? 0 : Math.round((loaded.candidates / loaded.read) * 100);
      console.log(`  messages    ${loaded.read} read`);
      console.log(`  candidates  ${loaded.candidates} (${kept}% kept for curation)`);
      console.log(`  discarded   ${loaded.discarded} by the pre-filter`);
      console.log(`  unprocessed ${loaded.unprocessed} media with no text`);

      const [stored] = await db.execute<{ total: number }>(
        sql`select count(*)::int as total from ${messages}`,
      );
      console.log(`  in postgres ${stored?.total ?? 0} rows in messages`);

      console.log(
        "\nIntake complete. Curation is stage two and needs a working model call (gate G1):" +
          "\n  candidates go to `ingest` in batches of ten, then one `assess` pass builds the register.",
      );
    } finally {
      await db.execute(sql`select pg_advisory_unlock(${PIPELINE_LOCK_KEY})`);
    }
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

await main();
