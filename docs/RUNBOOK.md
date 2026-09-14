# Baton — Runbook

**Purpose:** two step-by-step procedures. Part 1 takes a freshly cloned repository to a running,
tested local stack. Part 2 takes the same clone to the production environment — Coolify on a VM for
Postgres, worker and web; Bedrock AgentCore for the agent.

**Derived from:** `2026-09-12-baton-technical-design.md`, `2026-09-13-baton-implementation-checklist.md`,
and the code as it stands.

## Read this before you start

Part 1 is proved. Every command in it has been run on this codebase.

**Part 2 has never been executed.** Every item in the checklist's **Deployment** section is still
pending: no worker or web image has been built, nothing has been pushed to ECR, no AgentCore runtime
exists, and no Coolify resource has been created. Part 2 is therefore written from the design plus the
code, and each step says how to tell whether it worked. Treat it as a plan to follow carefully, not a
path someone has already walked.

Three gaps will stop a production deploy from *working*, as opposed to *completing*. Know them before
you begin:

| Gap | Consequence | Where it is recorded |
| --- | --- | --- |
| `AgentCoreTransport.invoke` is unimplemented — it rejects with *"AgentCore transport not implemented yet"* | A deployed worker with `AGENT_TRANSPORT=agentcore` fails on **every** agent call. There is no HTTP fallback: a deployed runtime is reachable only through SigV4 `InvokeAgentRuntime`. **This must be built before production is useful.** | `apps/worker/src/agent/transport.ts`; checklist gate `G4` |
| No Dockerfile pins `linux/arm64` | AgentCore rejects an amd64 image. A build on an x86 machine produces amd64 by default. | checklist, *Images* |
| `apps/web` has never produced a `standalone` build | `apps/web/Dockerfile` copies `.next/standalone`; on Windows the build stops with `EPERM` while symlinking. Unverified on Linux, which is where Coolify builds. | checklist, *Images* |

And one product-level truth that matters operationally: **the admin UI reads synthetic fixtures, not
the database.** `apps/web/src/lib/data.ts` returns rows from `apps/web/src/lib/fixtures.ts`, and the
five server actions in `apps/web/src/app/actions.ts` are `SEAM:` stubs that persist nothing. Deploying
the stack does not make the UI show real data, and clicking Dismiss in production changes nothing.

---

# Part 1 — Local, from a fresh clone

Everything except Postgres runs on the host. Postgres runs in Docker.

## 1. Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node | ≥ 22 | `engines` in the root `package.json` |
| pnpm | 10.33.0 | Pinned by `packageManager`; get it with `corepack enable` rather than a global install |
| Docker Desktop | any current | Only to host Postgres locally. Must be **running** — a stopped daemon fails with `open //./pipe/dockerDesktopLinuxEngine` |
| Git | any | |

```powershell
node --version          # v22 or newer
corepack enable
pnpm --version          # 10.33.0
docker version          # must print a Server section
```

## 2. Clone and install

```powershell
git clone <repository-url> baton-agent
cd baton-agent
pnpm install
```

## 3. Create `.env`

One `.env` at the repository root serves all five workspaces. The worker, agent and web dev entry
points each load it; the containers deliberately do not.

```powershell
Copy-Item .env.example .env
```

**Fix the port before anything else.** `.env.example` says `5433` and claims
`docker-compose.dev.yml` publishes `127.0.0.1:5433:5432`. It publishes **`5432:5432`**. Either edit
the two URLs in `.env` to `5432`, or change the compose port to `5433:5432` — but do one of them,
because the mismatch produces a connection refused that reads like Postgres failing to start.

```dotenv
DATABASE_URL=postgres://baton:baton@localhost:5432/baton
TEST_DATABASE_URL=postgres://baton:baton@localhost:5432/baton_test
```

`TEST_DATABASE_URL` must differ from `DATABASE_URL`. The test harness refuses to run otherwise, on
purpose: integration tests truncate every table, and pointed at your working database they would erase
the seeded history while still passing.

What each remaining variable is needed for:

| Variable | Needed for | If absent |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `COORDINATOR_TELEGRAM_ID` | Running the **worker** | Worker refuses to start; config is validated eagerly. Not needed for tests, seeding, backfill, or the web app |
| `DATA_API_TOKEN` | Worker **and** agent — the same value on both | Worker refuses to start; agent's data lookups 401 |
| `AGENT_TRANSPORT=http`, `AGENT_HTTP_URL=http://localhost:8080` | Worker, locally | With `agentcore` the worker demands the AWS variables and then fails on the unimplemented transport |
| `MODEL_BASE_URL`, `MODEL_API_KEY` | Running the **agent** | Agent refuses to start and names both |
| `DATA_API_URL=http://localhost:8081/data` | Agent | Agent refuses to start |
| `ADMIN_PASSCODE`, `SESSION_SECRET` | Running the **web** app | Login cannot succeed |
| `PORT=8081`, `AGENT_PORT=8080` | Keeping the two local servers apart | The agent binds the worker's port and `AGENT_HTTP_URL` becomes unreachable |
| `ORG_TIMEZONE=Asia/Kolkata` | Relative-date resolution | Defaults to `Asia/Kolkata` anyway |

You can complete steps 4–9 — install, migrate, test, seed, backfill — with **no** bot token and **no**
model key. Only the live worker and live agent need those.

## 4. Start Postgres and create the test database

```powershell
pnpm pg:up
docker compose -f docker-compose.dev.yml ps        # postgres should read healthy
```

The compose file creates one database, `baton`. The test database is separate and is not created for
you:

```powershell
docker compose -f docker-compose.dev.yml exec postgres createdb -U baton baton_test
```

If it already exists Postgres says so and nothing is harmed.

## 5. Build `packages/core`

Not optional, and not merely a speed-up. Core's `exports` point at `dist`, not `src`, so a stale or
missing `dist` does not error — it silently serves the **previous** API.

```powershell
pnpm --filter @baton/core build
```

## 6. Run migrations

```powershell
pnpm db:migrate
```

Prints `Migrations applied.` and then lists the tables — 21 of them. Idempotent: Drizzle records what
it applied, and the worker re-runs this on every start.

## 7. Run the test suite

```powershell
pnpm test
```

The root script builds core first, then runs each workspace's suite with `--workspace-concurrency=1`.

Expected totals, and what each is worth:

| Workspace | Tests | Needs Postgres | Measured |
| --- | --- | --- | --- |
| `packages/core` | 265 | Only `db-harness.test.ts` | From the checklist |
| `apps/worker` | 504 | Yes, nearly all of it | From the checklist |
| `apps/agent` | **127** | No | Verified while writing this runbook — 10 files, 127 passing, ~58s |
| `scripts` | **66** | No | Verified while writing this runbook — 2 files, ~5s |
| `apps/web` | 0 | — | Passes with none |

That is **962**, not the 893 the checklist's status block still reports: its agent figure of 58
predates the six agent test files added later the same day. The two suites that need no database were
re-run to confirm the numbers above; core and worker were taken from the checklist because the Docker
daemon was down at the time.

Two rules, both learned the hard way:

- **Never run two suites at once.** The worker's integration tests share one `baton_test` database and
  truncate between cases. A second run truncating mid-test surfaces as a spray of foreign-key
  violations in whichever run lost the race — which looks like a code bug and is not one. If you see
  `violates foreign key constraint` on a row whose parent vanished, that is this.
- **A "tests pass" claim made without a fresh core build is unmeasured.** Each workspace's own `test`
  script rebuilds core for this reason.

Single workspaces, when you want a faster loop:

```powershell
pnpm --filter @baton/worker test
pnpm --filter @baton/core test
pnpm --filter @baton/agent test          # no database needed
pnpm --filter @baton/scripts test        # no database needed
```

And the three checks CI-equivalent to review:

```powershell
pnpm typecheck
pnpm lint
pnpm format
```

## 8. Generate the seed data

The transcript is derived and gitignored, so a fresh clone has none. Two phases: a committed plan
fixture, then rendered prose.

```powershell
pnpm seed:plan
pnpm seed:transcript -- --months 2 --allow-unbound
```

- `--months 2` renders the development slice, 1,753 messages. Omit it for the full six months (~4,421).
- `--allow-unbound` is required until the demo Telegram accounts exist. Without it the script exits
  non-zero unless `SEED_TELEGRAM_ID_COORDINATOR`, `SEED_TELEGRAM_ID_LEAVER` and
  `SEED_TELEGRAM_ID_ARRIVER` are set — a deliberate hard failure, because the opening demo case fails
  *silently* when the leaver is not the seeded owner of the donation page.
- No model and no network are involved: filler prose comes from deterministic templates today.
- After rendering, the script re-scans its own output and exits non-zero if any coverage row is
  unmatched. A passing coverage report is the signal that the transcript is usable.

## 9. Load the transcript into Postgres

```powershell
pnpm backfill -- --chat-id 0
```

`--chat-id 0` is the documented placeholder for "no real Telegram group yet". Expect roughly:

```
messages    1753 read
candidates  1287 (73% kept for curation)
discarded   466 by the pre-filter
unprocessed 2 media with no text
edits       1 replayed as an upsert over the original
in postgres 1753 rows in messages
```

Two things to know:

- **This is intake only.** Curation — candidates to `ingest`, then one `assess` pass — is stage two and
  needs a working model call (gate `G1`). Until then the register, findings and briefs stay empty.
- It is idempotent, and it takes the pipeline advisory lock. Stop any running worker first; if one
  holds the lock, backfill exits rather than queueing, because a silent queue looks exactly like a hang.
- Re-run it with a real `--chat-id` once the bot is in a group, or the live poll loop — which filters on
  the configured chat — cannot see the history.

## 10. Start the services

Order matters, because the worker and agent point at each other: the worker POSTs to
`AGENT_HTTP_URL` (8080) and the agent calls back to `DATA_API_URL` (8081).

**Postgres → agent → worker → web.** Use a separate terminal for each.

```powershell
# 1. agent — needs MODEL_BASE_URL, MODEL_API_KEY, DATA_API_URL, DATA_API_TOKEN
pnpm --filter @baton/agent dev
# [agent] listening on 8080

# 2. worker — runs migrations, then starts the HTTP server, then the two loops
pnpm --filter @baton/worker dev
# [worker] running migrations
# [worker] agent transport: http
# [worker] http listening on 8081
# [worker] bot identity <id> (@<handle>)
# [worker] intake and processing loops started

# 3. web
pnpm --filter @baton/web dev
# http://localhost:3000
```

Notes per service:

- **agent.** Stateless, holds no database credentials by design — the ESLint config fails the build on
  any import of `pg`, `postgres`, `drizzle-orm` or `@baton/core/db` from this workspace. Serves
  `POST /invocations` and `GET /ping`.
- **worker.** Needs a **valid** bot token even locally: startup calls `getMe` to learn Baton's own user
  id before the first poll, because a message Baton itself sent must never be read back as a freshly
  confirmed fact. It also checks whether the bot is an administrator in the configured chat and logs a
  warning if not — Telegram delivers `chat_member` updates only to administrators, so without it no
  brief will ever fire.
- **web.** Open `http://localhost:3000`, enter `ADMIN_PASSCODE` at `/login`. One page, four sections.
  Remember it is reading fixtures.

## 11. Verify by hand

```powershell
# agent health
curl http://localhost:8080/ping                       # {"status":"healthy"}

# worker health — unauthenticated on purpose, 503 when Postgres is unreachable
curl http://localhost:8081/health                     # {"status":"ok"}

# data API rejects an absent token
curl -i http://localhost:8081/data/facts?q=keys       # 401 Unauthorized

# and admits the right one
curl -H "Authorization: Bearer $env:DATA_API_TOKEN" "http://localhost:8081/data/facts?q=keys"
```

The four read-only data routes are `/data/facts?q=`, `/data/facts/:id/evidence`,
`/data/holdings?asset=`, `/data/people?alias=`.

## 12. Optional — a real local Telegram group

Only needed to exercise intake, questions and briefs end to end.

1. **Create a second bot** in BotFather. A bot token supports exactly one `getUpdates` consumer, so
   never point a local worker at the deployed bot's token — the update stream splits and both look
   broken.
2. **Disable privacy mode** for it: BotFather → *Bot Settings* → *Group Privacy* → *Turn off*. With
   privacy on, the bot receives almost no messages, which is indistinguishable from a code bug.
3. **Create a private group**, add the bot, and **promote it to administrator**.
4. **Get the chat id** — send any message in the group and read `chat.id` from
   `https://api.telegram.org/bot<token>/getUpdates`. A supergroup id is negative, e.g. `-1001234567890`.
5. Set `TELEGRAM_CHAT_ID` to that single id. A comma-separated list is rejected: it would parse as
   `NaN`, match no chat, and still poll successfully.
6. Set `COORDINATOR_TELEGRAM_ID` to your own numeric Telegram id. Only that account can answer an
   approval; verification and clarification questions accept anyone in the group.
7. Re-run the backfill with the real chat id so the history is visible to the poll loop.

## 13. When something is wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ECONNREFUSED ... 5432` / `5433` | The `.env.example` port drift | Make `.env` and `docker-compose.dev.yml` agree |
| `TEST_DATABASE_URL is identical to DATABASE_URL` | Both point at `baton` | Point tests at `baton_test` |
| `database "baton_test" does not exist` | Compose only creates `baton` | Step 4's `createdb` |
| Tests fail on `violates foreign key constraint` | Two suites sharing `baton_test` | Run one suite at a time and retry |
| Agent suite dies with `Zone Allocation failed` | Strands SDK loaded per worker | Already handled by `fileParallelism: false` — don't override it |
| Worker exits naming a variable you can see is set | A shell exported it as `""`, which Node's loader treats as set | The dev entry points use `loadDotEnv` with `override: true`; unset the empty shell variable |
| Agent refuses to start on `AGENT_PORT` | Non-numeric value | It is rejected deliberately rather than binding `NaN` on an arbitrary port |
| Worker starts but reads nothing from the group | Privacy mode on, or wrong chat id | Step 12.2 and 12.4 |
| No brief ever fires | Bot is not an administrator | Step 12.3; the startup log warns about exactly this |
| `pnpm build` fails in `apps/web` with `EPERM` | Windows symlink privilege during `standalone` | Known; use `pnpm --filter @baton/core build` for tests, and build the web image on Linux |

---

# Part 2 — Deploying to production

**Topology, and the one rule behind it:** AWS holds stateless compute and nothing else; Coolify holds
everything stateful. Neither shares a credential with the other.

| Where | What |
| --- | --- |
| Coolify on the VM | Postgres, worker, web, and the Traefik proxy that terminates TLS |
| AWS | AgentCore Runtime (the agent container), ECR, CodeBuild, IAM, CloudWatch Logs |
| Deliberately absent | No VPC, no RDS, no load balancer, no Secrets Manager, no Lambda |

Postgres is never reachable from AWS. The agent reaches the worker's read-only data API over the
public HTTPS route, with a bearer token.

## Step 0 — Pre-flight

Have these in hand:

- A VM running Coolify, and a domain with DNS you can edit.
- An AWS account, with the AWS CLI authenticated for an administrative principal to do the setup.
- Two BotFather bots — demo and local — and the numeric Telegram id of each operator.
- A model provider key for an OpenAI-compatible endpoint, and its base URL.
- Long random strings for `DATA_API_TOKEN`, `SESSION_SECRET`, and a passcode for `ADMIN_PASSCODE`.

Then settle the three gaps named at the top of this document:

1. **Implement the SigV4 transport** (`AgentCoreTransport.invoke` in
   `apps/worker/src/agent/transport.ts`). `@aws-sdk/client-bedrock-agentcore` is already a dependency.
   Without this the deploy completes and the product does not work.
2. **Decide the arm64 story.** Deploying the agent through the AgentCore CLI makes it moot — CodeBuild
   builds arm64 remotely. Building locally to push requires `docker buildx build --platform linux/arm64`
   and the emulation slowness that implies.
3. **Prove the web image builds on Linux**, before you rely on Coolify building it.

Finally, verify the images build at all — from the **repository root**, which every Dockerfile requires
because `packages/core` is a workspace dependency:

```bash
docker build -f apps/agent/Dockerfile .     # known good: ~73s, 385MB
docker build -f apps/worker/Dockerfile .
docker build -f apps/web/Dockerfile .
```

## Step 1 — BotFather

For the demo bot: create it, **turn Group Privacy off**, and keep the token somewhere you can paste it
into Coolify. Do not add it to the group yet — that is step 6, after the stack is up, so the first
messages it sees arrive at a worker that can process them.

## Step 2 — DNS and TLS, before anything AWS

Point two hostnames at the VM — one for the admin UI, one for the worker's data API. In Coolify, create
the resource (step 3) and set its domains.

**TLS must be issued before the agent is deployed.** `DATA_API_URL` is set on the AgentCore runtime at
launch and has to resolve to a real HTTPS endpoint; a runtime launched against a hostname with no
certificate cannot reach the data API and the failure appears as unexplained tool errors in the trace.

Because neither container listens on port 80, the port must be included in Coolify's domain field:
worker `8081`, web `3000`. Do **not** use the `SERVICE_FQDN_*_<port>` magic variable instead — the
port-suffixed form has open bugs binding the wrong value.

## Step 3 — Postgres, worker and web on Coolify

**Create one Coolify resource of type Docker Compose**, pointed at `docker-compose.yml` in the
repository root. Not three Application resources. This is the most important decision in the deploy:

Coolify applies rolling updates to Application resources — the replacement container starts before the
old one stops. Two worker containers running at once means two `getUpdates` consumers on one bot token,
splitting the update stream unpredictably. The bot would answer some messages and silently drop others,
with nothing in either log looking wrong. Coolify does not roll Compose deployments, so Compose gives
stop-then-start semantics for free.

If web and worker are ever split into separate Application resources, **rolling updates must be
disabled on the worker specifically.**

Set these in Coolify's per-resource environment configuration — never in a file beside the code:

| Variable | Value |
| --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Your choice; the compose file requires all three |
| `TELEGRAM_BOT_TOKEN` | The demo bot's token |
| `TELEGRAM_CHAT_ID` | The demo group's id — a single negative integer |
| `COORDINATOR_TELEGRAM_ID` | Operator id, or a comma-separated list of operators |
| `DATA_API_TOKEN` | Long random string; the same value goes on the agent |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The worker's IAM user from step 4 |
| `AGENTCORE_RUNTIME_ARN` | Empty for now; filled in step 5 |
| `ADMIN_PASSCODE`, `SESSION_SECRET` | The judge passcode and the cookie signing secret |
| `ORG_TIMEZONE` | `Asia/Kolkata` |

`AGENT_TRANSPORT` is hardcoded to `agentcore` in the compose file, and `DATABASE_URL` is composed from
the Postgres variables — neither needs setting.

**Because `AGENTCORE_RUNTIME_ARN` is required when the transport is `agentcore`, the worker will refuse
to start until step 5.** That is expected on the first deploy: bring the stack up, confirm Postgres and
web, and accept a restarting worker until the ARN exists. If you would rather have a green stack
throughout, deploy first with the worker service commented out.

Then deploy, and set the health check for the worker service to `GET /health` — never a `/data/*` route,
which answers 401 and reads as unhealthy, restart-looping past the worker's own backoff.

Verify:

```bash
curl -sSf https://<web-domain>/login              # 200, the passcode form
curl -sSf https://<worker-domain>/health          # {"status":"ok"}
curl -i https://<worker-domain>/data/facts?q=x    # 401 — the token is doing its job
docker exec -it <postgres-container> psql -U <user> -d <db> -c '\dt'   # 21 tables
```

**Verify Postgres is not published**, from a machine that is not the VM — Coolify has a public-port
toggle for database resources, so this is an active check, not a structural guarantee:

```bash
nc -vz <vm-public-ip> 5432       # must fail
```

Migrations run automatically: the worker's entrypoint runs them before it opens its HTTP server.

## Step 4 — The agent on AgentCore

AgentCore's contract, which `apps/agent` already satisfies: `POST /invocations`, `GET /ping`, port
8080, image in ECR, **`linux/arm64`**.

First, two IAM identities — they are different things and conflating them is the common mistake:

- **An execution role** assumed by the runtime, permitting ECR pull and CloudWatch Logs write.
- **An IAM user for the worker**, scoped to `bedrock-agentcore:InvokeAgentRuntime` and nothing else.
  Its keys are the only AWS credential the project holds.

### Path A — the AgentCore CLI (what the design chose)

CodeBuild builds arm64 remotely, so the VM and your laptop need no arm64 Docker at all. The CLI's flags
move between versions — run `agentcore --help` and follow the current form. Shape:

```bash
agentcore configure      # name the runtime, point it at apps/agent/Dockerfile, pick the execution role
agentcore launch         # CodeBuild builds, pushes to ECR, creates the runtime
```

### Path B — manual, if the CLI does not fit

```bash
aws ecr create-repository --repository-name baton-agent --region <region>

aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com

docker buildx create --use
docker buildx build --platform linux/arm64 \
  -f apps/agent/Dockerfile \
  -t <account-id>.dkr.ecr.<region>.amazonaws.com/baton-agent:latest \
  --push .

aws bedrock-agentcore-control create-agent-runtime \
  --region <region> \
  --agent-runtime-name baton_agent \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"<account-id>.dkr.ecr.<region>.amazonaws.com/baton-agent:latest"}}' \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --role-arn arn:aws:iam::<account-id>:role/<execution-role> \
  --environment-variables file://agent-env.json
```

Confirm the exact parameter names with
`aws bedrock-agentcore-control create-agent-runtime help` — this API is young and the shape has moved.

`agent-env.json` — the agent's whole environment, set at launch:

| Variable | Value |
| --- | --- |
| `MODEL_BASE_URL`, `MODEL_API_KEY` | The provider endpoint and key |
| `DEFAULT_MODEL` | Fallback for any unset per-role model |
| `CURATOR_MODEL`, `CARTOGRAPHER_MODEL`, `ASSESSOR_MODEL`, `RESTRAINT_MODEL`, `BRIEFER_MODEL`, `RESPONDENT_MODEL` | Optional; each falls back to `DEFAULT_MODEL` |
| `MODEL_MAX_TOKENS` | Optional; defaults to 8192. Leave it unless a node starts failing validation on truncated output — see the note below |
| `DATA_API_URL` | `https://<worker-domain>/data` — must be publicly resolvable **now** |
| `DATA_API_TOKEN` | The same string the worker holds |

Leave `AGENT_PORT` **unset**: AgentCore sets `PORT` itself, and the agent reads `AGENT_PORT` first.

**On `MODEL_MAX_TOKENS`.** The agent bounds output at 8,192 tokens per call by default, and that default
exists because of a real failure: with no ceiling set, the request declares the model's own maximum —
131,072 on the configured model — and a provider that authorises credit against the *requested* ceiling
rejects the call outright with `402 ... You requested up to 131072 tokens, but can only afford 33326`.
That message reads as an account problem while being half a configuration one.

Verify — a `/ping` that answers and a rejected-envelope round trip both prove more than a green status:

```bash
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <id> --region <region>
aws logs tail /aws/bedrock-agentcore/<runtime> --follow --region <region>
```

A malformed envelope should come back as a 400 saying *"Invalid agent request envelope"*. That is the
agent's own contract check, and seeing it means the container is alive and the request reached the route.

## Step 5 — Point the worker at the runtime (gate G4)

Set `AGENTCORE_RUNTIME_ARN` in Coolify to the ARN from step 4 and redeploy the resource. The worker
logs `[worker] agent transport: agentcore` on start.

This is the step that fails today if the SigV4 client is still a stub: the first tick with work to do
rejects with *"AgentCore transport not implemented yet"*, the failure counter climbs, and the backoff
cap eventually stops the loop. That is the designed behaviour for a persistent failure — an unattended
crash-loop is the cheapest way to spend real money here — not a new bug.

You can verify a real SigV4 implementation without a full VM round trip: on your laptop, set
`AGENT_TRANSPORT=agentcore` with the production ARN and the worker's IAM keys, and run the worker
locally against the deployed runtime.

## Step 6 — The bot into the group (gate G6)

1. Add the demo bot to the rescue group.
2. **Promote it to administrator.**
3. Confirm privacy mode is off.
4. Send a message; confirm the worker logs an intake cycle that read it.
5. Have someone join or leave; confirm a `chat_member` event arrives and a brief is written. Silent
   failure here is indistinguishable from a code bug later, which is why it is a gate.

The worker logs a warning at startup if it is not an administrator. Read the deploy log rather than
assuming.

## Step 7 — Data, then the golden dump

On the VM, with the real chat id:

```bash
pnpm seed:plan
pnpm seed:transcript                      # full six months; needs the SEED_TELEGRAM_ID_* values
pnpm backfill -- --chat-id <real-chat-id>
```

Then, once a backfill has produced output you are happy with, take the golden dump — the reset point
`reset-demo.ts` restores after a judge clicks Dismiss:

```bash
docker exec <postgres-container> pg_dump -U <user> <db> > baton-golden.sql
```

**Data moves one direction only: deployed → local.** Never restore a local dump over the deployed
database; that destroys the reset point. Note that `scripts/reset-demo.ts` is still a stub that prints
*"not implemented"* — restoring is a manual `psql` today.

Stop any worker before backfilling: it takes the pipeline advisory lock and exits rather than queueing.

## Step 8 — Post-deploy checklist

| Check | How |
| --- | --- |
| Web reachable over TLS | `curl -sSf https://<web-domain>/login` |
| Passcode gate actually gates | Request `/` with no cookie — it must not return register content |
| Worker healthy | `curl -sSf https://<worker-domain>/health` |
| Data API closed | `curl -i https://<worker-domain>/data/facts?q=x` → 401 |
| Data API open with the token | Same request with `Authorization: Bearer …` → 200 |
| Postgres not published | `nc -vz <vm-ip> 5432` from elsewhere → fails |
| Migrations applied | `\dt` shows 21 tables |
| Agent reachable from the worker | A tick that invokes the agent completes; a `runs` row is written |
| Redeploy does not overlap containers | Redeploy and watch: the old container must stop before the new one starts |

## Step 9 — Redeploying

**A change to `packages/core` deploys agent first, then worker.** The Zod envelope is the contract
between them and they deploy independently, so a shape change opens a window where one validates
against the other's old schema. Agent first, then worker: the worker has exponential backoff and the
outbound queue retains its work, so a few seconds of failed invocations cost nothing. Deploying the
worker first means it sends a shape the agent rejects, and the agent's 400 is the only clue.

**Worker-only or web-only changes** are a plain Compose redeploy — stop-then-start, no overlap.

**Agent-only changes** are `agentcore launch` again. The container is stateless: nothing to drain, and
nothing is lost.

## Step 10 — Cost hygiene

- AgentCore may bill by session lifetime rather than request processing. `transport.close()` exists and
  the worker calls it on shutdown, but **not per task** — whether it should is gate `G8`, and it waits
  on that answer rather than guessing. Confirm the billing boundary before leaving the stack running.
- An idle worker calls no model at all: the sweep short-circuits in SQL when the candidate set is
  unchanged. A 15-second tick gap is affordable because of that.
- The failure cap exists so a revoked API key cannot cost money overnight. Do not raise it to "get past"
  a persistent error.
