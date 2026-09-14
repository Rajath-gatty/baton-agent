/**
 * The single-row `app_settings` table.
 *
 * Configuration a human sets, plus the record of which chats Baton has already
 * introduced itself to. Distinct from `worker_state`, which is what the process has
 * done, and from `coordinator_state`, which is what a reader has seen.
 *
 * **Env versus this table.** `TELEGRAM_CHAT_ID` and `ORG_TIMEZONE` bootstrap the
 * worker before any row exists; this table is the runtime authority once seeded. The
 * split is forced rather than chosen: `coordinator_person_id` is a `people.id`, and no
 * such row can exist until intake has seen that person send a message.
 */

import { eq, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import type { Executor } from "./types.js";

const { appSettings } = schema;

const SINGLETON_ID = 1;

export interface AppSettings {
  chatId: number | null;
  orgName: string | null;
  timezone: string;
  coordinatorPersonId: string | null;
  introducedChatIds: number[];
}

/** Reads the settings row, or the defaults that stand in before it is seeded. */
export async function getAppSettings(db: Executor): Promise<AppSettings> {
  const rows = await db
    .select({
      chatId: appSettings.chatId,
      orgName: appSettings.orgName,
      timezone: appSettings.timezone,
      coordinatorPersonId: appSettings.coordinatorPersonId,
      introducedChatIds: appSettings.introducedChatIds,
    })
    .from(appSettings)
    .where(eq(appSettings.id, SINGLETON_ID))
    .limit(1);

  const row = rows[0];
  return {
    chatId: row?.chatId ?? null,
    orgName: row?.orgName ?? null,
    // Matches the column default. Relative dates resolve against this, never UTC.
    timezone: row?.timezone ?? "Asia/Kolkata",
    coordinatorPersonId: row?.coordinatorPersonId ?? null,
    introducedChatIds: row?.introducedChatIds ?? [],
  };
}

export interface SeedAppSettingsInput {
  chatId: number;
  orgName?: string;
  timezone?: string;
}

/**
 * Seeds the settings row from configuration, without clobbering what is already there.
 *
 * Called at startup. `coalesce` on the update side means a value a coordinator set
 * later survives a restart, while a column still null gets filled from the
 * environment.
 */
export async function seedAppSettings(
  db: Executor,
  { chatId, orgName, timezone }: SeedAppSettingsInput,
): Promise<void> {
  await db
    .insert(appSettings)
    .values({
      id: SINGLETON_ID,
      chatId,
      ...(orgName === undefined ? {} : { orgName }),
      ...(timezone === undefined ? {} : { timezone }),
    })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: {
        chatId: sql`coalesce(${appSettings.chatId}, excluded.chat_id)`,
        orgName: sql`coalesce(${appSettings.orgName}, excluded.org_name)`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Claims the right to introduce Baton in a chat. `[F22]`
 *
 * Returns true **at most once per chat**, and does the claiming and the recording in
 * one statement so it stays true under concurrency. That matters more than it looks:
 * during testing the bot gets removed and re-added repeatedly, and Telegram can
 * deliver `my_chat_member` more than once for one addition. A read-then-write would
 * introduce Baton twice in the same group, which is the most visible possible way to
 * look broken.
 *
 * The `where` on the conflict branch is what makes it idempotent: if the chat is
 * already recorded, no row is updated and nothing is returned.
 */
export async function claimIntroduction(db: Executor, chatId: number): Promise<boolean> {
  const result = await db.execute<{ id: number }>(sql`
    insert into app_settings (id, chat_id, introduced_chat_ids)
    values (${SINGLETON_ID}, ${chatId}, jsonb_build_array(${chatId}::bigint))
    on conflict (id) do update
      set introduced_chat_ids =
            app_settings.introduced_chat_ids || to_jsonb(${chatId}::bigint),
          updated_at = now()
      where not (app_settings.introduced_chat_ids @> to_jsonb(${chatId}::bigint))
    returning id
  `);

  return [...result].length > 0;
}

/** Assigns the coordinator, the only person who may resolve an approval. */
export async function setCoordinatorPerson(db: Executor, personId: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ id: SINGLETON_ID, coordinatorPersonId: personId })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { coordinatorPersonId: sql`excluded.coordinator_person_id`, updatedAt: sql`now()` },
    });
}
