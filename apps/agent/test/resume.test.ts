/**
 * The resume path — a node restored from a snapshot, hours later.
 *
 * This is the mechanism behind the whole approval round trip: a node stops to ask the
 * coordinator something, the worker stores the snapshot in `agent_sessions` and the
 * question in `questions`, and the container forgets everything. When the answer
 * arrives it may be a different container entirely. That is what "the agent is
 * stateless" actually means, and it is worth testing precisely because nothing in the
 * pipeline raises an interrupt yet — the code is written against a path no live
 * traffic has taken, so the tests are the only thing holding it honest.
 *
 * `runResume`'s three refusals are tested too. Each is a case where continuing would
 * produce something worse than an error: re-asking a question the group already
 * answered, or resuming a node that never asked anything.
 */

import { describe, expect, it } from "vitest";
import {
  NodeInterruptedError,
  StructuredOutputFailure,
  resumeStructured,
  type SchemaValidator,
} from "../src/model/structured.js";
import { TraceCollector } from "../src/model/trace.js";
import { NotResumable, runResume } from "../src/tasks/resume.js";
import { DataApiClient } from "../src/tools/data-api.js";
import { fakeAgents, interrupt, json } from "./helpers/fake-agent-factory.js";
import { testConfig } from "./helpers/config.js";

/**
 * A stand-in schema, so these tests assert the resume mechanism rather than any one
 * task's shape. Typed explicitly as `SchemaValidator<unknown>` because that is the
 * contract `resumeStructured` widens to — the worker re-validates against the real
 * schema from `@baton/core` before it writes anything.
 */
const schema: SchemaValidator<unknown> = {
  safeParse(input: unknown) {
    const value = input as { ok?: boolean };
    return value.ok === true
      ? { success: true, data: value }
      : { success: false, error: { issues: [{ path: ["ok"], message: "must be true" }] } };
  },
};

function deps() {
  const config = testConfig();
  return {
    config,
    trace: new TraceCollector(),
    dataApi: new DataApiClient(config.dataApi),
  };
}

describe("resumeStructured", () => {
  it("loads the stored snapshot before invoking, not after", async () => {
    // Invoking first would run the node from scratch and raise the same interrupt
    // again — the group would be asked a question it had already answered.
    const harness = fakeAgents(json({ ok: true }));
    const snapshot = { agent: "assessor", messages: 12 };

    await resumeStructured({
      role: "assessor",
      node: "assessor",
      systemPrompt: "assess",
      snapshot,
      answers: [{ interruptId: "int-1", approved: true }],
      schema,
      config: testConfig(),
      trace: new TraceCollector(),
      agentFactory: harness.factory,
    });

    expect(harness.only().loadedSnapshot).toEqual(snapshot);
  });

  it("passes the human's answer through verbatim rather than rewording it", async () => {
    // A resume that rewrote the answer would be deciding the thing it was waiting to
    // be told.
    const harness = fakeAgents(json({ ok: true }));

    await resumeStructured({
      role: "assessor",
      node: "assessor",
      systemPrompt: "assess",
      snapshot: {},
      answers: [
        { interruptId: "int-1", approved: true, answerText: "Yes, Meera has the keys now." },
      ],
      schema,
      config: testConfig(),
      trace: new TraceCollector(),
      agentFactory: harness.factory,
    });

    expect(harness.only().prompts[0]).toEqual([
      {
        interruptResponse: {
          interruptId: "int-1",
          response: { approved: true, answer: "Yes, Meera has the keys now." },
        },
      },
    ]);
  });

  it("omits the answer text when the human only pressed a button", async () => {
    const harness = fakeAgents(json({ ok: true }));

    await resumeStructured({
      role: "assessor",
      node: "assessor",
      systemPrompt: "assess",
      snapshot: {},
      answers: [{ interruptId: "int-1", approved: false }],
      schema,
      config: testConfig(),
      trace: new TraceCollector(),
      agentFactory: harness.factory,
    });

    const [[sent]] = harness.only().prompts as [[{ interruptResponse: { response: object } }]];
    expect(sent.interruptResponse.response).toEqual({ approved: false });
  });

  it("marks the trace entry as resumed, so the panel does not show the node twice", async () => {
    const harness = fakeAgents(json({ ok: true }, { inputTokens: 400, outputTokens: 30 }));
    const trace = new TraceCollector();

    await resumeStructured({
      role: "assessor",
      node: "assessor",
      systemPrompt: "assess",
      snapshot: {},
      answers: [{ interruptId: "int-1", approved: true }],
      schema,
      config: testConfig(),
      trace,
      agentFactory: harness.factory,
    });

    const [entry] = trace.toArray();
    expect(entry?.node).toBe("assessor:resumed");
    expect(entry).toMatchObject({ inputTokens: 400, outputTokens: 30 });
    expect(entry?.reasoning).toMatch(/resumed from a snapshot with 1 answer/i);
  });

  it("holds a second interrupt rather than treating it as a failure", async () => {
    // One approval can legitimately uncover another. Handled the same way: hold and
    // ask, with a fresh snapshot.
    const harness = fakeAgents(interrupt({ id: "int-2", name: "approve_closure" }));

    const error = await resumeStructured({
      role: "assessor",
      node: "assessor",
      systemPrompt: "assess",
      snapshot: {},
      answers: [{ interruptId: "int-1", approved: true }],
      schema,
      config: testConfig(),
      trace: new TraceCollector(),
      agentFactory: harness.factory,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NodeInterruptedError);
    expect((error as NodeInterruptedError).interrupts[0]?.id).toBe("int-2");
    expect(harness.only().snapshotsTaken).toBe(1);
  });

  it("does not retry a resume that failed validation", async () => {
    // Unlike the first call, a resume gets one attempt: the model is answering a
    // human, and a repair loop here would re-ask against an answer already given.
    const harness = fakeAgents(json({ ok: false }));

    await expect(
      resumeStructured({
        role: "assessor",
        node: "assessor",
        systemPrompt: "assess",
        snapshot: {},
        answers: [{ interruptId: "int-1", approved: true }],
        schema,
        config: testConfig(),
        trace: new TraceCollector(),
        agentFactory: harness.factory,
      }),
    ).rejects.toThrow(StructuredOutputFailure);

    expect(harness.only().prompts).toHaveLength(1);
  });
});

describe("runResume", () => {
  const base = {
    task: "resume" as const,
    requestId: "req-1",
    chatId: 1,
    payload: { originalTask: "assess", sessionId: "sess-1" },
  };

  it("refuses to resume ingest, which raises no interrupts", async () => {
    await expect(
      runResume(
        {
          ...base,
          payload: { originalTask: "ingest", sessionId: "sess-1" },
          snapshot: {},
          interruptResponses: [{ interruptId: "int-1", approved: true }],
        } as never,
        deps(),
      ),
    ).rejects.toThrow(NotResumable);
  });

  it("refuses without a snapshot, rather than starting the node over", async () => {
    await expect(
      runResume(
        { ...base, interruptResponses: [{ interruptId: "int-1", approved: true }] } as never,
        deps(),
      ),
    ).rejects.toThrow(/requires the snapshot/i);
  });

  it("refuses with no answers, because that would re-raise the same question", async () => {
    await expect(
      runResume({ ...base, snapshot: {}, interruptResponses: [] } as never, deps()),
    ).rejects.toThrow(/at least one interrupt response/i);
  });

  it("resumes the assessor on the assessor's own model", async () => {
    const harness = fakeAgents(
      json({
        findings: [],
        quietDecisions: [],
        reasoning: "nothing further after the approval",
      }),
    );

    await runResume(
      {
        ...base,
        snapshot: { stored: true },
        interruptResponses: [{ interruptId: "int-1", approved: true }],
      } as never,
      { ...deps(), agentFactory: harness.factory },
    );

    expect(harness.only().spec.role).toBe("assessor");
    expect(harness.only().loadedSnapshot).toEqual({ stored: true });
  });
});
