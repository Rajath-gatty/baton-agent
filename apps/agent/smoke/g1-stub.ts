/**
 * G1a — the custom base URL mechanism, proved against a local stub.
 *
 * `g1-provider.ts` points at the real provider and so answers two questions at once:
 * whether Strands can talk to a custom `baseURL`, and whether the configured account
 * works. When it fails, those are indistinguishable — and the first time it ran, the
 * provider returned an identical 401 to an *unauthenticated* request, meaning the key was
 * never evaluated and the failure said nothing about our code.
 *
 * This isolates the half we own. It starts a minimal OpenAI-compatible server in-process,
 * points `MODEL_BASE_URL` at it, and drives the same `loadConfig` → `buildModel` → `Agent`
 * path the container uses. A pass proves the mechanism the design was unsure about — the
 * Strands OpenAI provider does accept an arbitrary base URL — and leaves only the
 * provider's credentials as an external unknown.
 *
 * It also records the request Strands actually sends, which is the thing to compare
 * against a provider's docs when one rejects us.
 *
 * No network, no tokens, no keys. Safe to run in CI.
 *
 * Usage:
 *   pnpm --filter @baton/agent smoke:g1-stub
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "@strands-agents/sdk";
import { loadConfig } from "../src/config.js";
import { buildModel, modelIdFor } from "../src/model/provider.js";

const REPLY_TEXT = "BATON G1 OK";

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

/** A minimal `POST /chat/completions`, enough for one non-streaming turn. */
function startStub(captured: CapturedRequest[]): Promise<{ url: string; close: () => void }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // Keep the raw string; the point is to record what arrived.
      }

      captured.push({
        method: req.method ?? "?",
        url: req.url ?? "?",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body,
      });

      const isStreaming =
        typeof body === "object" && body !== null && (body as { stream?: boolean }).stream === true;

      if (isStreaming) {
        // Server-sent events, which is what the SDK asks for by default.
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const id = "chatcmpl-stub";
        const model = (body as { model?: string }).model ?? "stub";
        const frame = (delta: Record<string, unknown>, finish: string | null) =>
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;

        res.write(frame({ role: "assistant" }, null));
        res.write(frame({ content: REPLY_TEXT }, null));
        res.write(frame({}, "stop"));
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [],
            usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: (body as { model?: string }).model ?? "stub",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: REPLY_TEXT },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
        }),
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        close: () => server.close(),
      });
    });
  });
}

async function main(): Promise<void> {
  const captured: CapturedRequest[] = [];
  const stub = await startStub(captured);

  // Set before `loadConfig`, so the same configuration code the container runs is what
  // points at the stub. Overwriting the model afterwards would test a different path.
  process.env["MODEL_BASE_URL"] = stub.url;
  process.env["MODEL_API_KEY"] = "stub-key-not-a-secret";
  process.env["CURATOR_MODEL"] = "stub-model";
  process.env["DATA_API_URL"] ??= "http://127.0.0.1:9/data";
  process.env["DATA_API_TOKEN"] ??= "stub-token";

  const config = loadConfig();

  console.log("G1a — custom base URL through Strands, against a local stub");
  console.log(`  base URL   ${config.model.baseUrl}`);
  console.log(`  model id   ${modelIdFor("curator", config)}`);
  console.log("");

  try {
    const agent = new Agent({
      model: buildModel("curator", config),
      systemPrompt: "You are a test harness.",
      id: "g1-stub",
      printer: false,
    });

    const startedAt = Date.now();
    const result = await agent.invoke("Reply with exactly: BATON G1 OK");
    const elapsed = Date.now() - startedAt;

    const text = result.lastMessage.content
      .filter((block): block is { type: "textBlock"; text: string } => block.type === "textBlock")
      .map((block) => block.text)
      .join("")
      .trim();

    const request = captured[0];
    if (request === undefined) {
      console.error("FAIL — Strands never called the stub, so the base URL was not used.");
      process.exit(1);
    }

    console.log("Request Strands sent:");
    console.log(`  ${request.method} ${request.url}`);
    console.log(
      `  authorization  ${request.authorization === undefined ? "(none)" : "Bearer ****"}`,
    );
    console.log(`  content-type   ${request.contentType ?? "(none)"}`);
    console.log(`  body           ${JSON.stringify(request.body)}`);
    console.log("");

    if (text !== REPLY_TEXT) {
      console.error(
        `FAIL — expected ${JSON.stringify(REPLY_TEXT)}, parsed ${JSON.stringify(text)}`,
      );
      process.exit(1);
    }

    console.log("PASS — the Strands OpenAI provider accepts an arbitrary base URL.");
    console.log(`  requests   ${captured.length}`);
    console.log(`  latency    ${elapsed} ms (local, so this measures overhead only)`);
    console.log(`  reply      ${JSON.stringify(text)}`);
    console.log(
      "\nThe mechanism is proved and needs no proxy. What remains for G1 proper is a" +
        "\nprovider endpoint that accepts our credentials — see g1-provider.ts.",
    );
  } finally {
    stub.close();
  }
}

await main();
