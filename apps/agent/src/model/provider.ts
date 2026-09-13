/**
 * Model provider wiring.
 *
 * One model per agent role, each from its own environment variable. The Curator
 * runs on every candidate message and dominates cost and latency; the Assessor,
 * Restraint and Briefer produce the text a judge reads. Separating them is
 * deliberate insurance: three agents can be pointed at a stronger model by
 * changing environment variables, without touching the one that dominates cost.
 *
 * The provider is the OpenAI-compatible client aimed at a custom `baseURL`, which
 * is how a DeepSeek-class provider is reached with no Bedrock involvement. Note
 * that `baseURL` belongs inside `clientConfig` while `apiKey` and `modelId` are
 * top-level — a detail worth stating because misplacing it fails at request time
 * with an authentication error rather than at construction with a type error.
 */

import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import type { AgentConfig } from "../config.js";

/** The six agents. Also the key into the per-agent model configuration. */
export type AgentRole =
  | "curator"
  | "cartographer"
  | "assessor"
  | "restraint"
  | "briefer"
  | "respondent";

/**
 * The model id configured for a role.
 *
 * Exported separately because the SDK does not expose the model id on its result
 * or metrics objects, and the trace has to record which model produced each node.
 * Reading it from configuration is the only source available.
 */
export function modelIdFor(role: AgentRole, config: AgentConfig): string {
  return config.model[role];
}

/**
 * Builds the model for a role.
 *
 * `temperature` is pinned low across every agent. All six do classification and
 * judgment against fixed schemas, where sampling variety is not a feature: it is
 * the difference between two sweeps of identical input producing the same register
 * and producing two slightly different ones, which a coordinator reads as the tool
 * being unreliable.
 */
export function buildModel(role: AgentRole, config: AgentConfig): OpenAIModel {
  return new OpenAIModel({
    api: "chat",
    apiKey: config.model.apiKey,
    clientConfig: { baseURL: config.model.baseUrl },
    modelId: modelIdFor(role, config),
    temperature: 0,
  });
}
