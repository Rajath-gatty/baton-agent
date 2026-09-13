/**
 * The coverage scanner. Fail-closed, by design.
 *
 * After render, this re-scans the transcript's own output for every row of the coverage
 * table and reports each row, the messages that satisfy it, and any row with none. **A
 * missing row is a non-zero exit, not a warning.** The distinction matters because the
 * failure this prevents is silent: a transcript missing hearsay material does not look
 * broken, it looks fine, and the first sign of trouble is a prompt nobody can evaluate
 * because there is nothing for it to be right about.
 *
 * Three kinds of requirement, because one mechanism would be dishonest for some rows:
 *
 *   - **Patterns** over the rendered text. Every pattern in a row must match, and some
 *     require a minimum count — "one dated promise *and* one undated intention" is two
 *     patterns, and "asked more than once" is a count.
 *   - **Predicates** over the message records, for rows that are about structure rather
 *     than words: a voice note and an image are `mediaKind` values, not phrases.
 *   - **Asserted by plan**, for rows a text scanner cannot honestly verify — that three
 *     exposures really sit inside one capability area. Reported as such and traceable to
 *     the placements that claim them. Weaker than a match, but better than memory.
 *
 * The patterns deliberately quote distinctive phrases from the authored placements. That
 * is the point: if a later model pass paraphrases the planted hearsay message, this check
 * fires rather than the coverage silently evaporating.
 */

import { ASSET_KINDS } from "@baton/core";
import {
  COVERAGE_ROWS,
  type CoverageRow,
  type RenderedMessage,
  type SeedPlan,
} from "./plan-types.js";

interface PatternRequirement {
  label: string;
  pattern: RegExp;
  /** Defaults to 1. Used where the design asks for material "more than once". */
  minMatches?: number;
}

interface PredicateRequirement {
  label: string;
  test: (messages: RenderedMessage[]) => boolean;
}

interface CoverageRule {
  row: CoverageRow;
  /** The design document's wording, so a failure says what is missing in its terms. */
  requirement: string;
  patterns?: PatternRequirement[];
  predicates?: PredicateRequirement[];
}

/** Text of a message as the scanner sees it, including the post-edit text. */
function textOf(message: RenderedMessage): string {
  return [message.text ?? "", message.editedText ?? ""].join("\n");
}

const RULES: CoverageRule[] = [
  {
    row: "durable_fact",
    requirement: "A settlement arrangement, a number printed on something, a named account holder",
    patterns: [
      { label: "settlement arrangement", pattern: /settle at the end of each month/i },
      { label: "number printed on something", pattern: /emergency number on the new posters/i },
      { label: "named account holder", pattern: /registered under my name/i },
    ],
  },
  {
    row: "commitment",
    requirement: "One dated promise and one undated intention",
    patterns: [
      { label: "dated promise", pattern: /I'll call the printers on Tuesday/i },
      { label: "undated intention", pattern: /I'll sort out the poster reprint/i },
    ],
  },
  {
    row: "participation_evidence",
    requirement: "Post-event thanks naming several people, more than once",
    patterns: [
      {
        label: "thanks naming several people",
        pattern: /(?:huge thanks(?: to)?|thanks(?: to)?)\s+[A-Z][a-z]+,\s+[A-Z][a-z]+/i,
        minMatches: 2,
      },
    ],
  },
  {
    row: "lifecycle",
    requirement: "One departure and one arrival inside the seeded window, before the live one",
    patterns: [
      { label: "departure", pattern: /stepping away from the rescue/i },
      { label: "arrival", pattern: /Ananya here/i },
    ],
  },
  {
    row: "noise",
    requirement:
      "Jokes, agreement fragments, logistics chatter, a conditional about something that does not exist",
    patterns: [
      {
        label: "conditional about something that does not exist",
        pattern: /if we ever get a second van/i,
      },
      { label: "agreement fragment", pattern: /^(ok|okay|sure|👍|noted)$/im, minMatches: 3 },
      { label: "joke", pattern: /did NOT agree with that assessment/i },
    ],
  },
  {
    row: "prefilter_recall",
    requirement: "A durable fact buried in an otherwise chatty message",
    patterns: [
      {
        label: "fact buried in chatter",
        pattern: /my scooter has a flat[\s\S]*Green Paws have agreed to sponsor/i,
      },
    ],
  },
  {
    row: "multiple_records_per_message",
    requirement: "One message carrying both a fact and a commitment",
    patterns: [
      {
        label: "fact and commitment together",
        pattern: /adoption agreement template on Sunday\? Also I'll call the printers/i,
      },
    ],
  },
  {
    row: "restatement",
    requirement: "The same fact stated again months later, in different words",
    patterns: [
      {
        label: "restated settlement",
        pattern: /invoice us once a month and we clear it at month end/i,
      },
    ],
  },
  {
    row: "contradiction",
    requirement: "A fact replaced by a later one, the clinic's terms change",
    patterns: [
      { label: "changed terms", pattern: /fifteen days from invoice now, not month end/i },
    ],
  },
  {
    row: "negation",
    requirement: "An arrangement explicitly ended",
    patterns: [{ label: "ended arrangement", pattern: /not renewing the sponsorship/i }],
  },
  {
    row: "hearsay",
    requirement: "Someone relaying what a third party said",
    patterns: [{ label: "relayed claim", pattern: /told me the vet said/i }],
  },
  {
    row: "relative_dates",
    requirement: '"next Tuesday", "end of the month", "last week"',
    patterns: [
      { label: "next Tuesday", pattern: /next Tuesday/i },
      { label: "end of the month", pattern: /end of the month/i },
      { label: "last week", pattern: /last week/i },
    ],
  },
  {
    row: "identity_all_alias_kinds",
    requirement: "Every alias kind: handle, display name, nickname, first name, role reference",
    patterns: [
      { label: "handle", pattern: /@priya_pc/ },
      { label: "display name", pattern: /Priya Raghavan/ },
      { label: "nickname", pattern: /\bMeeru\b/ },
      { label: "first name alone", pattern: /\bPriya has the microchip scanner\b/i },
      { label: "role reference", pattern: /the coordinator said/i },
    ],
  },
  {
    row: "ambiguity_one_name_two_people",
    requirement: "One first name resolving to two different people",
    patterns: [{ label: "ambiguous mention", pattern: /Priya has the microchip scanner/i }],
  },
  {
    row: "six_asset_kinds",
    requirement:
      "At least one each: login, physical item, financial control, relationship, document, public presence",
    patterns: [
      { label: "account_login", pattern: /Instagram login|portal login/i },
      { label: "physical_item", pattern: /microchip scanner|the van\b/i },
      { label: "financial_control", pattern: /donation page|bank account/i },
      { label: "relationship", pattern: /Sunrise Clinic|Green Paws/i },
      { label: "document", pattern: /foster carer list|adoption agreement template|spreadsheet/i },
      { label: "public_presence", pattern: /emergency number|Instagram page|posters/i },
    ],
  },
  {
    row: "transfer_of_holding",
    requirement: "One asset changing hands, so holdings history carries a closed row",
    patterns: [{ label: "handover", pattern: /Handing the microchip scanner over to Farhan/i }],
  },
  {
    row: "personal_resource",
    requirement: "An asset that is actually someone's own property, the van",
    patterns: [{ label: "personal van", pattern: /the van is my own car/i }],
  },
  {
    row: "commitment_closure",
    requirement: "A promise later evidenced as done",
    patterns: [{ label: "evidence of completion", pattern: /Printers sorted/i }],
  },
  {
    row: "capability_coverage",
    requirement:
      "One capability with several observed participants, one with exactly one — a property of the participation pools, asserted by plan and checked in plan.ts",
  },
  {
    row: "aggregation",
    requirement:
      "Three separate exposures inside a single capability area — a semantic claim about foster placement, asserted by plan",
  },
  {
    row: "suppression",
    requirement: "A candidate finding resting on one throwaway mention",
    patterns: [{ label: "throwaway mention", pattern: /Might've left the scanner at the clinic/i }],
  },
  {
    row: "answerable_question",
    requirement: "An operational figure the coordinator is visibly asked more than once",
    patterns: [
      { label: "the figure and the asking", pattern: /sterilisation rate/i, minMatches: 3 },
    ],
  },
  {
    row: "unknown",
    requirement: "A question the transcript deliberately never answers",
    patterns: [{ label: "unanswered question", pattern: /Green Paws contact's number/i }],
  },
  {
    row: "credential_exposure",
    requirement: "A credential-shaped string pasted into the group",
    patterns: [{ label: "pasted credential", pattern: /password is \S+/i }],
  },
  {
    row: "media",
    requirement: "A voice note and an image",
    predicates: [
      {
        label: "a voice note",
        test: (messages) => messages.some((message) => message.mediaKind === "voice"),
      },
      {
        label: "an image",
        test: (messages) => messages.some((message) => message.mediaKind === "photo"),
      },
    ],
  },
  {
    row: "provenance_forwarded_and_edited",
    requirement: "One forwarded message and one later edited",
    predicates: [
      {
        label: "a forwarded message",
        test: (messages) => messages.some((message) => message.isForwarded),
      },
      {
        label: "an edited message",
        test: (messages) =>
          messages.some((message) => message.isEdited && message.editedText !== null),
      },
    ],
  },
];

export interface RowResult {
  row: CoverageRow;
  status: "matched" | "asserted_by_plan" | "missing";
  requirement: string;
  /** Which sub-requirements matched, and how many messages satisfied each. */
  hits: { label: string; count: number }[];
  /** Sub-requirements with no match. Non-empty implies `missing`. */
  gaps: string[];
  /** Plan message ids that claim this row, for traceability on an asserted row. */
  claimedBy: string[];
}

export interface CoverageResult {
  rows: RowResult[];
  missing: CoverageRow[];
}

export function scanCoverage(plan: SeedPlan, messages: RenderedMessage[]): CoverageResult {
  const rows: RowResult[] = [];

  for (const row of COVERAGE_ROWS) {
    const rule = RULES.find((candidate) => candidate.row === row);
    const claimedBy = plan.placements
      .filter((placement) => placement.coverage.includes(row))
      .map((placement) => placement.id);

    if (rule === undefined) {
      rows.push({
        row,
        status: "missing",
        requirement: "no rule defined for this row",
        hits: [],
        gaps: ["the scanner has no rule, so the row cannot be verified at all"],
        claimedBy,
      });
      continue;
    }

    const hits: { label: string; count: number }[] = [];
    const gaps: string[] = [];

    for (const requirement of rule.patterns ?? []) {
      const needed = requirement.minMatches ?? 1;
      const count = messages.filter((message) => {
        // Reset lastIndex: some patterns carry flags that make exec stateful.
        requirement.pattern.lastIndex = 0;
        return requirement.pattern.test(textOf(message));
      }).length;
      if (count >= needed) hits.push({ label: requirement.label, count });
      else gaps.push(`${requirement.label} (${count} of ${needed} required)`);
    }

    for (const requirement of rule.predicates ?? []) {
      if (requirement.test(messages)) hits.push({ label: requirement.label, count: 1 });
      else gaps.push(requirement.label);
    }

    const hasRules = (rule.patterns ?? []).length + (rule.predicates ?? []).length > 0;
    const status: RowResult["status"] = !hasRules
      ? plan.assertedByPlan.includes(row)
        ? "asserted_by_plan"
        : "missing"
      : gaps.length === 0
        ? "matched"
        : "missing";

    rows.push({
      row,
      status,
      requirement: rule.requirement,
      hits,
      gaps:
        status === "missing" && !hasRules
          ? ["no rule and not asserted by plan, so nothing verifies this row"]
          : gaps,
      claimedBy,
    });
  }

  return { rows, missing: rows.filter((row) => row.status === "missing").map((row) => row.row) };
}

/** The report, as text. Written to disk as well as printed, so a failure is diffable. */
export function formatReport(result: CoverageResult, messageCount: number): string {
  const lines: string[] = [];
  lines.push(`Coverage report over ${messageCount} rendered messages.`);
  lines.push("");

  for (const row of result.rows) {
    const marker =
      row.status === "matched"
        ? "ok      "
        : row.status === "asserted_by_plan"
          ? "by plan "
          : "MISSING ";
    lines.push(`${marker} ${row.row}`);
    lines.push(`         ${row.requirement}`);
    for (const hit of row.hits) lines.push(`         + ${hit.label} — ${hit.count} message(s)`);
    for (const gap of row.gaps) lines.push(`         ! ${gap}`);
    if (row.status === "asserted_by_plan") {
      lines.push(`         claimed by ${row.claimedBy.join(", ") || "nothing"}`);
    }
    lines.push("");
  }

  const matched = result.rows.filter((row) => row.status === "matched").length;
  const asserted = result.rows.filter((row) => row.status === "asserted_by_plan").length;
  lines.push(
    `${matched} matched, ${asserted} asserted by plan, ${result.missing.length} missing, of ${COVERAGE_ROWS.length}.`,
  );

  return `${lines.join("\n")}\n`;
}

/** Guards the guard: every coverage row must have a rule or be asserted by plan. */
export function rulesCoverEveryRow(assertedByPlan: readonly CoverageRow[]): CoverageRow[] {
  return COVERAGE_ROWS.filter((row) => {
    const rule = RULES.find((candidate) => candidate.row === row);
    const hasRules =
      rule !== undefined && (rule.patterns ?? []).length + (rule.predicates ?? []).length > 0;
    return !hasRules && !assertedByPlan.includes(row);
  });
}

/** Exported so a test can assert the six asset kinds each have a scanner pattern. */
export const ASSET_KIND_PATTERN_LABELS = ASSET_KINDS.map((kind) => kind as string);
