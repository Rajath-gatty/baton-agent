import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
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
  let harness: TestDatabase;

  beforeAll(async () => {
    // A real database: the data routes run real SQL now, and an empty schema is a
    // perfectly good fixture for auth and health assertions.
    harness = await setupTestDatabase();
    await harness.truncate();

    const app = createServer({
      config,
      db: harness.db,
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
    await harness.close();
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
      const response = await fetch(`${origin}/data/facts?q=clinic`, {
        headers: { authorization: `Bearer ${config.DATA_API_TOKEN}` },
      });
      // 200 with an empty register, rather than the 501 this asserted while the
      // routes were stubs.
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ facts: [] });
    });

    it("guards every data route, not just the first", async () => {
      for (const path of ["/data/facts", "/data/holdings", "/data/people"]) {
        const response = await fetch(`${origin}${path}`);
        expect(response.status, path).toBe(401);
      }
    });
  });
});
