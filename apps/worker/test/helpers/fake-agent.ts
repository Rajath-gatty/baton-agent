/**
 * A fake agent transport.
 *
 * Records every request so a test can assert on **what was asked**, which is the only
 * way to test a cache: a cache that works is one where the question is never asked. It
 * also lets a test hold a call open, which is how the pipeline lock's serialisation is
 * observed rather than assumed.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentInterrupt,
  AgentRequest,
  AgentResponse,
  AssessContext,
  AssessResult,
  AssessorFinding,
  BriefContext,
  BriefLine,
  BriefPayload,
  BriefResult,
  CandidateMessage,
  CuratorMessageResult,
  CuratorRecord,
  FindingCandidate,
  FindingSeverity,
  IngestContext,
  IngestResult,
  RespondContext,
  RespondPayload,
  RespondResult,
  RespondentOutcome,
  TraceEntry,
} from "@baton/core";
import type { AgentTransport } from "../../src/agent/transport.js";

export type IngestResponder = (
  batch: CandidateMessage[],
  context: IngestContext,
) => IngestResult | Promise<IngestResult>;

export class FakeAgent implements AgentTransport {
  readonly kind = "http" as const;
  /** Every batch sent, in order. Length zero is the assertion a cache hit needs. */
  readonly requests: { messageIds: string[]; context: IngestContext; request: AgentRequest }[] = [];
  closed = false;

  constructor(private readonly responder: IngestResponder) {}

  async invoke(request: AgentRequest): Promise<AgentResponse> {
    const payload = request.payload as { messages: CandidateMessage[] };
    const context = request.context as IngestContext;
    this.requests.push({
      messageIds: payload.messages.map((message) => message.messageId),
      context,
      request,
    });

    const trace: TraceEntry[] = [
      { node: "curator", model: "fake", reasoning: `Classified ${payload.messages.length}.` },
    ];

    return {
      task: "ingest",
      runId: request.runId,
      stopReason: "complete",
      result: await this.responder(payload.messages, context),
      trace,
    };
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** A transport that always reports failure, for the failed-run path. */
export class FailingAgent implements AgentTransport {
  readonly kind = "http" as const;
  constructor(private readonly message = "the model refused") {}

  invoke(request: AgentRequest): Promise<AgentResponse> {
    return Promise.resolve({
      task: "ingest",
      runId: request.runId,
      stopReason: "error" as const,
      trace: [{ node: "curator", reasoning: "Failed." }],
      error: this.message,
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export function curatorRecord(overrides: Partial<CuratorRecord> = {}): CuratorRecord {
  return {
    kind: "durable_fact",
    claim: "Meera holds the store room key",
    confidence: 0.9,
    assetKind: "physical_item",
    assetName: "store room key",
    sensitivity: "normal",
    holderMention: "Meera",
    subjectMentions: [],
    capabilityName: null,
    deadlineText: null,
    deadlineDate: null,
    isHearsay: false,
    isNegation: false,
    lifecycleKind: null,
    ...overrides,
  };
}

export function curatorResult(
  messageId: string,
  records: CuratorRecord[],
  overrides: Partial<Omit<CuratorMessageResult, "messageId" | "records">> = {},
): CuratorMessageResult {
  return {
    messageId,
    classification: records[0]?.kind ?? "noise",
    reasoning: "A fake classification.",
    records,
    ...overrides,
  };
}

/**
 * Builds a result for a batch, one record per message, with the Cartographer resolving
 * every holder mention to `personId`.
 *
 * `recordIndex` counts across the flattened batch — one increment per record — which is
 * the coordinate system the worker re-bases from. Getting it wrong here would make the
 * tests agree with a bug.
 */
export function resolveAllTo(personId: string): IngestResponder {
  return (batch) => {
    const results = batch.map((message) => curatorResult(message.messageId, [curatorRecord()]));
    const attributions = results.map((result, index) => ({
      recordIndex: index,
      mention: result.records[0]?.holderMention ?? "Meera",
      resolution: "resolved" as const,
      personId,
      candidatePersonIds: [personId],
      externalName: null,
      isPersonalResource: false,
      confidence: 1,
      reasoning: "Fake exact match.",
    }));
    return { curator: { results }, cartographer: { attributions } };
  };
}

/** A run id that is a real uuid, since the column is typed. */
export function fakeRunId(): string {
  return randomUUID();
}

export type AssessResponder = (
  candidates: FindingCandidate[],
  context: AssessContext,
) => AssessResult | Promise<AssessResult>;

/**
 * A fake agent for the `assess` task.
 *
 * Separate from {@link FakeAgent} because the sweep's central assertion is the *absence*
 * of an invocation, and a transport that records assess requests specifically makes that
 * assertion read as what it is.
 */
export class FakeAssessor implements AgentTransport {
  readonly kind = "http" as const;
  readonly requests: { candidates: FindingCandidate[]; context: AssessContext }[] = [];

  constructor(private readonly responder: AssessResponder) {}

  async invoke(request: AgentRequest): Promise<AgentResponse> {
    const payload = request.payload as { candidates: FindingCandidate[] };
    const context = request.context as AssessContext;
    this.requests.push({ candidates: payload.candidates, context });

    return {
      task: "assess",
      runId: request.runId,
      stopReason: "complete",
      result: await this.responder(payload.candidates, context),
      trace: [{ node: "assessor", model: "fake", reasoning: "Judged the candidates." }],
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Judges every candidate at one severity, suppressing nothing. */
export function judgeAllAt(
  severity: FindingSeverity,
  overrides: Partial<AssessorFinding> = {},
): AssessResponder {
  return (candidates) => ({
    findings: candidates.map((candidate) => ({
      dedupeKey: candidate.dedupeKey,
      type: candidate.type,
      subtype: candidate.subtype,
      title: `Something about ${candidate.subjectName}`,
      whyItMatters: "It would be awkward if this were lost.",
      severity,
      confidence: 0.8,
      suppress: false,
      suppressionReason: null,
      aggregatedDedupeKeys: [],
      reasoning: "A fake judgment.",
      ...overrides,
    })),
    quietDecisions: [],
  });
}

export type RespondResponder = (
  payload: RespondPayload,
  context: RespondContext,
) => RespondResult | Promise<RespondResult>;

/** A fake agent for the `respond` task. */
export class FakeRespondent implements AgentTransport {
  readonly kind = "http" as const;
  readonly requests: { payload: RespondPayload; context: RespondContext }[] = [];

  constructor(private readonly responder: RespondResponder) {}

  async invoke(request: AgentRequest): Promise<AgentResponse> {
    const payload = request.payload as RespondPayload;
    const context = request.context as RespondContext;
    this.requests.push({ payload, context });

    return {
      task: "respond",
      runId: request.runId,
      stopReason: "complete",
      result: await this.responder(payload, context),
      trace: [{ node: "respondent", model: "fake", reasoning: "Answered." }],
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A reply of one shape, with the schema's own invariants satisfied.
 *
 * `respondentOutputSchema` enforces them with `superRefine` — an answer must cite a fact, a
 * stale answer must state its age, an ambiguous holder needs two candidates — so a fake that
 * ignored them would test a shape the real agent cannot produce.
 */
export function reply(
  outcome: RespondentOutcome,
  overrides: Partial<RespondResult["reply"]> = {},
  resultOverrides: Partial<Omit<RespondResult, "reply">> = {},
): RespondResult {
  const base: RespondResult["reply"] = {
    outcome,
    answerText: outcome === "unknown" ? null : "Meera has the store room key.",
    factIds: outcome === "answer" || outcome === "stale_answer" ? ["fact-1"] : [],
    evidenceMessageIds: [],
    ageDays: outcome === "stale_answer" ? 150 : null,
    candidateHolderPersonIds: [],
    target: "group",
    followUpQuestion: outcome === "unknown" ? "Who has the store room key?" : null,
    reasoning: "A fake reply.",
    ...overrides,
  };

  return { reply: base, withheld: false, quietDecisions: [], ...resultOverrides };
}

export type BriefResponder = (
  payload: BriefPayload,
  context: BriefContext,
) => BriefResult | Promise<BriefResult>;

/** A fake agent for the `brief` task. */
export class FakeBriefer implements AgentTransport {
  readonly kind = "http" as const;
  readonly requests: { payload: BriefPayload; context: BriefContext }[] = [];

  constructor(private readonly responder: BriefResponder) {}

  async invoke(request: AgentRequest): Promise<AgentResponse> {
    const payload = request.payload as BriefPayload;
    const context = request.context as BriefContext;
    this.requests.push({ payload, context });

    return {
      task: "brief",
      runId: request.runId,
      stopReason: "complete",
      result: await this.responder(payload, context),
      trace: [{ node: "briefer", model: "fake", reasoning: "Wrote a brief." }],
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export function briefLine(overrides: Partial<BriefLine> = {}): BriefLine {
  return {
    section: "only_they_held",
    text: "the store room key",
    evidenceFactIds: [],
    evidenceMessageIds: [],
    subjectAssetId: null,
    subjectCapabilityId: null,
    subjectCommitmentId: null,
    ...overrides,
  };
}

/**
 * A brief with lines, satisfying `brieferOutputSchema`'s own invariants.
 *
 * That schema rejects an empty brief carrying lines and a non-empty brief carrying none, so a
 * fake that ignored the pairing would test a shape the real agent cannot produce.
 */
export function brief(
  payload: BriefPayload,
  lines: BriefLine[],
  overrides: Partial<Omit<BriefResult, "brief">> = {},
): BriefResult {
  const isEmpty = lines.length === 0;
  return {
    brief: {
      kind: payload.kind,
      subjectPersonId: payload.subjectPersonId,
      openingLine: isEmpty
        ? "Nothing appears to have left with them."
        : `Here is what ${payload.subjectDisplayName} was holding.`,
      isEmpty,
      lines,
      reasoning: "A fake brief.",
    },
    quietDecisions: [],
    ...overrides,
  };
}

/**
 * A transport that interrupts on the first call and answers the resume on the second.
 *
 * Both halves in one fake because the approval round trip is only meaningful as a pair: an
 * interrupt nobody resumes proves the worker can store a snapshot, not that it can use one.
 */
export class InterruptingAgent implements AgentTransport {
  readonly kind = "http" as const;
  readonly requests: AgentRequest[] = [];

  constructor(
    private readonly interrupts: AgentInterrupt[],
    private readonly resumedResult: unknown = null,
    private readonly snapshot: unknown = { node: "assessor", step: 3 },
  ) {}

  invoke(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push(request);

    if (request.task === "resume") {
      return Promise.resolve({
        task: "resume",
        runId: request.runId,
        stopReason: "complete",
        result: this.resumedResult,
        trace: [{ node: "resume", reasoning: "Picked up from the interruption point." }],
      });
    }

    return Promise.resolve({
      task: request.task,
      runId: request.runId,
      stopReason: "interrupt",
      interrupts: this.interrupts,
      snapshot: this.snapshot,
      trace: [{ node: "assessor", reasoning: "Stopped to ask." }],
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  get resumeRequests(): AgentRequest[] {
    return this.requests.filter((request) => request.task === "resume");
  }
}

export function interrupt(overrides: Partial<AgentInterrupt> = {}): AgentInterrupt {
  return {
    interruptId: "interrupt-1",
    interruptName: "confirm_financial_control",
    reason: "Should I record that Meera now controls the bank account?",
    ...overrides,
  };
}
