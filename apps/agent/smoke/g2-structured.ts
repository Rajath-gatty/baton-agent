/**
 * G2 — structured output through the configured provider.
 *
 * `G1` proved the provider is reachable. This asks the question that decides how
 * defensive the pipeline has to be: **when a cheap model is handed the flattest schema
 * in the system and a deliberately messy batch, how often does it conform on the first
 * attempt?**
 *
 * That number, not a pass or a fail, is the output. It sets `DEFAULT_MAX_ATTEMPTS` in
 * `src/model/structured.ts`, and it is the difference between a backfill that costs one
 * model call per batch and one that costs three.
 *
 * **It runs the real Curator.** `runCurator` is called directly — the same function
 * `ingest` calls — so the system prompt, the request assembly, the schema, the retry
 * loop and the batch-mismatch check are all the shipping ones. A bespoke call here
 * would measure a path nothing uses. What is injected is only the agent *factory*, and
 * only to observe: it wraps the real one, counts invocations, and keeps each attempt's
 * raw text so a first-attempt failure can be re-validated afterwards and reported by
 * the exact key that was wrong.
 *
 * Four outcomes are distinguished, because they imply different fixes:
 *
 *   - **conforming** on the first attempt — nothing to do.
 *   - **repaired** — malformed once, then valid after the validation error was fed
 *     back. This is the retry loop earning its place, and the count is the reason it
 *     exists.
 *   - **exhausted** — invalid after every attempt. `StructuredOutputFailure`. If this
 *     happens at all, the prompt or the schema needs work, not a bigger budget.
 *   - **mismatched** — schema-valid but the wrong batch: a message asked about did not
 *     come back, or one came back that was never asked about. Caught by
 *     `CuratorBatchMismatch`, and worth separating because it is silent data loss
 *     rather than a parse error. In a backfill it would look like the pre-filter had
 *     discarded a message.
 *
 * Costs real tokens: ten batches of four messages. Never part of `pnpm test`.
 *
 * Usage:
 *   pnpm --filter @baton/agent smoke:g2
 *   pnpm --filter @baton/agent smoke:g2 -- --runs 3     fewer runs while iterating
 */

import { fileURLToPath } from "node:url";
import type { Message, TextBlock } from "@strands-agents/sdk";
import { curatorOutputSchema, type IngestContext, type IngestPayload } from "@baton/core";
import { loadDotEnv } from "@baton/core/env";
import { loadConfig, type AgentConfig } from "../src/config.js";
import { CuratorBatchMismatch, runCurator } from "../src/agents/curator.js";
import { DataApiClient } from "../src/tools/data-api.js";
import { TraceCollector } from "../src/model/trace.js";
import {
  defaultAgentFactory,
  extractJsonObject,
  StructuredOutputFailure,
  type AgentFactory,
  type StructuredAgent,
  type StructuredInvocation,
} from "../src/model/structured.js";

const DEFAULT_RUNS = 10;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** See the note in `smoke/g1-provider.ts`: the file wins, and conflicts are printed. */
function loadEnv(): string[] {
  return loadDotEnv(fileURLToPath(new URL("../../../.env", import.meta.url)), { override: true })
    .conflicts;
}

/**
 * A deliberately awkward batch, four messages chosen to stress a different part of the
 * schema each. The point is not to be hard for its own sake — it is that every one of
 * these shapes occurs in the seeded transcript, so a model that cannot handle them
 * cannot run the backfill.
 */
const MESSAGES: IngestPayload["messages"] = [
  {
    // Two records in one sentence — a holding and a dated commitment — plus a relative
    // date that must resolve against the group's timezone rather than UTC, and a
    // sensitive asset that should be flagged as such.
    messageId: "g2-1",
    senderMention: "Priya",
    sentAt: "2026-09-10T14:32:00+05:30",
    text: "i have the clinic's spare key btw, and i'll get the vaccination register updated by next tuesday",
    replyToText: null,
  },
  {
    // Hearsay, an ambiguous short-form mention, and a negation in the same breath.
    // Also names a person only as a role reference, which must not become an alias.
    messageId: "g2-2",
    senderMention: "Arjun",
    sentAt: "2026-09-10T14:40:00+05:30",
    text: "Pri told me the coordinator moved the donation page off her own card, so it's not on her anymore i think",
    replyToText: "who's paying for the donation page right now?",
  },
  {
    // Noise. Returning an empty records array here is a first-class outcome, and a
    // model that invents a fact for this message would fill the register with jokes.
    messageId: "g2-3",
    senderMention: "Meera",
    sentAt: "2026-09-10T14:41:00+05:30",
    text: "haha ok 😅 see you all sunday then",
    replyToText: null,
  },
  {
    // A thanks-list: participation evidence naming several people at once, which is
    // where `subjectMentions` has to carry more than one entry. Also carries a
    // credential, which must be extracted as a claim without the secret becoming the
    // asset name.
    messageId: "g2-4",
    senderMention: "Ravi",
    sentAt: "2026-09-10T15:02:00+05:30",
    text: "big thanks to Meera, Arjun and Fatima for running the sunday camp. also the wifi password at the shelter is Rescue@2026 if anyone needs it",
    replyToText: null,
  },
];

const CONTEXT: IngestContext = {
  org: {
    orgName: "Bengaluru Street Dog Rescue",
    timezone: "Asia/Kolkata",
    now: "2026-09-10T16:00:00+05:30",
  },
  aliases: [
    { personId: "p1", alias: "Priya", kind: "first_name", displayName: "Priya Raghavan" },
    { personId: "p1", alias: "Pri", kind: "nickname", displayName: "Priya Raghavan" },
    { personId: "p2", alias: "Arjun", kind: "first_name", displayName: "Arjun Nair" },
    { personId: "p3", alias: "Meera", kind: "first_name", displayName: "Meera Iyer" },
    { personId: "p4", alias: "Fatima", kind: "first_name", displayName: "Fatima Sheikh" },
    { personId: "p5", alias: "Ravi", kind: "first_name", displayName: "Ravi Kumar" },
  ],
  assets: [
    {
      assetId: "a1",
      kind: "public_presence",
      name: "Donation page",
      normalisedKey: "donation page",
    },
    {
      assetId: "a2",
      kind: "relationship",
      name: "Dr Anand's clinic",
      normalisedKey: "dr anands clinic",
    },
  ],
};

/** What one attempt looked like, kept so a failure can be explained by key. */
interface Attempt {
  raw: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Wraps the real agent factory and records every attempt.
 *
 * Observation only: the agent underneath is the one the container builds, via
 * `defaultAgentFactory`, so nothing about the model call changes. This exists because
 * `callStructured` retries internally and reports only its final value — which is
 * correct for production and useless for measuring, since a repaired run and a
 * first-attempt success are indistinguishable from the outside.
 */
function recordingFactory(attempts: Attempt[]): AgentFactory {
  return (spec) => {
    const agent = defaultAgentFactory(spec);
    return {
      async invoke(prompt: unknown): Promise<StructuredInvocation> {
        const result = await agent.invoke(prompt);
        const usage = result.metrics?.accumulatedUsage;
        attempts.push({
          raw: textOf(result.lastMessage),
          ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
          ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        });
        return result;
      },
      takeSnapshot: (options) => agent.takeSnapshot(options),
      loadSnapshot: (snapshot) => agent.loadSnapshot(snapshot),
    } satisfies StructuredAgent;
  };
}

/** Same rule `callStructured` uses: text blocks only, joined and trimmed. */
function textOf(message: Message): string {
  return message.content
    .filter((block): block is TextBlock => block.type === "textBlock")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Re-validates a recorded attempt to name what was wrong with it.
 *
 * The retry loop already knew this and told the model; it does not surface it to a
 * caller. Recovering it here is what turns "8 of 10" into something actionable — the
 * useful output of this gate is *which key* a given model gets wrong, because that is
 * what a prompt change has to address.
 */
function explain(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    const preview = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    return `not valid JSON — response began ${JSON.stringify(preview)}`;
  }

  const result = curatorOutputSchema.safeParse(parsed);
  if (result.success) {
    // The batch check runs after validation, so a valid attempt that still failed the
    // run failed on message identity rather than on shape.
    return "schema-valid — the run failed on the batch check, not on the schema";
  }

  return result.error.issues
    .slice(0, 4)
    .map(
      (issue) => `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}

type Outcome = "conforming" | "repaired" | "exhausted" | "mismatched" | "errored";

interface RunResult {
  outcome: Outcome;
  attemptCount: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Present when something went wrong, keyed by the failing path where possible. */
  detail?: string;
  /** Present on success: what the model actually decided, as a one-line sanity check. */
  summary?: string;
}

async function runOnce(config: AgentConfig): Promise<RunResult> {
  const attempts: Attempt[] = [];
  const deps = {
    config,
    trace: new TraceCollector(),
    dataApi: new DataApiClient(config.dataApi),
    agentFactory: recordingFactory(attempts),
  };

  const startedAt = Date.now();

  const tokens = (): { inputTokens: number; outputTokens: number } => ({
    inputTokens: attempts.reduce((total, attempt) => total + (attempt.inputTokens ?? 0), 0),
    outputTokens: attempts.reduce((total, attempt) => total + (attempt.outputTokens ?? 0), 0),
  });

  try {
    const output = await runCurator({ messages: MESSAGES }, CONTEXT, deps);
    const durationMs = Date.now() - startedAt;

    const records = output.results.reduce((total, result) => total + result.records.length, 0);
    const noise = output.results.filter((result) => result.classification === "noise").length;
    const summary = `${output.results.length} results, ${noise} noise, ${records} records`;

    if (attempts.length === 1) {
      return { outcome: "conforming", attemptCount: 1, durationMs, ...tokens(), summary };
    }

    // Every attempt but the last one failed validation, so the first is the one worth
    // naming: it is the failure the prompt would have to prevent.
    return {
      outcome: "repaired",
      attemptCount: attempts.length,
      durationMs,
      ...tokens(),
      summary,
      detail: explain(attempts[0]?.raw ?? ""),
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const base = { attemptCount: attempts.length, durationMs, ...tokens() };

    if (error instanceof StructuredOutputFailure) {
      return {
        ...base,
        outcome: "exhausted",
        detail: `${error.attempts} attempts, last error — ${error.lastError}`,
      };
    }

    if (error instanceof CuratorBatchMismatch) {
      return { ...base, outcome: "mismatched", detail: error.message };
    }

    return {
      ...base,
      outcome: "errored",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0);
}

async function main(): Promise<void> {
  const conflicts = loadEnv();
  const config = loadConfig();

  const runsRequested = Number(arg("runs") ?? DEFAULT_RUNS);
  if (!Number.isSafeInteger(runsRequested) || runsRequested < 1) {
    console.error(`--runs must be a positive integer, got '${arg("runs")}'`);
    process.exit(1);
  }

  console.log("G2 — structured output through the configured provider");
  console.log(`  base URL   ${config.model.baseUrl}`);
  console.log(`  model id   ${config.model.curator}`);
  console.log(`  schema     curatorOutputSchema — ${MESSAGES.length} messages per run`);
  console.log(`  runs       ${runsRequested}`);
  if (conflicts.length > 0) {
    console.log(`  NOTE       .env overrode shell values for: ${conflicts.join(", ")}`);
  }
  console.log("");

  const results: RunResult[] = [];

  for (let run = 1; run <= runsRequested; run += 1) {
    const result = await runOnce(config);
    results.push(result);

    const label = result.outcome.toUpperCase().padEnd(10);
    const attemptNote =
      result.attemptCount === 1 ? "1 attempt " : `${result.attemptCount} attempts`;
    console.log(
      `  run ${String(run).padStart(2)}  ${label} ${attemptNote}  ${String(result.durationMs).padStart(6)} ms  ${result.summary ?? ""}`,
    );
    if (result.detail !== undefined) {
      console.log(`           ↳ ${result.detail}`);
    }
  }

  const count = (outcome: Outcome): number =>
    results.filter((result) => result.outcome === outcome).length;

  const conforming = count("conforming");
  const repaired = count("repaired");
  const exhausted = count("exhausted");
  const mismatched = count("mismatched");
  const errored = count("errored");
  const valid = conforming + repaired;

  const latencies = results.map((result) => result.durationMs);
  const inputTokens = results.reduce((total, result) => total + result.inputTokens, 0);
  const outputTokens = results.reduce((total, result) => total + result.outputTokens, 0);
  const attemptTotal = results.reduce((total, result) => total + result.attemptCount, 0);

  const pct = (n: number): string => `${Math.round((n / results.length) * 100)}%`;

  console.log("\n  ── summary ──────────────────────────────────────────────");
  console.log(`  first-attempt conformance  ${conforming}/${results.length}  (${pct(conforming)})`);
  console.log(`  repaired by retry          ${repaired}/${results.length}`);
  console.log(`  never conformed            ${exhausted}/${results.length}`);
  console.log(`  wrong batch returned       ${mismatched}/${results.length}`);
  console.log(`  transport or other error   ${errored}/${results.length}`);
  console.log(
    `  model calls spent          ${attemptTotal} for ${results.length} runs ` +
      `(${(attemptTotal / results.length).toFixed(2)} per run)`,
  );
  console.log(
    `  latency                    median ${median(latencies)} ms, ` +
      `min ${Math.min(...latencies)} ms, max ${Math.max(...latencies)} ms`,
  );
  console.log(`  tokens                     in ${inputTokens} / out ${outputTokens}`);

  if (inputTokens === 0 && outputTokens === 0) {
    console.log(
      "  NOTE       the provider reported no token usage. `model/trace.ts` writes these\n" +
        "             into the trace and the activity panel renders them, so both will read\n" +
        "             zero until usage is reported or derived another way.",
    );
  }

  console.log("");

  if (valid < results.length) {
    console.error(
      `FAIL — ${results.length - valid} of ${results.length} runs produced no usable output.\n` +
        "A bigger attempt budget is the wrong fix: flatten the schema or tighten the prompt.",
    );
    process.exit(1);
  }

  console.log(`PASS — every run produced schema-conforming output.`);

  // The recommendation, because the raw rate is easy to read and easy to misread.
  if (conforming === results.length) {
    console.log(
      "  This model conforms first time on every run. The retry loop is insurance, not\n" +
        "  a dependency, and backfill cost is one call per batch.",
    );
  } else if (conforming >= Math.ceil(results.length * 0.7)) {
    console.log(
      `  ${repaired} run(s) needed the validation error fed back. DEFAULT_MAX_ATTEMPTS=3 is\n` +
        "  comfortable; budget roughly " +
        `${(attemptTotal / results.length).toFixed(2)}× the calls for a backfill.`,
    );
  } else {
    console.log(
      "  Fewer than 70% conform first time, so the pipeline is leaning on retries and a\n" +
        "  backfill will cost proportionally more. The failing keys above are where a\n" +
        "  prompt change pays for itself.",
    );
  }

  console.log("\nNext: G7, Curator latency on a batch of ten.");
}

await main();
