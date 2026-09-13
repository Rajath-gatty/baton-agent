/**
 * The agent transport.
 *
 * One interface, two implementations. This seam exists because a locally-run
 * worker cannot serve its data API to a container running on AWS, so local
 * development runs the agent container locally and speaks plain HTTP to it.
 * Without the seam, nothing in the pipeline could be exercised without a
 * deploy — and iterating on six prompts is where most of the build time goes.
 *
 * It is built here, before the orchestration module, rather than retrofitted
 * into one written around a SigV4 client.
 */

import { agentResponseSchema, type AgentRequest, type AgentResponse } from "@baton/core";
import type { WorkerConfig } from "../config.js";

export interface AgentTransport {
  readonly kind: "agentcore" | "http";
  invoke(request: AgentRequest): Promise<AgentResponse>;
  /**
   * Release any session held on the agent's side. AgentCore may bill by session
   * lifetime rather than request processing, in which case a session left open
   * for four weeks costs real money for nothing.
   */
  close(): Promise<void>;
}

/** Local development: POST the identical envelope to a locally-run container. */
class HttpTransport implements AgentTransport {
  readonly kind = "http" as const;

  constructor(private readonly baseUrl: string) {}

  async invoke(request: AgentRequest): Promise<AgentResponse> {
    const response = await fetch(new URL("/invocations", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Agent returned ${response.status}: ${await response.text()}`);
    }

    return agentResponseSchema.parse(await response.json());
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Deployed: SigV4-signed invocation of the AgentCore runtime. The VM's single
 * IAM user is scoped to `bedrock-agentcore:InvokeAgentRuntime` and nothing else,
 * which is the only AWS credential in the system.
 */
class AgentCoreTransport implements AgentTransport {
  readonly kind = "agentcore" as const;

  constructor(
    private readonly runtimeArn: string,
    private readonly region: string,
  ) {}

  invoke(_request: AgentRequest): Promise<AgentResponse> {
    // Implemented alongside gate G4, which is the first thing that exercises
    // it. The interface is fixed now so the orchestration module can be written
    // against it either way.
    return Promise.reject(
      new Error(
        `AgentCore transport not implemented yet (runtime ${this.runtimeArn} in ${this.region}).`,
      ),
    );
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export function createTransport(config: WorkerConfig): AgentTransport {
  if (config.AGENT_TRANSPORT === "http") {
    // Validated by config: AGENT_HTTP_URL is present under this transport.
    return new HttpTransport(config.AGENT_HTTP_URL as string);
  }
  return new AgentCoreTransport(
    config.AGENTCORE_RUNTIME_ARN as string,
    config.AWS_REGION as string,
  );
}
