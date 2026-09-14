/**
 * G1 — Strands TS with the OpenAI-compatible provider, pointed at a custom base URL.
 *
 * The first Phase 0 gate, and the one everything else rests on: if Strands cannot reach
 * a non-OpenAI provider through a custom `baseURL`, the model layer needs a proxy and
 * every agent's wiring changes. The design lists LiteLLM behind a proxy as the fallback.
 *
 * **It goes through `loadConfig` and `buildModel`, deliberately.** A bespoke
 * `new OpenAIModel({...})` here would prove that *some* construction works while the one
 * we actually ship stayed unproven — which is the failure mode of most smoke tests. This
 * calls the same two functions the container calls, so a pass means the shipping path
 * works and a failure points at the code that has to change.
 *
 * One trivial call, because the question is reachability rather than quality. Structured
 * output is G2, and Curator latency on a batch of ten is G7.
 *
 * Usage:
 *   pnpm --filter @baton/agent smoke:g1
 */

import { fileURLToPath } from "node:url";
import { Agent } from "@strands-agents/sdk";
import { loadDotEnv } from "@baton/core";
import { loadConfig } from "../src/config.js";
import { buildModel, modelIdFor } from "../src/model/provider.js";

/**
 * Reads the repository-root `.env`, letting the file win.
 *
 * `loadDotEnv` rather than `process.loadEnvFile` for two reasons found the hard way here.
 * The built-in will not override a variable already in the environment — including one
 * present as the empty string, which is how this gate first failed with `MODEL_BASE_URL`
 * plainly set in the file. And a shell that exports a stale `DEFAULT_MODEL` made the gate
 * silently test a model that appears nowhere in `.env`. A developer-run diagnostic should
 * exercise the configuration the developer wrote down, so the file wins and any
 * disagreement is printed rather than resolved quietly.
 */
function loadEnv(): string[] {
  const result = loadDotEnv(fileURLToPath(new URL("../../../.env", import.meta.url)), {
    override: true,
  });
  return result.conflicts;
}

/** Redacts all but the last four characters, so a log is safe to paste into an issue. */
function fingerprint(secret: string): string {
  return secret.length <= 4 ? "****" : `****${secret.slice(-4)} (${secret.length} chars)`;
}

async function main(): Promise<void> {
  const conflicts = loadEnv();

  const config = loadConfig();
  const model = "curator" as const;

  console.log("G1 — provider reachability through Strands");
  console.log(`  base URL   ${config.model.baseUrl}`);
  console.log(`  api key    ${fingerprint(config.model.apiKey)}`);
  console.log(`  model id   ${modelIdFor(model, config)}`);

  if (conflicts.length > 0) {
    console.log(
      `  NOTE       your shell exports different values for: ${conflicts.join(", ")}.\n` +
        "             The .env file was used. Unset them in the shell to avoid surprises.",
    );
  }
  console.log("");

  const agent = new Agent({
    model: buildModel(model, config),
    systemPrompt: "You are a test harness. Answer in as few words as possible.",
    id: "g1",
    printer: false,
  });

  const startedAt = Date.now();

  try {
    const result = await agent.invoke("Reply with exactly: BATON G1 OK");
    const elapsed = Date.now() - startedAt;

    const text = result.lastMessage.content
      .filter((block): block is { type: "textBlock"; text: string } => block.type === "textBlock")
      .map((block) => block.text)
      .join("")
      .trim();

    const usage = result.metrics?.accumulatedUsage;

    console.log("PASS — the provider accepted a custom base URL through Strands.");
    console.log(`  stopReason ${result.stopReason}`);
    console.log(`  latency    ${elapsed} ms`);
    console.log(`  tokens     in ${usage?.inputTokens ?? "?"} / out ${usage?.outputTokens ?? "?"}`);
    console.log(`  reply      ${JSON.stringify(text)}`);

    if (text === "") {
      // A reachable provider that returns no text is not a pass: every agent parses text.
      console.error(
        "\nFAIL — the call succeeded but returned no text block. Structured output (G2) cannot work.",
      );
      process.exit(1);
    }

    console.log("\nG1 passes. Next: G2, structured output through the same provider.");
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    console.error(`FAIL — after ${elapsed} ms`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);

    if (error instanceof Error && error.stack !== undefined) {
      console.error("\nStack:");
      console.error(error.stack.split("\n").slice(0, 12).join("\n"));
    }

    console.error(
      "\nIf the provider rejected the base URL or the request shape, the fallback in the" +
        "\ntechnical design is LiteLLM behind a proxy, with MODEL_BASE_URL pointed at it.",
    );
    process.exit(1);
  }
}

await main();
