/**
 * The `people` table.
 *
 * Identity arrives from two directions and they must not fight. Live intake knows a
 * Telegram user id and a display name. The seeded transcript knows a plan id and a
 * display name, and for seventeen of its twenty people no account at all — which is
 * why `people.telegram_user_id` is nullable, and why its unique index is on a
 * nullable column: Postgres allows many nulls there, so seventeen accountless
 * volunteers coexist.
 */

import { eq, inArray, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import { normaliseAlias } from "@baton/core";
import type { AliasKind, PersonStatus } from "@baton/core";
import type { Executor } from "./types.js";

const { people, personAliases } = schema;

export interface UpsertPersonInput {
  telegramUserId: number;
  displayName: string;
}

/**
 * Resolves a Telegram account to a `people` row, creating it if this is the first
 * time the account has been seen.
 *
 * The display name is refreshed on conflict, because someone renaming themselves in
 * Telegram should be quoted by their current name.
 *
 * **`status` is deliberately not touched on conflict.** Membership is owned by the
 * `chat_member` lifecycle path, which is the only thing that actually knows whether
 * someone is in the group. Setting `member` here on every message would silently
 * resurrect a departed volunteer the moment an old message of theirs was reprocessed
 * after a crash — and a resurrected member is a brief that never fires.
 */
export async function upsertPersonByTelegramId(
  db: Executor,
  { telegramUserId, displayName }: UpsertPersonInput,
): Promise<string> {
  const rows = await db
    .insert(people)
    .values({ telegramUserId, displayName, status: "member" })
    .onConflictDoUpdate({
      target: people.telegramUserId,
      set: { displayName: sql`excluded.display_name` },
    })
    .returning({ id: people.id });

  const id = rows[0]?.id;
  if (id === undefined) {
    // Unreachable: the upsert always returns the row it wrote. Stated rather than
    // silently coerced, because a missing id here would corrupt every downstream
    // attribution.
    throw new Error(`Failed to upsert person for telegram user ${telegramUserId}`);
  }
  return id;
}

/**
 * Records that Baton can reach this person directly. `[F24]`
 *
 * A bot cannot open a conversation with someone who has never written to it, so the
 * only way to learn this is to be written to. Until it is set, a brief can only be
 * copyable text for the coordinator to pass on — which is the documented fallback, not
 * a failure.
 *
 * Creates the person if they are unknown: someone may write to the bot privately
 * before ever posting in the group.
 */
export async function recordPrivateChat(
  db: Executor,
  { telegramUserId, displayName, privateChatId }: UpsertPersonInput & { privateChatId: number },
): Promise<string> {
  const rows = await db
    .insert(people)
    .values({ telegramUserId, displayName, privateChatId, status: "unknown" })
    .onConflictDoUpdate({
      target: people.telegramUserId,
      set: {
        displayName: sql`excluded.display_name`,
        privateChatId: sql`excluded.private_chat_id`,
      },
    })
    .returning({ id: people.id });

  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(`Failed to record private chat for telegram user ${telegramUserId}`);
  }
  return id;
}

/** The private chat id for a person, or null when Baton cannot write to them. */
export async function findPrivateChatId(db: Executor, personId: string): Promise<number | null> {
  const rows = await db
    .select({ privateChatId: people.privateChatId })
    .from(people)
    .where(eq(people.id, personId))
    .limit(1);
  return rows[0]?.privateChatId ?? null;
}

/**
 * Words that name a *role* rather than a person.
 *
 * Aliases of this shape are never learned, and the reason is specific: roles change
 * hands. Recording "the coordinator" as an alias for Priya would make every later
 * mention of the coordinator resolve to Priya **exactly**, so when the role passes to
 * someone else the mention resolves confidently to the wrong person and never
 * escalates. A seeded role reference supplied deliberately by the plan is fine; one
 * inferred from a single message is not.
 */
const ROLE_WORDS = new Set([
  "coordinator",
  "treasurer",
  "secretary",
  "president",
  "admin",
  "administrator",
  "organiser",
  "organizer",
  "lead",
  "manager",
  "chair",
  "owner",
]);

/**
 * Guesses what kind of alias a mention is.
 *
 * `displayName` is used for the one distinction that genuinely needs it: a single word
 * matching the start of someone's recorded name is their first name, and a single word
 * that does not is a nickname. Without it every short form would be recorded as a first
 * name, which is wrong about "Pri" and unhelpful in the UI.
 */
export function classifyAlias(mention: string, displayName: string): AliasKind {
  const trimmed = mention.trim();
  if (trimmed.startsWith("@")) return "handle";

  const normalised = normaliseAlias(trimmed);
  const words = normalised.split(" ").filter((word) => word !== "");

  if (trimmed.toLowerCase().startsWith("the ") || words.some((word) => ROLE_WORDS.has(word))) {
    return "role_reference";
  }
  if (words.length > 1) return "display_name";

  const firstName = normaliseAlias(displayName).split(" ")[0] ?? "";
  return words[0] === firstName ? "first_name" : "nickname";
}

export interface LearnAliasInput {
  personId: string;
  /** As written in the message, so provenance quotes match. */
  alias: string;
  displayName: string;
}

/**
 * Records a form someone is referred to by, if it is worth learning.
 *
 * Returns false without writing for a role reference — see {@link ROLE_WORDS}.
 *
 * **A learned misspelling is accepted deliberately.** A mention that reached here by
 * single-character typo matching gets stored, so the same misspelling resolves exactly
 * next time. That is a smaller change than it appears: it already resolved to this
 * person, and if a real person named that later joins, the alias resolves to two people
 * and escalates to a question rather than guessing. Which is the behaviour wanted.
 */
export async function learnAlias(
  db: Executor,
  { personId, alias, displayName }: LearnAliasInput,
): Promise<boolean> {
  const normalisedAlias = normaliseAlias(alias);
  if (normalisedAlias === "") return false;

  const kind = classifyAlias(alias, displayName);
  if (kind === "role_reference") return false;

  const rows = await db
    .insert(personAliases)
    .values({ personId, alias: alias.trim(), normalisedAlias, kind })
    // The schema's unique index is (person_id, normalised_alias, kind), and it is
    // deliberately not unique on the alias alone — two volunteers can both be "Priya",
    // and that collision is the ambiguity signal.
    .onConflictDoNothing({
      target: [personAliases.personId, personAliases.normalisedAlias, personAliases.kind],
    })
    .returning({ id: personAliases.id });

  return rows.length > 0;
}

/**
 * Display names for a set of people, in one query.
 *
 * Alias classification needs the person's recorded name to tell a first name from a
 * nickname, and a batch of ten messages can carry thirty mentions of five people. One
 * lookup rather than thirty.
 */
export async function getPersonDisplayNames(
  db: Executor,
  personIds: readonly string[],
): Promise<Map<string, string>> {
  if (personIds.length === 0) return new Map();

  const rows = await db
    .select({ id: people.id, displayName: people.displayName })
    .from(people)
    .where(inArray(people.id, [...personIds]));

  return new Map(rows.map((row) => [row.id, row.displayName]));
}

/** Looks up a person by Telegram account without creating one. */
export async function findPersonByTelegramId(
  db: Executor,
  telegramUserId: number,
): Promise<string | null> {
  const rows = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.telegramUserId, telegramUserId))
    .limit(1);
  return rows[0]?.id ?? null;
}

export interface BriefSubject {
  id: string;
  displayName: string;
  status: PersonStatus;
  joinedAt: Date | null;
  leftAt: Date | null;
}

/**
 * The subject of a brief.
 *
 * The transition dates come back with the name because the one-brief-per-transition guard is
 * keyed on them, and reading them separately would be a second query for the same row.
 */
export async function findPersonForBrief(
  db: Executor,
  personId: string,
): Promise<BriefSubject | null> {
  const rows = await db
    .select({
      id: people.id,
      displayName: people.displayName,
      status: people.status,
      joinedAt: people.joinedAt,
      leftAt: people.leftAt,
    })
    .from(people)
    .where(eq(people.id, personId))
    .limit(1);
  return rows[0] ?? null;
}
