/**
 * Agent configuration.
 *
 * This container's environment is the least inspectable in the system: set once at
 * `agentcore launch`, with no manifest for it in this repository and its logs read
 * through CloudWatch. So the cases below are about *how it fails* as much as
 * whether it parses — a misconfiguration that starts anyway is the expensive kind
 * here.
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/** The minimum that must be present for any valid configuration. */
const MINIMUM: NodeJS.ProcessEnv = {
  MODEL_BASE_URL: "https://provider.test/v1",
  MODEL_API_KEY: "sk-test",
  DATA_API_URL: "https://worker.test/data",
  DATA_API_TOKEN: "token",
};

describe("required variables", () => {
  it("reads a minimal environment", () => {
    const config = loadConfig(MINIMUM);

    expect(config.model.baseUrl).toBe("https://provider.test/v1");
    expect(config.dataApi.url).toBe("https://worker.test/data");
  });

  it("reports every missing variable at once, not just the first", () => {
    // A container that fails on one missing variable, is redeployed, then fails on
    // the next costs a deploy cycle per mistake — and this is the slowest service
    // to redeploy.
    let message = "";
    try {
      loadConfig({});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    for (const name of ["MODEL_BASE_URL", "MODEL_API_KEY", "DATA_API_URL", "DATA_API_TOKEN"]) {
      expect(message, `expected ${name} in the error`).toContain(name);
    }
  });

  it("treats an empty string as absent rather than as a value", () => {
    // Some shells and process managers export every name they know about, empty
    // ones included. A variable set to "" is the absence of configuration wearing
    // a value, and accepting it would send an empty API key to the provider.
    expect(() => loadConfig({ ...MINIMUM, MODEL_API_KEY: "" })).toThrow(/MODEL_API_KEY/);
    expect(() => loadConfig({ ...MINIMUM, MODEL_BASE_URL: "   " })).toThrow(/MODEL_BASE_URL/);
  });
});

describe("the port", () => {
  it("defaults to the AgentCore convention", () => {
    expect(loadConfig(MINIMUM).port).toBe(8080);
  });

  it("prefers AGENT_PORT over PORT", () => {
    // Locally the agent and the worker share one `.env`. Without this the agent
    // binds the worker's 8081, and AGENT_HTTP_URL — which points at 8080 — then
    // reaches nothing.
    const config = loadConfig({ ...MINIMUM, AGENT_PORT: "8080", PORT: "8081" });
    expect(config.port).toBe(8080);
  });

  it("falls back to PORT when AGENT_PORT is unset, as AgentCore sets it", () => {
    expect(loadConfig({ ...MINIMUM, PORT: "9000" }).port).toBe(9000);
  });

  it("refuses a non-numeric port instead of binding NaN", () => {
    // The regression this schema exists for. `Number.parseInt("http")` is NaN and
    // `app.listen(NaN)` binds an arbitrary free port: the container comes up,
    // reports healthy on a port nothing routes to, and the failure presents as an
    // egress problem rather than a typo.
    expect(() => loadConfig({ ...MINIMUM, AGENT_PORT: "http" })).toThrow(/AGENT_PORT/);
  });

  it("refuses a port outside the valid range", () => {
    expect(() => loadConfig({ ...MINIMUM, AGENT_PORT: "70000" })).toThrow(/AGENT_PORT/);
    expect(() => loadConfig({ ...MINIMUM, AGENT_PORT: "0" })).toThrow(/AGENT_PORT/);
  });
});

describe("per-agent models", () => {
  it("falls back to a built-in model when nothing is configured", () => {
    const config = loadConfig(MINIMUM);
    expect(config.model.curator).toBe("deepseek-chat");
    expect(config.model.respondent).toBe("deepseek-chat");
  });

  it("applies DEFAULT_MODEL to every role", () => {
    const config = loadConfig({ ...MINIMUM, DEFAULT_MODEL: "some-model" });

    for (const role of [
      "curator",
      "cartographer",
      "assessor",
      "restraint",
      "briefer",
      "respondent",
    ] as const) {
      expect(config.model[role], role).toBe("some-model");
    }
  });

  it("lets one role be pointed at a stronger model without touching the others", () => {
    // The whole reason the models are separate variables: the Curator dominates
    // cost, and the three that produce read-aloud prose can be upgraded alone.
    const config = loadConfig({
      ...MINIMUM,
      DEFAULT_MODEL: "cheap-model",
      BRIEFER_MODEL: "strong-model",
    });

    expect(config.model.briefer).toBe("strong-model");
    expect(config.model.curator).toBe("cheap-model");
  });

  it("resolves each role from its own variable", () => {
    const config = loadConfig({
      ...MINIMUM,
      CURATOR_MODEL: "m-curator",
      CARTOGRAPHER_MODEL: "m-cartographer",
      ASSESSOR_MODEL: "m-assessor",
      RESTRAINT_MODEL: "m-restraint",
      BRIEFER_MODEL: "m-briefer",
      RESPONDENT_MODEL: "m-respondent",
    });

    expect(config.model).toMatchObject({
      curator: "m-curator",
      cartographer: "m-cartographer",
      assessor: "m-assessor",
      restraint: "m-restraint",
      briefer: "m-briefer",
      respondent: "m-respondent",
    });
  });

  it("ignores an empty per-role variable and uses the default", () => {
    const config = loadConfig({ ...MINIMUM, DEFAULT_MODEL: "fallback", CURATOR_MODEL: "" });
    expect(config.model.curator).toBe("fallback");
  });
});
