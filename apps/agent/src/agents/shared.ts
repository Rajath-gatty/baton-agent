/**
 * Shared plumbing for the six agents.
 *
 * Each agent is a plain async function: hydrated input in, validated output out.
 * They do not own their model, their trace or their HTTP client — those are passed
 * in, so a test can exercise an agent's assembly without a network and the task
 * layer can decide which model each one gets.
 */

import type { AgentConfig } from "../config.js";
import type { AgentFactory } from "../model/structured.js";
import type { TraceCollector } from "../model/trace.js";
import type { DataApiClient } from "../tools/data-api.js";

export interface AgentDeps {
  config: AgentConfig;
  trace: TraceCollector;
  dataApi: DataApiClient;
  /**
   * How the underlying model agent is constructed. Absent in the container, where
   * the real provider is used; supplied by tests, which is what makes the sentence
   * above about exercising an agent without a network actually true.
   */
  agentFactory?: AgentFactory;
}

/** Passes the factory through only when one was supplied — `exactOptionalPropertyTypes`. */
export function factoryOption(deps: AgentDeps): { agentFactory?: AgentFactory } {
  return deps.agentFactory === undefined ? {} : { agentFactory: deps.agentFactory };
}

/**
 * Renders a labelled block of JSON for the request body.
 *
 * Labelled sections rather than one anonymous object because the prompts refer to
 * the parts by name, and a model that has to infer which key is the context and
 * which is the work spends its attention on the wrong problem.
 */
export function section(title: string, value: unknown): string {
  return `## ${title}\n${JSON.stringify(value, null, 2)}`;
}

/** Assembles a request body from labelled sections and a closing instruction. */
export function buildInput(sections: readonly string[], instruction: string): string {
  return [...sections, `## What to return\n${instruction}`].join("\n\n");
}
