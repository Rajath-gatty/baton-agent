import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema.js";

/**
 * The checklist's marking discipline says an inspection result decays the moment
 * someone edits the file, and a test does not. These are the schema facts the design
 * document calls out by name as load-bearing, asserted rather than eyeballed.
 *
 * Nothing here tests Drizzle. Each assertion corresponds to a specific known failure:
 * a nullable column made `NOT NULL` breaks the finding it represents, a defaulted
 * `asked_at` silently throttles the ask budget to nothing, and a missing index turns
 * the processing loop into a table scan on every message.
 */

const tables = new Map(
  Object.values(schema)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => [getTableName(table), table] as const),
);

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"));
  expect(files.length, "no migration has been generated").toBeGreaterThan(0);
  return files.map((name) => readFileSync(join(MIGRATIONS, name), "utf8")).join("\n");
}

function column(tableName: string, key: string) {
  const table = tables.get(tableName);
  expect(table, `table ${tableName} does not exist`).toBeDefined();
  const columns = getTableColumns(table as PgTable) as Record<string, unknown>;
  const found = columns[key];
  expect(found, `${tableName}.${key} does not exist`).toBeDefined();
  return found as { name: string; notNull: boolean; hasDefault: boolean };
}

describe("schema shape", () => {
  it("defines every table the design document names", () => {
    // One item per table in the checklist. A rename here is a deliberate act, not
    // something to discover from a failing query in the worker.
    expect([...tables.keys()].sort()).toEqual([
      "agent_sessions",
      "app_settings",
      "assets",
      "brief_lines",
      "briefs",
      "capabilities",
      "capability_coverage",
      "commitments",
      "coordinator_state",
      "curator_cache",
      "facts",
      "findings",
      "holdings",
      "messages",
      "pending_changes",
      "people",
      "person_aliases",
      "questions",
      "quiet_decisions",
      "runs",
    ]);
  });
});

describe("columns that must stay nullable", () => {
  it("people.telegram_user_id — most of the roster appears only by name", () => {
    expect(column("people", "telegramUserId").notNull).toBe(false);
  });

  it("holdings.holder_person_id — null is the no-owner finding, not missing data", () => {
    expect(column("holdings", "holderPersonId").notNull).toBe(false);
  });

  it("commitments.owner_person_id — null is an unowned intent", () => {
    expect(column("commitments", "ownerPersonId").notNull).toBe(false);
  });

  it("commitments.deadline — an undated intention is the interesting case", () => {
    expect(column("commitments", "deadline").notNull).toBe(false);
  });

  it("questions.asked_at is nullable and has NO default", () => {
    // A default of insertion time makes the rolling 24-hour window count questions
    // that were never sent, and the ask budget then throttles itself to silence.
    const askedAt = column("questions", "askedAt");
    expect(askedAt.notNull).toBe(false);
    expect(askedAt.hasDefault).toBe(false);
  });
});

describe("columns whose absence causes a specific failure", () => {
  it("facts.match_key is present and required", () => {
    // Without it, every mention of the van keys becomes another active row.
    expect(column("facts", "matchKey").notNull).toBe(true);
  });

  it("facts.supersedes_fact_id and curator_reasoning exist", () => {
    expect(column("facts", "supersedesFactId").name).toBe("supersedes_fact_id");
    expect(column("facts", "curatorReasoning").name).toBe("curator_reasoning");
  });

  it("findings.dedupe_key is present and required", () => {
    // Without it, every sweep duplicates the register or resurrects a dismissal.
    expect(column("findings", "dedupeKey").notNull).toBe(true);
  });

  it("findings carry first-seen, last-seen, dismissal reason and reasoning", () => {
    for (const key of ["firstSeenAt", "lastSeenAt", "dismissalReason", "assessorReasoning"]) {
      expect(column("findings", key)).toBeDefined();
    }
  });

  it("messages carry both prefilter verdict and version", () => {
    // The version is what lets an improved filter re-examine prior discards instead
    // of losing them permanently.
    expect(column("messages", "prefilterVerdict")).toBeDefined();
    expect(column("messages", "prefilterVersion")).toBeDefined();
    expect(column("messages", "curatedAt").notNull).toBe(false);
    expect(column("messages", "contentHash").notNull).toBe(true);
  });

  it("messages carry all four provenance flags", () => {
    for (const key of ["isForwarded", "isEdited", "isWithdrawn", "isUnprocessed"]) {
      expect(column("messages", key).notNull, key).toBe(true);
    }
  });

  it("commitments.asked_once_at exists, so ask-once-then-stop is data not prompt", () => {
    expect(column("commitments", "askedOnceAt")).toBeDefined();
  });

  it("holdings record history and personal resources", () => {
    for (const key of ["acquiredAt", "releasedAt", "isPersonalResource", "holderExternal"]) {
      expect(column("holdings", key), key).toBeDefined();
    }
  });

  it("questions carry the Strands interrupt identity", () => {
    expect(column("questions", "interruptId")).toBeDefined();
    expect(column("questions", "interruptName")).toBeDefined();
  });

  it("runs expose the skipped count and the trace", () => {
    // "Read 400, extracted 3" reads as a broken pipeline unless the 380 the
    // pre-filter never promoted are visible next to it.
    expect(column("runs", "candidatesSkipped")).toBeDefined();
    expect(column("runs", "trace").notNull).toBe(true);
  });
});

describe("constraints and indexes, as generated", () => {
  const sql = migrationSql();

  it("messages are unique on (chat_id, telegram_message_id)", () => {
    // The polling offset may be committed after processing, so reprocessing after a
    // crash is expected. This is what makes intake an upsert instead of a duplicate.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "messages_chat_id_telegram_message_id_key" ON "messages" USING btree \("chat_id","telegram_message_id"\)/,
    );
  });

  it("findings are unique on dedupe_key", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "findings_dedupe_key_key" ON "findings" USING btree \("dedupe_key"\)/,
    );
  });

  it("carries the five indexes the design document names", () => {
    expect(sql).toContain('ON "messages" USING btree ("prefilter_verdict","curated_at")');
    expect(sql).toContain('ON "facts" USING btree ("asset_id","status")');
    expect(sql).toContain('ON "holdings" USING btree ("asset_id","status")');
    expect(sql).toMatch(/ON "findings" USING btree \("status","severity" DESC/);
    // curator_cache's composite primary key *is* the (content_hash, prompt_version)
    // index — a primary key is a unique btree over exactly those columns, in order.
    expect(sql).toContain(
      'CONSTRAINT "curator_cache_pkey" PRIMARY KEY("content_hash","prompt_version")',
    );
  });

  it("keeps app_settings and coordinator_state to one row each", () => {
    // A second app_settings row gives two chat ids and no error.
    expect(sql).toContain('CONSTRAINT "app_settings_single_row" CHECK (id = 1)');
    expect(sql).toContain('CONSTRAINT "coordinator_state_single_row" CHECK (id = 1)');
  });

  it("does not make person_aliases.alias unique", () => {
    // Two volunteers can both be "Priya", and ambiguity must be representable —
    // it is the Cartographer's escalation signal.
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^\n]*ON "person_aliases"[^\n]*\("alias"\)/);
    expect(sql).not.toMatch(
      /CREATE UNIQUE INDEX[^\n]*ON "person_aliases"[^\n]*\("normalised_alias"\)/,
    );
  });
});
