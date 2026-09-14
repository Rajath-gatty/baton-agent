/**
 * The Assessor. `[F15]` `[F16]` `[F17]`
 *
 * Consumes the five detection queries' candidates and supplies the part that needs
 * judgment: severity, phrasing, aggregation across a capability area, and a
 * suppression decision. It never counts, groups or filters — SQL has already done
 * that, faster and more reliably than any model would.
 *
 * Because it runs once per changed sweep rather than once per message, it is the
 * cheapest place in the system to spend money on a better model.
 *
 * Two guarantees are enforced here in code rather than hoped for in the prompt:
 *
 *   - **Every returned finding echoes a candidate's `dedupe_key`.** That key is the
 *     upsert target. A model-invented key would insert a duplicate row on every
 *     sweep and would silently resurrect dismissed findings, because dismissals are
 *     recorded against the key.
 *   - **No title names a person.** Checked against the holder names the worker sent,
 *     since only the worker knows the roster. The schema can only enforce that a
 *     title is not empty.
 */

import {
  ASSESSOR_SYSTEM_PROMPT,
  assessorOutputSchema,
  type AssessContext,
  type AssessPayload,
  type AssessorOutput,
} from "@baton/core";
import { callStructured } from "../model/structured.js";
import { buildInput, factoryOption, section, type AgentDeps } from "./shared.js";
import { toolsFor } from "../tools/index.js";

/**
 * Drops findings whose `dedupeKey` was not among the candidates, and strips
 * aggregation references to keys that do not exist.
 *
 * Dropping rather than failing the run: one hallucinated key should not discard the
 * seven good findings that came back with it, and the dropped item is reported in
 * the trace so it is visible rather than silent.
 */
export function keepKnownKeys(
  output: AssessorOutput,
  knownKeys: ReadonlySet<string>,
): { findings: AssessorOutput["findings"]; dropped: string[] } {
  const dropped: string[] = [];
  const findings = output.findings.filter((finding) => {
    if (knownKeys.has(finding.dedupeKey)) return true;
    dropped.push(finding.dedupeKey);
    return false;
  });

  return {
    findings: findings.map((finding) => ({
      ...finding,
      aggregatedDedupeKeys: finding.aggregatedDedupeKeys.filter((key) => knownKeys.has(key)),
    })),
    dropped,
  };
}

/**
 * Finds titles that name a person.
 *
 * Word-boundary matched against the display names and holder names the worker
 * supplied. A substring match would flag "Ravi" inside "travailing"; more to the
 * point, a title is allowed to contain a word that happens to be somebody's name in
 * another context, and the check is only meaningful against the actual roster.
 */
export function titlesNamingPeople(
  findings: readonly { dedupeKey: string; title: string }[],
  personNames: readonly string[],
): string[] {
  const names = personNames
    .flatMap((name) => name.split(/\s+/))
    .map((part) => part.trim())
    .filter((part) => part.length > 2);

  if (names.length === 0) return [];

  const pattern = new RegExp(
    `\\b(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "i",
  );

  return findings.filter((finding) => pattern.test(finding.title)).map((f) => f.dedupeKey);
}

export async function runAssessor(
  payload: AssessPayload,
  context: AssessContext,
  deps: AgentDeps,
): Promise<AssessorOutput> {
  if (payload.candidates.length === 0) {
    deps.trace.addDeterministic("assessor", "No candidates to assess. No model call made.");
    return { findings: [] };
  }

  const input = buildInput(
    [
      section("Group", {
        organisation: context.org.orgName,
        activeMembers: context.activeMemberCount,
        currentDate: context.org.now,
      }),
      section("Open commitments", context.openCommitments),
      section("Candidates found by the database", payload.candidates),
    ],
    [
      `Judge each of the ${payload.candidates.length} candidates.`,
      "Echo each dedupeKey exactly as given — never invent one, and never alter one.",
      "The counting is already done: do not recount holders or coverage.",
      "Titles must be about the capability or the thing, never about a person.",
    ].join(" "),
  );

  const output = await callStructured({
    role: "assessor",
    node: "assessor",
    systemPrompt: ASSESSOR_SYSTEM_PROMPT,
    input,
    schema: assessorOutputSchema,
    config: deps.config,
    trace: deps.trace,
    ...factoryOption(deps),
    tools: toolsFor("assessor", { dataApi: deps.dataApi, trace: deps.trace }),
    reasoningOf: (value) => {
      const suppressed = value.findings.filter((finding) => finding.suppress).length;
      const high = value.findings.filter((finding) => finding.severity === "high").length;
      return `Judged ${value.findings.length} candidates: ${high} high severity, ${suppressed} suppressed.`;
    },
  });

  const knownKeys = new Set(payload.candidates.map((candidate) => candidate.dedupeKey));
  const { findings, dropped } = keepKnownKeys(output, knownKeys);

  if (dropped.length > 0) {
    deps.trace.addDeterministic(
      "assessor:key-check",
      `Dropped ${dropped.length} finding(s) carrying a dedupe key that was not a candidate.`,
    );
  }

  const personNames = payload.candidates
    .map((candidate) => candidate.holderDisplayName)
    .filter((name): name is string => name !== null);

  const offending = titlesNamingPeople(findings, personNames);
  if (offending.length > 0) {
    // Recorded rather than rewritten. Silently editing the title would hide a prompt
    // regression on the one rule this product states out loud, and the phrasing rule
    // is worth a visible failure.
    deps.trace.addDeterministic(
      "assessor:phrasing-check",
      `${offending.length} title(s) name a person, against the phrasing rule: ${offending.join(", ")}.`,
    );
  }

  return { findings };
}
