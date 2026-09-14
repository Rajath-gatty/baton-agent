/**
 * Identity loading — the plan roster into `people`, `person_aliases` and
 * `app_settings`.
 *
 * This runs before messages, because `messages.sender_person_id` is a foreign key and
 * a seeded message names its sender by plan id. Loading identity from a different plan
 * than the transcript was rendered from is caught by the normaliser rather than
 * silently producing null senders.
 *
 * **Aliases are inserted exactly as the plan holds them, duplicates across people
 * included.** Two volunteers can both be "Priya", and the alias table is deliberately
 * not unique on alias: ambiguity is *detected* by an alias resolving to more than one
 * person, which is precisely when the Cartographer escalates instead of guessing.
 * De-duplicating across people here would delete the signal the identity design turns
 * on.
 *
 * `normalised_alias` is written with `normaliseAlias` from `@baton/core` — the same
 * function the Cartographer matches with. That is the point of it living in core:
 * writing with one normalisation and matching with another would send every mention to
 * the model for clarification, and nothing would look broken.
 *
 * Idempotent. Running backfill twice must not double the roster.
 */

import { and, eq } from "drizzle-orm";
import { appSettings, people, personAliases, type Database } from "@baton/core/db";
import { normaliseAlias, type AliasKind } from "@baton/core";

/** The subset of the plan this module needs. */
export interface PlanIdentity {
  orgName: string;
  timezone: string;
  coordinatorPersonId: string;
  people: readonly {
    id: string;
    displayName: string;
    aliases: readonly { alias: string; kind: AliasKind }[];
    joinedAt: string | null;
    leftAt: string | null;
    isCoordinator: boolean;
  }[];
}

/** Telegram user ids for the demo three, as `seed-transcript.ts` recorded them. */
export interface AccountBinding {
  role: string;
  personId: string;
  telegramUserId: number | null;
}

export interface LoadIdentityResult {
  /** Plan person id → `people` row id. What the normaliser resolves senders against. */
  personIdByPlanId: Map<string, string>;
  peopleInserted: number;
  aliasesInserted: number;
  boundAccounts: number;
}

export async function loadIdentity(
  db: Database,
  plan: PlanIdentity,
  bindings: readonly AccountBinding[],
  chatId: number,
): Promise<LoadIdentityResult> {
  const personIdByPlanId = new Map<string, string>();
  const telegramIdByPlanId = new Map<string, number>();

  for (const binding of bindings) {
    if (binding.telegramUserId !== null) {
      telegramIdByPlanId.set(binding.personId, binding.telegramUserId);
    }
  }

  let peopleInserted = 0;
  let aliasesInserted = 0;

  for (const person of plan.people) {
    const telegramUserId = telegramIdByPlanId.get(person.id);

    // Display name is the natural key here: the plan has no uuid and the roster is
    // fixed, so a re-run must find the same row rather than insert a second one.
    const existing = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.displayName, person.displayName))
      .limit(1);

    let rowId = existing[0]?.id;

    if (rowId === undefined) {
      const inserted = await db
        .insert(people)
        .values({
          displayName: person.displayName,
          // `left` only when the plan says so; everyone else is a current member.
          status: person.leftAt === null ? "member" : "left",
          ...(telegramUserId === undefined ? {} : { telegramUserId }),
          ...(person.joinedAt === null ? {} : { joinedAt: new Date(person.joinedAt) }),
          ...(person.leftAt === null ? {} : { leftAt: new Date(person.leftAt) }),
        })
        .returning({ id: people.id });

      rowId = inserted[0]?.id;
      if (rowId === undefined) {
        throw new Error(`Inserting person '${person.displayName}' returned no id.`);
      }
      peopleInserted += 1;
    } else if (telegramUserId !== undefined) {
      // The binding may have been supplied after a previous run, so adopt it.
      await db.update(people).set({ telegramUserId }).where(eq(people.id, rowId));
    }

    personIdByPlanId.set(person.id, rowId);

    for (const alias of person.aliases) {
      const normalised = normaliseAlias(alias.alias);

      // Unique on (person, normalised alias, kind), so check that triple rather than
      // the written form: "Priya" and "priya!" are the same alias for this person.
      const already = await db
        .select({ id: personAliases.id })
        .from(personAliases)
        .where(
          and(
            eq(personAliases.personId, rowId),
            eq(personAliases.normalisedAlias, normalised),
            eq(personAliases.kind, alias.kind),
          ),
        )
        .limit(1);

      if (already.length === 0) {
        await db.insert(personAliases).values({
          personId: rowId,
          alias: alias.alias,
          normalisedAlias: normalised,
          kind: alias.kind,
        });
        aliasesInserted += 1;
      }
    }
  }

  const coordinatorRowId = personIdByPlanId.get(plan.coordinatorPersonId);
  if (coordinatorRowId === undefined) {
    // Without a coordinator no approval can ever resolve, so this is fatal now rather
    // than at the first high-consequence write.
    throw new Error(
      `The plan names '${plan.coordinatorPersonId}' as coordinator, but that person was not loaded.`,
    );
  }

  // One row, enforced by a check constraint on id = 1. Upserted so a re-run updates it.
  const values = {
    chatId,
    orgName: plan.orgName,
    timezone: plan.timezone,
    coordinatorPersonId: coordinatorRowId,
    updatedAt: new Date(),
  };

  await db
    .insert(appSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: appSettings.id, set: values });

  return {
    personIdByPlanId,
    peopleInserted,
    aliasesInserted,
    boundAccounts: telegramIdByPlanId.size,
  };
}
