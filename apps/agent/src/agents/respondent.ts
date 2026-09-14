/**
 * The Respondent. `[F20]` `[F21]`
 *
 * One call over the hydrated fact index — a couple of hundred claims, a few thousand
 * tokens — which is precisely why this system has no vector store.
 *
 * Its three non-answer branches are its most valuable outputs, and each is corrected
 * here against the data rather than trusted from the model:
 *
 *   - **Age is recomputed.** `ageDays` comes from the fact index, which the worker
 *     computed against the group's timezone. A model doing date arithmetic gets it
 *     wrong occasionally, and "five months old" being wrong makes the staleness
 *     warning worse than absent.
 *   - **Staleness is re-derived from that age.** An answer the model called fresh but
 *     which rests on a claim past the threshold is reclassified as stale. The whole
 *     point of `stale_answer` being a branch rather than a phrasing is that it cannot
 *     be lost to a prompt revision.
 *   - **Cited claims must exist.** A fact id that was not in the index is dropped,
 *     because provenance that does not resolve is worse than none: it renders as a
 *     link a coordinator clicks and finds nothing behind.
 */

import {
  RESPONDENT_SYSTEM_PROMPT,
  respondentOutputSchema,
  type RespondContext,
  type RespondPayload,
  type RespondentOutput,
} from "@baton/core";
import { callStructured } from "../model/structured.js";
import { buildInput, factoryOption, section, type AgentDeps } from "./shared.js";
import { toolsFor } from "../tools/index.js";

/**
 * Recomputes age and staleness from the fact index, and drops citations that do not
 * resolve.
 *
 * Exported for testing: this is the correction step, and it is worth asserting
 * directly that a model claiming freshness over a five-month-old claim is overruled.
 */
export function reconcileWithIndex(
  reply: RespondentOutput,
  context: RespondContext,
): RespondentOutput {
  const byId = new Map(context.factIndex.map((entry) => [entry.factId, entry]));

  const factIds = reply.factIds.filter((id) => byId.has(id));
  const cited = factIds.map((id) => byId.get(id)).filter((entry) => entry !== undefined);

  if (cited.length === 0) {
    // Nothing it cited exists. Whatever it said, Baton cannot stand behind it.
    return {
      ...reply,
      outcome: "unknown",
      answerText: null,
      factIds: [],
      evidenceMessageIds: [],
      ageDays: null,
      reasoning: `${reply.reasoning} (Reclassified as unknown: no cited claim resolved.)`,
    };
  }

  // The oldest claim an answer rests on governs its age. An answer built from a fresh
  // claim and a five-month-old one is only as current as the older half.
  const ageDays = Math.max(...cited.map((entry) => entry.ageDays));
  const isStale = ageDays > context.staleThresholdDays;

  const outcome =
    (reply.outcome === "answer" || reply.outcome === "stale_answer") && isStale
      ? "stale_answer"
      : reply.outcome;

  const evidenceMessageIds = [...new Set(cited.flatMap((entry) => entry.evidenceMessageIds))];

  return {
    ...reply,
    outcome,
    factIds,
    evidenceMessageIds,
    ageDays: outcome === "answer" || outcome === "stale_answer" ? ageDays : reply.ageDays,
  };
}

export async function runRespondent(
  payload: RespondPayload,
  context: RespondContext,
  deps: AgentDeps,
): Promise<RespondentOutput> {
  const input = buildInput(
    [
      section("Group", {
        organisation: context.org.orgName,
        currentDate: context.org.now,
        timezone: context.org.timezone,
      }),
      section("The question", {
        text: payload.questionText,
        askedBy: payload.askedByMention,
      }),
      section("Everything Baton knows", context.factIndex),
      section("Known people", context.aliases),
      section("Constraints", {
        staleAfterDays: context.staleThresholdDays,
        mayAskTheGroupANewQuestion: context.askBudgetAvailable,
      }),
    ],
    [
      "Answer the question using only the claims above.",
      "Cite the factIds you used. Never cite an id that does not appear above.",
      "Choose unknown rather than assembling an answer the claims do not support.",
    ].join(" "),
  );

  const reply = await callStructured({
    role: "respondent",
    node: "respondent",
    systemPrompt: RESPONDENT_SYSTEM_PROMPT,
    input,
    schema: respondentOutputSchema,
    config: deps.config,
    trace: deps.trace,
    ...factoryOption(deps),
    tools: toolsFor("respondent", { dataApi: deps.dataApi, trace: deps.trace }),
    reasoningOf: (value) => `Answered as '${value.outcome}' from ${value.factIds.length} claim(s).`,
  });

  const reconciled = reconcileWithIndex(reply, context);

  if (reconciled.outcome !== reply.outcome) {
    deps.trace.addDeterministic(
      "respondent:reconcile",
      `Reclassified from '${reply.outcome}' to '${reconciled.outcome}' against the register's own dates.`,
    );
  }

  return reconciled;
}
