/**
 * The `agent_sessions` table. `[F32]`
 *
 * **The snapshot lives in Postgres, not on AWS**, and that is what keeps the agent
 * container stateless and credential-free. A node stops mid-graph to ask the coordinator
 * something; hours later the worker calls `resume` with this row's contents and the answer,
 * and the node picks up from the interruption point in a container that has no memory of
 * the original request.
 *
 * Only one thing here is subtle. **A session is resumed exactly once.** The status column
 * is what enforces it, and the reason is that resuming twice re-runs the node from the same
 * interruption point with the same answer — which for a node that writes would apply the
 * approved change twice, and for one that speaks would say the same thing to the group
 * twice. Neither is recoverable by retrying.
 */

import { and, eq, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import type { AgentSessionStatus, AgentTask } from "@baton/core";
import type { Executor } from "./types.js";

const { agentSessions } = schema;

export interface StoreSessionInput {
  /** The task that was interrupted, so `resume` can rebuild the right agent. */
  task: AgentTask;
  snapshot: unknown;
  runId: string | null;
  /** Strands' own session identifier, where the transport reported one. */
  strandsSessionId?: string | null;
}

/** Stores a snapshot and returns the session id. */
export async function storeSession(
  db: Executor,
  { task, snapshot, runId, strandsSessionId = null }: StoreSessionInput,
): Promise<string> {
  const rows = await db
    .insert(agentSessions)
    .values({
      task,
      snapshot: snapshot ?? {},
      runId,
      strandsSessionId,
      status: "open",
    })
    .returning({ id: agentSessions.id });

  const row = rows[0];
  if (row === undefined) throw new Error(`Failed to store a ${task} session`);
  return row.id;
}

export interface AgentSessionRow {
  id: string;
  task: AgentTask;
  snapshot: unknown;
  status: AgentSessionStatus;
  strandsSessionId: string | null;
  runId: string | null;
}

/** Reads a session back, whatever its status. */
export async function findSession(
  db: Executor,
  sessionId: string,
): Promise<AgentSessionRow | null> {
  const rows = await db
    .select({
      id: agentSessions.id,
      task: agentSessions.task,
      snapshot: agentSessions.snapshot,
      status: agentSessions.status,
      strandsSessionId: agentSessions.strandsSessionId,
      runId: agentSessions.runId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Claims a session for resuming, once.
 *
 * `where status = 'open' ... returning` means exactly one caller wins. Two ticks racing on
 * the same answered question would otherwise both resume, and the second would re-apply the
 * approved change — which is a duplicate write nobody asked for and nothing detects.
 */
export async function claimSessionForResume(
  db: Executor,
  sessionId: string,
  at: Date,
): Promise<AgentSessionRow | null> {
  const rows = await db
    .update(agentSessions)
    .set({ status: "resumed", resumedAt: at })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, "open")))
    .returning({
      id: agentSessions.id,
      task: agentSessions.task,
      snapshot: agentSessions.snapshot,
      status: agentSessions.status,
      strandsSessionId: agentSessions.strandsSessionId,
      runId: agentSessions.runId,
    });
  return rows[0] ?? null;
}

/**
 * Closes a session.
 *
 * Called after the resumed output has been applied, and also when a session is abandoned —
 * an approval that went obsolete has a snapshot nobody will ever resume, and leaving it
 * `open` would make the count of things Baton is waiting on permanently wrong.
 */
export async function closeSession(db: Executor, sessionId: string, at: Date): Promise<boolean> {
  const rows = await db
    .update(agentSessions)
    .set({ status: "closed", closedAt: at })
    .where(and(eq(agentSessions.id, sessionId), sql`${agentSessions.status} <> 'closed'`))
    .returning({ id: agentSessions.id });
  return rows.length > 0;
}

/** Sessions still holding a snapshot nobody has resumed. For the activity panel. */
export async function countOpenSessions(db: Executor): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(agentSessions)
    .where(eq(agentSessions.status, "open"));
  return Number(rows[0]?.count ?? 0);
}
