/**
 * Shared types for the store layer.
 *
 * Every store function takes an executor rather than reaching for a module-level
 * client. That is what lets a caller compose several writes into one transaction —
 * intake persisting a message and resolving its sender is two writes that must not
 * half-land — without the store functions knowing whether they are in one.
 */

import type { Database } from "@baton/core/db";

/** The transaction object Drizzle hands to a `db.transaction` callback. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * A connection or a transaction. Store functions accept this so they compose.
 *
 * Drizzle's transaction object is not assignable to `Database` — it has no
 * `transaction` of its own in the same shape — so the union is stated explicitly
 * rather than pretending one is the other.
 */
export type Executor = Database | Transaction;
