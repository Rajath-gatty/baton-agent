/**
 * The structured output retry and repair loop.
 *
 * This is the file the whole pipeline runs through: six agents, every task, every
 * worker pass that invokes a model. Until now only `extractJsonObject` was tested —
 * one pure helper out of 368 lines — because `callStructured` built its own model and
 * there was no way in. The seam added for these tests is `agentFactory`.
 *
 * What is asserted here is deliberately *not* "the model returns good output". It is
 * everything Baton does when the model returns bad output, which is the case that
 * decides whether a cheap model is usable at all.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  StructuredOutputFailure,
  NodeInterruptedError,
  callStructured,
} from "../src/model/structured.js";
import { TraceCollector } from "../src/model/trace.js";
import { fakeAgents, interrupt, json } from "./helpers/fake-agent-factory.js";
import { testConfig } from "./helpers/config.js";

/** Small enough to keep the failing path unambiguous in an assertion. */
const schema = z.object({
  verdict: z.enum(["keep", "drop"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

function call(
  harness: ReturnType<typeof fakeAgents>,
  options: { maxAttempts?: number; trace?: TraceCollector } = {},
) {
  const trace = options.trace ?? new TraceCollector();
  return {
    trace,
    promise: callStructured({
      role: "curator",
      node: "curator",
      systemPrompt: "classify",
      input: "the original request",
      schema,
      config: testConfig(),
      trace,
      agentFactory: harness.factory,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      reasoningOf: (value) => value.reasoning,
    }),
  };
}

const VALID = { verdict: "keep", confidence: 0.9, reasoning: "a clear commitment" };

describe("callStructured", () => {
  describe("the happy path", () => {
    it("returns validated output and asks once", async () => {
      const harness = fakeAgents(json(VALID));

      await expect(call(harness).promise).resolves.toEqual(VALID);
      expect(harness.only().prompts).toEqual(["the original request"]);
    });

    it("builds the agent with the role's own model and node id", async () => {
      // Six roles read six environment variables so that the Curator — which runs on
      // every candidate message and dominates cost — can stay cheap while the three
      // agents a judge reads are pointed at something stronger. A node built with the
      // wrong role would silently spend the wrong budget.
      const harness = fakeAgents(json(VALID));
      await call(harness).promise;

      const spec = harness.only().spec;
      expect(spec.role).toBe("curator");
      expect(spec.node).toBe("curator");
      expect(spec.systemPrompt).toBe("classify");
    });

    it("tolerates a fenced response, because re-asking for one is a wasted attempt", async () => {
      const harness = fakeAgents({
        text: "Here is the result:\n```json\n" + JSON.stringify(VALID) + "\n```\nHope that helps.",
      });

      await expect(call(harness).promise).resolves.toEqual(VALID);
      expect(harness.only().prompts).toHaveLength(1);
    });
  });

  describe("repair", () => {
    it("feeds the validation error back naming the field that was wrong", async () => {
      // The entire justification for not using the SDK's `structuredOutputSchema` is
      // that it throws instead of telling the model what to fix. If the retry prompt
      // did not name the path, this file would be a slower version of that.
      const harness = fakeAgents(
        json({ verdict: "maybe", confidence: 0.9, reasoning: "unsure" }),
        json(VALID),
      );

      await expect(call(harness).promise).resolves.toEqual(VALID);

      const [, repair] = harness.only().prompts as string[];
      expect(repair).toContain("verdict");
      expect(repair).toMatch(/did not match the required schema/i);
      // Told not to touch what was already right — otherwise a repair attempt
      // regenerates the whole object and can break a field that had been correct.
      expect(repair).toMatch(/not change anything that was not listed/i);
    });

    it("names every failing field, not just the first", async () => {
      const harness = fakeAgents(json({ verdict: "maybe", confidence: 4 }), json(VALID));

      await expect(call(harness).promise).resolves.toEqual(VALID);

      const repair = (harness.only().prompts as string[])[1]!;
      expect(repair).toContain("verdict");
      expect(repair).toContain("confidence");
      expect(repair).toContain("reasoning");
    });

    it("asks again with a different message when the response was not JSON at all", async () => {
      // Distinguished from a schema failure on purpose: "your JSON was malformed" and
      // "your field was wrong" call for different corrections, and conflating them
      // sends the model looking at the wrong thing.
      const harness = fakeAgents({ text: "I think we should keep it." }, json(VALID));

      await expect(call(harness).promise).resolves.toEqual(VALID);

      const repair = (harness.only().prompts as string[])[1]!;
      expect(repair).toMatch(/not valid JSON/i);
      expect(repair).toMatch(/only the JSON object/i);
    });

    it("reuses one agent across attempts, so the model sees its own rejected output", async () => {
      // A fresh agent per attempt would discard the conversation history that makes
      // the second attempt likely to succeed.
      const harness = fakeAgents(json({ verdict: "maybe" }), json(VALID));
      await call(harness).promise;

      expect(harness.agents).toHaveLength(1);
      expect(harness.only().prompts).toHaveLength(2);
    });
  });

  describe("the attempt budget", () => {
    it("gives up after maxAttempts and reports the last validation error", async () => {
      const bad = json({ verdict: "maybe", confidence: 0.9, reasoning: "no" });
      const harness = fakeAgents(bad, bad);

      await expect(call(harness, { maxAttempts: 2 }).promise).rejects.toThrow(
        StructuredOutputFailure,
      );
      // Exactly two, not three. The fake throws on an unscripted invocation, so an
      // off-by-one here fails loudly rather than silently costing an extra model call.
      expect(harness.only().prompts).toHaveLength(2);
    });

    it("carries the node and attempt count on the failure, for the runs row", async () => {
      const bad = json({ verdict: "maybe" });
      const harness = fakeAgents(bad, bad);

      const error = await call(harness, { maxAttempts: 2 }).promise.catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(StructuredOutputFailure);
      const failure = error as StructuredOutputFailure;
      expect(failure.node).toBe("curator");
      expect(failure.attempts).toBe(2);
      expect(failure.lastError).toContain("verdict");
    });

    it("defaults to three attempts", async () => {
      const bad = json({ verdict: "maybe" });
      const harness = fakeAgents(bad, bad, bad);

      await expect(call(harness).promise).rejects.toThrow(StructuredOutputFailure);
      expect(harness.only().prompts).toHaveLength(3);
    });
  });

  describe("the trace", () => {
    it("records the node, model and token counts on success", async () => {
      const harness = fakeAgents(json(VALID, { inputTokens: 1200, outputTokens: 90 }));
      const { trace, promise } = call(harness);
      await promise;

      const [entry] = trace.toArray();
      expect(entry).toMatchObject({
        node: "curator",
        model: "deepseek-chat",
        inputTokens: 1200,
        outputTokens: 90,
      });
      // Read from configuration because the SDK exposes no model id on its result —
      // so a trace claiming the wrong model would be undetectable at a glance.
      expect(entry?.durationMs).toBeTypeOf("number");
    });

    it("records the agent's own reasoning, pulled by the caller's accessor", async () => {
      const harness = fakeAgents(json(VALID));
      const { trace, promise } = call(harness);
      await promise;

      expect(trace.toArray()[0]?.reasoning).toBe("a clear commitment");
    });

    it("still records a node that failed every attempt", async () => {
      // A node absent from the trace reads as a node that was never reached, which
      // sends whoever is debugging to the wrong part of the pipeline.
      const bad = json({ verdict: "maybe" });
      const harness = fakeAgents(bad, bad);
      const { trace, promise } = call(harness, { maxAttempts: 2 });

      await expect(promise).rejects.toThrow(StructuredOutputFailure);

      const [entry] = trace.toArray();
      expect(entry?.node).toBe("curator");
      expect(entry?.reasoning).toMatch(/failed schema validation after 2 attempts/i);
    });

    it("omits token counts rather than reporting zero when the model gave none", async () => {
      // Zero tokens is a claim about cost. Absent is the truth.
      const harness = fakeAgents(json(VALID));
      const { trace, promise } = call(harness);
      await promise;

      expect(trace.toArray()[0]).not.toHaveProperty("inputTokens");
    });
  });

  describe("interrupts", () => {
    it("throws NodeInterruptedError carrying the interrupts and a snapshot", async () => {
      // Not a failure: this is the approval path. The snapshot is what lets the
      // container stay stateless while the question waits hours in Postgres.
      const harness = fakeAgents(
        interrupt({ id: "int-1", name: "approve_sensitive", reason: { assetId: "a-1" } }),
      );

      const error = await call(harness).promise.catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NodeInterruptedError);
      const held = error as NodeInterruptedError;
      expect(held.node).toBe("curator");
      expect(held.interrupts).toEqual([
        { id: "int-1", name: "approve_sensitive", reason: { assetId: "a-1" } },
      ]);
      expect(held.snapshot).toMatchObject({ fakeSnapshot: "curator" });
      expect(harness.only().snapshotsTaken).toBe(1);
    });

    it("does not retry an interrupt, because it is not a failure", async () => {
      const harness = fakeAgents(interrupt({ id: "int-1", name: "approve_sensitive" }));

      await expect(call(harness).promise).rejects.toThrow(NodeInterruptedError);
      expect(harness.only().prompts).toHaveLength(1);
    });

    it("omits reason when the interrupt carried none", async () => {
      const harness = fakeAgents(interrupt({ id: "int-1", name: "approve_sensitive" }));

      const error = (await call(harness).promise.catch(
        (caught: unknown) => caught,
      )) as NodeInterruptedError;

      expect(error.interrupts[0]).not.toHaveProperty("reason");
    });

    it("holds several interrupts from one node", async () => {
      const harness = fakeAgents(
        interrupt({ id: "a", name: "approve_sensitive" }, { id: "b", name: "approve_closure" }),
      );

      const error = (await call(harness).promise.catch(
        (caught: unknown) => caught,
      )) as NodeInterruptedError;

      expect(error.interrupts.map((held) => held.id)).toEqual(["a", "b"]);
    });
  });
});
