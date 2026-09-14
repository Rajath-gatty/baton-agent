/**
 * The HTTP contract with the worker.
 *
 * This is the seam where a version skew between the two containers surfaces. Coolify
 * and AgentCore deploy independently, so there is always a window where the worker is
 * sending a shape this container was not built for — and the difference between a clear
 * 400 and a confusing 500 from somewhere deep in a task handler is the difference
 * between diagnosing that in a minute and in an hour.
 *
 * Driven over a real socket on an ephemeral port rather than with a request-injection
 * helper, so the body parser, the JSON limit and the status codes are all the ones the
 * runtime will actually use.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { AgentResponse } from "@baton/core";
import { createApp, type Dispatcher } from "../src/app.js";
import { testConfig } from "./helpers/config.js";

let server: Server;
let origin: string;

/** Starts the app on an ephemeral port and returns its origin. */
function start(dispatcher?: Dispatcher): Promise<string> {
  const app = createApp({
    config: testConfig(),
    ...(dispatcher === undefined ? {} : { dispatcher }),
  });
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const REQUEST = {
  task: "ingest",
  runId: "run-1",
  chatId: -100,
  payload: { messages: [] },
  context: {},
};

function post(body: unknown, contentType = "application/json"): Promise<Response> {
  return fetch(`${origin}/invocations`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /ping", () => {
  beforeEach(async () => {
    origin = await start();
  });

  it("reports healthy without touching a model or a database", async () => {
    // AgentCore's probe. It must not depend on the provider being reachable: a health
    // check that fails when the model is down would have AgentCore recycle a container
    // that is working perfectly well.
    const response = await fetch(`${origin}/ping`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "healthy" });
  });
});

describe("POST /invocations", () => {
  describe("the envelope", () => {
    beforeEach(async () => {
      origin = await start(() =>
        Promise.resolve({
          task: "ingest",
          runId: "run-1",
          stopReason: "complete",
          trace: [],
        } as unknown as AgentResponse),
      );
    });

    it("rejects an unrecognised envelope with 400, not 500", async () => {
      // 400 says "we disagree about the contract"; 500 says "something broke inside".
      // Conflating them sends whoever is on call to the wrong container.
      const response = await post({ task: "ingest" });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; stopReason: string };
      expect(body.stopReason).toBe("error");
      expect(body.error).toMatch(/invalid agent request envelope/i);
    });

    it("rejects an unknown task rather than dispatching it", async () => {
      const response = await post({ ...REQUEST, task: "reticulate" });

      expect(response.status).toBe(400);
    });

    it("returns a trace even on a rejected envelope", async () => {
      // The worker stores `runs.trace` unconditionally. A response without the key
      // would make the failure a null column rather than a visible empty run.
      const response = await post({ task: "nonsense" });

      expect((await response.json()) as { trace: unknown[] }).toMatchObject({ trace: [] });
    });

    it("accepts a valid envelope and returns what the dispatcher produced", async () => {
      const response = await post(REQUEST);

      expect(response.status).toBe(200);
      expect((await response.json()) as AgentResponse).toMatchObject({
        stopReason: "complete",
        runId: "run-1",
      });
    });

    it("rejects malformed JSON with a 4xx", async () => {
      const response = await post("{not json", "application/json");

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });
  });

  describe("when a task throws", () => {
    beforeEach(async () => {
      origin = await start(() => Promise.reject(new Error("the provider refused the request")));
    });

    it("answers 500 carrying the message, the task and the run id", async () => {
      // The worker writes this into a failed `runs` row. Dropping the run id would
      // leave a failure nothing could be correlated with.
      const response = await post(REQUEST);

      expect(response.status).toBe(500);
      expect((await response.json()) as AgentResponse).toMatchObject({
        task: "ingest",
        runId: "run-1",
        stopReason: "error",
        error: "the provider refused the request",
        trace: [],
      });
    });
  });

  describe("when a task rejects with a non-Error", () => {
    beforeEach(async () => {
      origin = await start(() => Promise.reject("a bare string"));
    });

    it("still reports something legible rather than [object Object]", async () => {
      const response = await post(REQUEST);

      expect(response.status).toBe(500);
      expect((await response.json()) as AgentResponse).toMatchObject({ error: "a bare string" });
    });
  });
});
