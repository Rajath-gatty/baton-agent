/**
 * The three agents that had no tests: Curator, Cartographer, Briefer.
 *
 * Each of the three does something after the model returns that the schema cannot
 * check, and each failure would be silent in a different way:
 *
 *   - The **Curator** verifies the batch came back whole. A batch of ten returning
 *     nine drops a message from the backfill, and it looks exactly like the pre-filter
 *     having discarded it.
 *   - The **Cartographer** resolves what it can without a model at all, and escalates
 *     only the ambiguous remainder. If that split broke, the system would still work —
 *     while quietly paying for a model call per mention.
 *   - The **Briefer** answers the empty case without a model, and overwrites the
 *     subject the model echoed back. A model that returned a different person id
 *     would orphan every line from the person the brief is about.
 */

import { describe, expect, it } from "vitest";
import type { AliasEntry, BriefContext, BriefPayload, IngestContext } from "@baton/core";
import { CuratorBatchMismatch, runCurator } from "../src/agents/curator.js";
import { runCartographer } from "../src/agents/cartographer.js";
import { hasMaterial, runBriefer } from "../src/agents/briefer.js";
import { TraceCollector } from "../src/model/trace.js";
import { DataApiClient } from "../src/tools/data-api.js";
import { fakeAgents, json, type FakeAgentHarness } from "./helpers/fake-agent-factory.js";
import { testConfig } from "./helpers/config.js";

const ORG = {
  orgName: "Sunrise Volunteers",
  timezone: "Asia/Kolkata",
  now: "2026-05-02T09:00:00.000Z",
};

function deps(harness?: FakeAgentHarness) {
  const config = testConfig();
  const trace = new TraceCollector();
  return {
    config,
    trace,
    dataApi: new DataApiClient(config.dataApi),
    ...(harness === undefined ? {} : { agentFactory: harness.factory }),
  };
}

function message(messageId: string, text: string) {
  return {
    messageId,
    senderMention: "Anil",
    sentAt: "2026-05-02T08:00:00.000Z",
    text,
    replyToText: null,
  };
}

const INGEST_CONTEXT: IngestContext = { org: ORG, aliases: [], assets: [] };

/** A minimal noise result, which is the shape with the fewest required fields. */
function noiseResult(messageId: string) {
  return { messageId, classification: "noise", records: [], reasoning: "chatter" };
}

describe("the Curator", () => {
  it("returns the output when every message asked about came back", async () => {
    const harness = fakeAgents(json({ results: [noiseResult("m-1"), noiseResult("m-2")] }));

    const output = await runCurator(
      { messages: [message("m-1", "hello"), message("m-2", "hi")] },
      INGEST_CONTEXT,
      deps(harness),
    );

    expect(output.results).toHaveLength(2);
  });

  it("throws when a message is missing, rather than silently dropping it", async () => {
    // This is the whole reason the check exists: the message would vanish from the
    // backfill and look like the pre-filter's doing.
    const harness = fakeAgents(json({ results: [noiseResult("m-1")] }));

    const error = await runCurator(
      { messages: [message("m-1", "hello"), message("m-2", "hi")] },
      INGEST_CONTEXT,
      deps(harness),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CuratorBatchMismatch);
    expect((error as Error).message).toContain("m-2");
  });

  it("throws when the model invents a message id it was never given", async () => {
    const harness = fakeAgents(json({ results: [noiseResult("m-1"), noiseResult("m-99")] }));

    const error = await runCurator(
      { messages: [message("m-1", "hello")] },
      INGEST_CONTEXT,
      deps(harness),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CuratorBatchMismatch);
    expect((error as Error).message).toContain("m-99");
  });

  it("runs with no tools, because its cache key cannot describe register state", async () => {
    // Keyed on content_hash plus prompt_version. An output that depended on what the
    // register held at call time would be cached under a key that does not describe it.
    const harness = fakeAgents(json({ results: [noiseResult("m-1")] }));
    await runCurator({ messages: [message("m-1", "hello")] }, INGEST_CONTEXT, deps(harness));

    expect(harness.only().spec.tools).toBeUndefined();
  });

  it("asks for a result per message, including the noise", async () => {
    const harness = fakeAgents(json({ results: [noiseResult("m-1")] }));
    await runCurator({ messages: [message("m-1", "hello")] }, INGEST_CONTEXT, deps(harness));

    const prompt = harness.only().prompts[0] as string;
    expect(prompt).toMatch(/independently/i);
    expect(prompt).toMatch(/including the ones that are noise/i);
  });
});

describe("the Cartographer", () => {
  const aliases: AliasEntry[] = [
    { personId: "p-1", alias: "Priya", kind: "first_name", displayName: "Priya Chandran" },
    { personId: "p-2", alias: "Anil", kind: "first_name", displayName: "Anil Kumar" },
    { personId: "p-3", alias: "Anita", kind: "first_name", displayName: "Anita Rao" },
  ];

  function curated(holderMention: string | null) {
    return {
      results: [
        {
          messageId: "m-1",
          classification: "durable_fact" as const,
          reasoning: "a holding",
          records: [
            {
              kind: "durable_fact" as const,
              claim: "Priya has the clinic keys",
              confidence: 0.9,
              assetKind: "physical_item" as const,
              assetName: "clinic keys",
              sensitivity: "normal" as const,
              holderMention,
              subjectMentions: [],
              capabilityName: null,
              deadlineText: null,
              deadlineDate: null,
              isHearsay: false,
              isNegation: false,
              lifecycleKind: null,
            },
          ],
        },
      ],
    };
  }

  it("resolves an exact alias match without calling a model at all", async () => {
    // The cost case. Every mention that the alias table settles is a model call not
    // made, and there is no fake scripted here — an escalation would throw.
    const harness = fakeAgents();
    const scoped = deps(harness);

    const output = await runCartographer(curated("Priya"), aliases, scoped);

    expect(harness.agents).toHaveLength(0);
    expect(output.attributions).toHaveLength(1);
    expect(output.attributions[0]).toMatchObject({
      resolution: "resolved",
      personId: "p-1",
      confidence: 1,
    });
    expect(scoped.trace.toArray()[0]?.reasoning).toMatch(/no model call needed/i);
  });

  it("records a deterministic match at less than full confidence when it was not exact", async () => {
    // An exact alias match is certain; a typo match is very likely but not the same
    // thing, and the register carries the difference.
    const harness = fakeAgents();
    const output = await runCartographer(curated("Priyaa"), aliases, deps(harness));

    expect(output.attributions[0]).toMatchObject({ personId: "p-1", confidence: 0.9 });
    expect(harness.agents).toHaveLength(0);
  });

  it("escalates an ambiguous mention and tells the model why matching failed", async () => {
    // "Matched nobody" and "matched three people" call for different answers, so the
    // reason is in the prompt rather than left to be re-derived.
    const harness = fakeAgents(
      json({
        attributions: [
          {
            recordIndex: 0,
            mention: "An",
            resolution: "ambiguous",
            personId: null,
            candidatePersonIds: ["p-2", "p-3"],
            externalName: null,
            isPersonalResource: false,
            confidence: 0.4,
            reasoning: "two people match",
          },
        ],
      }),
    );

    const output = await runCartographer(curated("An"), aliases, deps(harness));

    const prompt = harness.only().prompts[0] as string;
    expect(prompt).toMatch(/automaticMatchResult/);
    expect(output.attributions).toHaveLength(1);
    expect(output.attributions[0]?.resolution).toBe("ambiguous");
  });

  it("returns nothing to attribute when no record carried a mention", async () => {
    const harness = fakeAgents();
    const output = await runCartographer(curated(null), aliases, deps(harness));

    expect(output.attributions).toEqual([]);
    expect(harness.agents).toHaveLength(0);
  });
});

describe("the Briefer", () => {
  const payload: BriefPayload = {
    kind: "departure",
    subjectPersonId: "p-1",
    subjectDisplayName: "Priya Chandran",
  };

  const EMPTY: BriefContext = {
    org: ORG,
    holdings: [],
    openCommitments: [],
    coverage: [],
  };

  const WITH_HOLDING: BriefContext = {
    ...EMPTY,
    holdings: [
      {
        holdingId: "h-1",
        assetId: "a-1",
        assetName: "clinic keys",
        assetKind: "physical_item",
        assetSensitivity: "normal",
        isPersonalResource: false,
        otherActiveHolders: 0,
        evidenceFactIds: ["f-1"],
        evidenceMessageIds: ["m-1"],
      },
    ],
  };

  it("writes the empty brief without a model call", async () => {
    // Asking a model to write "there is nothing here" spends a call and risks it
    // inventing something to fill the space.
    const harness = fakeAgents();
    const scoped = deps(harness);

    const output = await runBriefer(payload, EMPTY, scoped);

    expect(harness.agents).toHaveLength(0);
    expect(output.isEmpty).toBe(true);
    expect(output.lines).toEqual([]);
    expect(output.openingLine).toContain("Priya Chandran");
    expect(scoped.trace.toArray()[0]?.node).toBe("briefer");
  });

  it("says the arrival case differently, from the same generator", async () => {
    const harness = fakeAgents();
    const output = await runBriefer({ ...payload, kind: "arrival" }, EMPTY, deps(harness));

    expect(output.kind).toBe("arrival");
    expect(output.openingLine).toMatch(/joined/i);
  });

  it("hasMaterial is false only when all three sections are empty", () => {
    expect(hasMaterial(EMPTY)).toBe(false);
    expect(hasMaterial(WITH_HOLDING)).toBe(true);
  });

  it("overwrites the subject and kind the model echoed back", async () => {
    // A model returning a different person id would orphan every line from the person
    // the brief is about. The worker supplied the id from a Telegram event; it wins.
    const harness = fakeAgents(
      json({
        kind: "arrival",
        subjectPersonId: "p-999",
        openingLine: "Priya Chandran has left the group.",
        isEmpty: false,
        lines: [
          {
            section: "only_they_held",
            text: "The clinic keys have no other holder.",
            evidenceFactIds: ["f-1"],
            evidenceMessageIds: ["m-1"],
            subjectAssetId: "a-1",
            subjectCapabilityId: null,
            subjectCommitmentId: null,
          },
        ],
        reasoning: "one holding",
      }),
    );

    const output = await runBriefer(payload, WITH_HOLDING, deps(harness));

    expect(output.subjectPersonId).toBe("p-1");
    expect(output.kind).toBe("departure");
  });

  it("tells the model to name the person once and never invent an evidence id", async () => {
    const harness = fakeAgents(
      json({
        kind: "departure",
        subjectPersonId: "p-1",
        openingLine: "Priya Chandran has left the group.",
        isEmpty: false,
        lines: [
          {
            section: "only_they_held",
            text: "The clinic keys have no other holder.",
            evidenceFactIds: ["f-1"],
            evidenceMessageIds: ["m-1"],
            subjectAssetId: "a-1",
            subjectCapabilityId: null,
            subjectCommitmentId: null,
          },
        ],
        reasoning: "one holding",
      }),
    );

    await runBriefer(payload, WITH_HOLDING, deps(harness));

    const prompt = harness.only().prompts[0] as string;
    expect(prompt).toMatch(/never invent an evidence id/i);
    expect(prompt).toMatch(/name the person once/i);
  });
});
