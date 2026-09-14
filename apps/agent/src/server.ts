/**
 * The AgentCore container.
 *
 * Implements the AgentCore Runtime contract: `POST /invocations` and `GET /ping`.
 * Stateless by deliberate choice — input is a task, a payload and hydrated context;
 * output is structured results plus a trace. It never touches Postgres, so database
 * credentials exist in exactly one place, there is no VPC or network plumbing, and this
 * container is trivially redeployable.
 *
 * This file is only the process: which port to bind, which signals to honour, when to
 * exit. The request handling lives in `app.ts`, so it can be tested without a socket.
 */

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp({ config });

const server = app.listen(config.port, () => {
  console.log(`[agent] listening on ${config.port}`);
});

// AgentCore may bill by session lifetime rather than request processing, so shutting
// down promptly on signal matters more here than it would elsewhere.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[agent] ${signal} received, closing`);
    server.close(() => process.exit(0));
  });
}
