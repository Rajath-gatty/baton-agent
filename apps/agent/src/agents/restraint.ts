/**
 * Restraint. `[F18]`
 *
 * Judges each item another agent produced and answers one question: should Baton say
 * this at all? Surface, or withhold with a reason that becomes a `quiet_decisions`
 * row.
 *
 * This file is the model call. *Where* it is attached — the produce path of all three
 * producing tasks, so it cannot be routed around — lives in `produce/gate.ts`, and
 * that separation is the point: the veto's scope is a property of the container's
 * wiring rather than of any one graph.
 *
 * Two invariants beyond the schema are enforced here:
 *
 *   - **Every item asked about gets a decision.** An item the model silently omitted
 *     would otherwise be surfaced by default, which is the wrong direction to fail
 *     in. Missing decisions default to withheld.
 *   - **A decision may not be invented.** An `itemRef` that was not asked about is
 *     discarded, or a hallucinated ref could withhold a real item by collision.
 */

import {
  RESTRAINT_SYSTEM_PROMPT,
  restraintOutputSchema,
  type QuietDecisionScope,
  type RestraintDecisionEntry,
  type RestraintOutput,
} from "@baton/core";
import { callStructured } from "../model/structured.js";
import { buildInput, factoryOption, section, type AgentDeps } from "./shared.js";

/** One item put to Restraint. Deliberately uniform across the three produce paths. */
export interface RestraintItem {
  /** A finding's dedupe key, a brief line's position, or the question id an answer replies to. */
  itemRef: string;
  scope: QuietDecisionScope;
  /** The text a human would read, exactly as it would be read. */
  text: string;
  /** Anything that bears on whether saying it is warranted: evidence counts, severity. */
  supporting: Record<string, unknown>;
}

/**
 * Fills in a decision for an item the model did not mention.
 *
 * Defaults to withholding. If Restraint did not judge an item, Baton has not
 * established that saying it is warranted, and the failure that matters here is
 * saying something it should not have — not staying quiet about something it could
 * have said.
 */
function withholdByDefault(item: RestraintItem): RestraintDecisionEntry {
  return {
    itemRef: item.itemRef,
    scope: item.scope,
    decision: "withhold",
    reason: "Not judged by the restraint step, so not established as warranted.",
  };
}

export async function runRestraint(
  items: readonly RestraintItem[],
  deps: AgentDeps,
): Promise<RestraintOutput> {
  if (items.length === 0) {
    deps.trace.addDeterministic("restraint", "Nothing to gate. No model call made.");
    return { decisions: [] };
  }

  const input = buildInput(
    [section("Items", items)],
    [
      `Decide, for each of the ${items.length} items, whether Baton should say it.`,
      "Return one decision per item, echoing itemRef and scope exactly.",
      "A withheld item must carry a reason about the item or the organisation, never about a person.",
    ].join(" "),
  );

  const output = await callStructured({
    role: "restraint",
    node: "restraint",
    systemPrompt: RESTRAINT_SYSTEM_PROMPT,
    input,
    schema: restraintOutputSchema,
    config: deps.config,
    trace: deps.trace,
    ...factoryOption(deps),
    // No tools: Restraint judges what it is handed. An agent that could go looking
    // for more evidence would be second-guessing the item rather than gating it.
    reasoningOf: (value) => {
      const withheld = value.decisions.filter((d) => d.decision === "withhold").length;
      return `Reviewed ${value.decisions.length} items, withholding ${withheld}.`;
    },
  });

  const asked = new Map(items.map((item) => [item.itemRef, item]));
  const decided = new Map<string, RestraintDecisionEntry>();

  for (const decision of output.decisions) {
    const item = asked.get(decision.itemRef);
    if (item === undefined) continue;
    // Trust the item's own scope over the model's echo of it: scope drives which
    // produce path a quiet decision is attributed to, and the test that proves the
    // veto still covers all three paths reads that column.
    decided.set(decision.itemRef, { ...decision, scope: item.scope });
  }

  const missing = items.filter((item) => !decided.has(item.itemRef));
  if (missing.length > 0) {
    deps.trace.addDeterministic(
      "restraint:default-withhold",
      `${missing.length} item(s) were not judged and are withheld by default.`,
    );
  }

  return {
    decisions: items.map((item) => decided.get(item.itemRef) ?? withholdByDefault(item)),
  };
}
