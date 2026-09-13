import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/api/server.js";
import { loadConfig } from "../src/config.js";

const BASE_ENV = {
  DATABASE_URL: "postgres://x:x@localhost:5432/x",
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "-100123",
  COORDINATOR_TELEGRAM_ID: "42",
  DATA_API_TOKEN: "correct-horse-battery-staple",
} as const;

describe("worker config", () => {
  it("requires AGENT_HTTP_URL under the http transport", () => {
    expect(() => loadConfig({ ...BASE_ENV, AGENT_TRANSPORT: "http" })).toThrow(/AGENT_HTTP_URL/);
  });

  it("requires the AWS variables under the agentcore transport", () => {
    expect(() => loadConfig({ ...BASE_ENV, AGENT_TRANSPORT: "agentcore" })).toThrow(
      /AGENTCORE_RUNTIME_ARN/,
    );
  });

  it("does not demand AWS credentials under the http transport", () => {
    const config = loadConfig({
      ...BASE_ENV,
      AGENT_TRANSPORT: "http",
      AGENT_HTTP_URL: "http://localhost:8080",
    });
    expect(config.AGENT_TRANSPORT).toBe("http");
    expect(config.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it("rejects an unknown transport rather than falling back", () => {
    expect(() => loadConfig({ ...BASE_ENV, AGENT_TRANSPORT: "sqs" })).toThrow(/AGENT_TRANSPORT/);
  });

  it("defaults the organisation timezone to IST, not UTC", () => {
    // Relative dates resolve against this. At IST, UTC would shift dates by a
    // day and look like a bug in provenance.
    const config = loadConfig({
      ...BASE_ENV,
      AGENT_TRANSPORT: "http",
      AGENT_HTTP_URL: "http://localhost:8080",
    });
    expect(config.ORG_TIMEZONE).toBe("Asia/Kolkata");
  });
});

describe("worker http surface", () => {
  const config = loadConfig({
    ...BASE_ENV,
    AGENT_TRANSPORT: "http",
    AGENT_HTTP_URL: "http://localhost:8080",
  });

  let databaseReachable = true;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const app = createServer({
      config,
      isDatabaseReachable: () => Promise.resolve(databaseReachable),
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("GET /health", () => {
    it("is reachable without a token, because Coolify's health check has none", async () => {
      databaseReachable = true;
      const response = await fetch(`${origin}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ok" });
    });

    it("reports 503 when the database is unreachable", async () => {
      databaseReachable = false;
      const response = await fetch(`${origin}/health`);
      expect(response.status).toBe(503);
      databaseReachable = true;
    });
  });

  describe("data API auth", () => {
    // If these ever returned 401 to an unauthenticated caller *and* the health
    // check pointed here, Coolify would read the container as unhealthy and
    // restart-loop past the worker's own backoff. Hence the separation.
    it("rejects a request with no token", async () => {
      const response = await fetch(`${origin}/data/facts`);
      expect(response.status).toBe(401);
    });

    it("rejects a request with the wrong token", async () => {
      const response = await fetch(`${origin}/data/facts`, {
        headers: { authorization: "Bearer wrong" },
      });
      expect(response.status).toBe(401);
    });

    it("admits a request with the correct token", async () => {
      const response = await fetch(`${origin}/data/facts`, {
        headers: { authorization: `Bearer ${config.DATA_API_TOKEN}` },
      });
      // 501 rather than 200: the route is past auth but not yet implemented,
      // which is exactly what this asserts.
      expect(response.status).toBe(501);
    });

    it("guards every data route, not just the first", async () => {
      for (const path of ["/data/facts", "/data/holdings", "/data/people"]) {
        const response = await fetch(`${origin}${path}`);
        expect(response.status, path).toBe(401);
      }
    });
  });
});
