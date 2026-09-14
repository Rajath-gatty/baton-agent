# Baton — Technical Architecture

**Date:** 2026-09-12
**Status:** Awaiting user review, then implementation planning
**Companion to:** `2026-09-12-baton-design.md`, which owns product scope, features, and the demo
contract. This document owns how it is built. Where they disagree, the product design wins.

## Constraints

Given, not chosen:

- TypeScript throughout, with the Strands Agents SDK.
- AgentCore Runtime deployment is mandatory.
- Model access is via an external provider (DeepSeek-class), using the user's own API keys. No Bedrock.
- Postgres is self-hosted on the user's own cloud VM, outside AWS. The VM has Docker and sufficient
  CPU and RAM for Postgres plus two Node processes.
- **Coolify is already installed on the VM** and owns ports 80 and 443. It is therefore the deployment
  platform and the reverse proxy, and no second proxy may be introduced. An earlier revision of this
  document specified a hand-configured Caddy; that has been removed, because a second process binding
  the same ports does not coexist with Coolify's proxy, it fights it.
- Next.js for the admin UI.
- S3 is available if needed.

## Verified before designing

Three assumptions were checked rather than assumed, because each would have invalidated part of the
design:

**The Strands TypeScript SDK supports interrupts.** `event.interrupt({ name, reason })` on
`BeforeToolCallEvent` and `BeforeToolsEvent`, `result.stopReason === 'interrupt'`, `result.interrupts`,
and resume by passing `interruptResponse` blocks back into `agent.invoke()`. Tool callbacks receive a
`context` with the same capability. One third-party source claims otherwise; it describes that
project's own integration, not the SDK.

**AgentCore hosts TypeScript.** Express plus Docker on Node 22+, with an official Strands deployment
guide. An AgentCore CLI can build remotely via CodeBuild, so a local Docker daemon is optional.

**`Graph` is available in TypeScript** — `new Graph({ nodes, edges })`, a deterministic DAG, with
`BeforeNodeCallEvent` interruptible. The pipeline uses the SDK's own orchestration primitive rather
than hand-wired calls.

## Topology

**On the VM, outside AWS**

| Component | Responsibility |
| --- | --- |
| Postgres | All state. Reached over the Docker network only; never published to a host port. |
| `worker` | Long-running Node process. Telegram long polling, deterministic pre-filter, all persistence, orchestration of agent calls, outbound message queue, scheduler, read-only data API, `/health`. |
| `web` | Next.js admin UI, reading Postgres over the Docker network. |
| Coolify | Deployment platform. Its proxy — Traefik by default — terminates TLS, issues Let's Encrypt certificates from each resource's domain field, and routes the admin UI and the worker's data API. Also holds the environment variables for both. |

**On AWS**

| Component | Responsibility |
| --- | --- |
| AgentCore Runtime | Express plus the Strands agents. **Stateless.** Never touches Postgres. |

**External:** the model provider, called from inside the AgentCore container; the Telegram Bot API,
called only from the worker.

**Telegram long polling, not webhooks.** The VM is always on, so `getUpdates` removes the need for a
public HTTPS endpoint for the bot, removes webhook timeout pressure from the design, works behind NAT,
and needs no re-registration after a restart.

### Telegram integration, precisely

More of the design depends on Telegram's delivery rules than is obvious, and the defaults are wrong
for this product in three separate ways.

**`allowed_updates` must be set explicitly.** By default `getUpdates` does not deliver `chat_member`
updates. The brief fires from a membership event, and that event is the first fifteen seconds of the
video, so the poll call must request `["message", "edited_message", "chat_member", "my_chat_member"]`.

**The bot must be a group administrator.** `chat_member` updates are only delivered to administrators.
A non-admin bot in a supergroup can miss a voluntary departure entirely, which fails silently — the
demo simply does not happen.

**Privacy mode must be disabled through BotFather**, or the bot receives only messages that mention it
and appears completely broken while being configured exactly as documented.

**Telegram never tells bots about deletions.** There is no deletion update of any kind. The design's
withdraw-provenance behaviour is therefore reachable only as a coordinator action in the admin UI, and
the product document now says so. Claiming otherwise would be a feature that cannot exist.

**Edits arrive as a different update type.** An `edited_message` for a message already curated means
the derived facts came from text that no longer exists. Handling: reset `curated_at` and
`prefilter_verdict`, re-run the pre-filter and curation, and supersede the facts the old text produced
rather than mutating them.

**Intake and processing are separate loops.** The poll loop only normalises, deduplicates and persists;
a second loop consumes unprocessed messages. Doing curation inside the poll loop would block intake for
the duration of a model call, so a slow Curator would stall the live demo at exactly the wrong moment.
This split is also what makes the advisory lock sufficient.

**Outbound is a throttled queue.** Telegram permits roughly twenty messages a minute to one group.
Every outbound message — answers, approval requests, the introduction — passes through one queue with
its own rate limit, so a burst during backfill cannot get the bot restricted.

**Seed people must be linked to real Telegram accounts.** The seeded transcript creates `people` rows
with no Telegram user id. The two or three accounts used in the live demo must be bound to the correct
seeded person during seeding — the volunteer who leaves on camera has to be the same person who set up
the donation page, or the orphan finding does not appear and the entire opening case collapses. This is
a scripted step, not a manual one.

**AgentCore is stateless by deliberate choice.** Input is a task, a payload, and hydrated context;
output is structured results. Consequences: database credentials exist in exactly one place, there is
no VPC or network plumbing, Postgres is never reachable from AWS, and the agent container is
trivially redeployable. The worker holds all authority to write.

The worker invokes AgentCore with SigV4, so the VM needs one IAM user scoped to
`bedrock-agentcore:InvokeAgentRuntime`. That is the only AWS credential in the system.

**Why the UI sits on the VM rather than Vercel.** Postgres is already there. Co-locating avoids
exposing the database to the internet, avoids serverless-to-self-hosted connection exhaustion, and
means one TLS setup instead of two.

## Repository layout

pnpm workspaces. No Turborepo — its configuration cost is not repaid at this size.

```
baton/
  apps/
    agent/    → AgentCore: Express + Strands agents. Dockerfile.
    worker/   → Telegram long-poll, pre-filter, persistence, scheduler, data API, /health. Dockerfile.
    web/      → Next.js admin UI. Dockerfile.
  packages/
    core/     → Zod schemas, Drizzle schema, shared types, prompts, redaction
  scripts/
    seed-plan.ts        → roster, calendar, asset inventory, coverage placements; output committed
    seed-transcript.ts  → renders prose against the plan, then verifies coverage and exits non-zero on a gap
    backfill.ts
    reset-demo.ts
  docker-compose.yml       → the Coolify deployment stack
  docker-compose.dev.yml   → local Postgres only
  tsconfig.base.json       → strict, extended by every workspace
  eslint.config.mjs        → one config for all workspaces
  .env.example             → the environment contract, no values
  .gitattributes           → eol=lf
```

`packages/core` carries more weight than its size suggests: the Zod schemas defining the Curator's
structured output are the same schemas the database and the UI validate against. The contract between
the three apps is one file rather than three copies that drift.

Four build-level decisions follow from this layout, and each of them fails in a way that looks like
something else:

**`@baton/core` exports resolve to `dist`, not `src`.** The worker and web containers run
`node dist/main.js`, so a `src`-pointing export would work under `tsx` in development and fail only
inside the image. The consequence is a build order — core before either app — which `tsc` project
references handle for typecheck and each Dockerfile handles explicitly for runtime.

**The core barrel does not re-export `./db`.** Database access is reachable only through the explicit
`@baton/core/db` entry point, so the agent cannot acquire a client transitively by importing schemas.

**The no-database-client rule in `apps/agent` is enforced by lint, not by inspection.** The root ESLint
config restricts `pg`, `postgres`, `drizzle-orm` and `@baton/core/db` inside that workspace. Dependency
inspection catches a declared dependency; it does not catch an import that resolves through a hoisted
`node_modules`, which is exactly how this rule would be broken by accident.

**The web image uses Next's standalone output**, with `outputFileTracingRoot` set to the repository root.
Standalone resolves the pnpm workspace symlink into real files, which is what makes `@baton/core` work in
the container without a second install. Left at the default, the trace stops at `apps/web` and the image
is missing core entirely.

**Line endings are normalised to LF** by `.gitattributes`. Prettier is configured `endOfLine: "lf"`, and
without this git on Windows checks out CRLF and `pnpm format` then fails on every file in a fresh clone —
a first experience that reads as a broken config rather than a line-ending mismatch.

## The agent layer

### Five tasks, not one graph

The AgentCore container exposes the standard `/invocations` endpoint and dispatches on a `task` field.

| Task | Composition | Trigger |
| --- | --- | --- |
| `ingest` | `Graph`: Curator → Cartographer | A batch of candidate messages |
| `assess` | `Graph`: Assessor → Restraint (hook) | Periodic sweep, or after a material change |
| `brief` | Briefer, with Restraint hooked on produce | Telegram join or leave event |
| `respond` | Respondent, with Restraint hooked on produce | A question in the group |
| `resume` | Any of the above, restored from a snapshot | An approval or clarification answer arriving |

Three of the five tasks produce text a human reads, and Restraint hooks all three. `ingest` produces no
outbound text and is the one task it does not touch.

Splitting these is a performance decision with product consequences. One monolithic graph would
re-run extraction on every sweep, making the register slow to update at exactly the moment a judge is
watching.

`Graph` rather than `Swarm` because pipeline order is fixed and agents must not choose their own
routing — and because `BeforeNodeCallEvent` is interruptible, which is where Restraint attaches.

### Detection is SQL; judgment is the agent

Every candidate finding is a plain query:

| Finding subtype | Query |
| --- | --- |
| `sole_holder` | `holdings` grouped by asset, having exactly one active holder |
| `sole_holder` (capability variant) | `capability_coverage` grouped by capability, having one person |
| `no_owner` | active asset with no active holding |
| `not_ours` | active holding with `is_personal_resource` |
| `loose_end` | open commitment past threshold, with or without an owner |

Five queries, four subtypes: capability single-coverage presents as `sole_holder` because to a
coordinator it is the same problem, and an owned and an unowned loose end differ only in phrasing. The
subtype set the UI renders matches the product document exactly.

Every one of these queries filters to `status = 'active'`. Facts that are `unverified` or
`pending_approval` are invisible to detection, which is how the product's promise that a pending change
never appears in a finding is enforced in SQL rather than in prompt text.

The Assessor receives these candidates and does the part that needs judgment: severity, phrasing,
aggregation across a capability area, and whether evidence is thin enough to suppress. Asking a model
to count would be slower, more expensive, and less reliable than `GROUP BY`.

### No vector store

The organisation has on the order of a couple of hundred facts. The whole fact index — claim, id,
holder, last-confirmed — fits in a few thousand tokens and is passed as context. No embeddings, no
pgvector, no search index. Retrieval infrastructure for two hundred rows would be ceremony.

### Where the model is, and is not

| Stage | Implementation |
| --- | --- |
| Pre-filter | Deterministic, in the worker. Recall-biased heuristics. |
| Curator | Model, Zod structured output. The five-way classification plus extracted records. |
| Cartographer | Deterministic fuzzy alias matching; model call **only** on ambiguity. |
| Assessor | Model, structured output, over SQL-derived candidates. |
| Restraint | Model, attached as a hook rather than a node. |
| Briefer | Model, structured output, three sections. |
| Respondent | Model, over the passed fact index. |

Seven stages, six agents — the pre-filter is plain code, and it is what allows the six to run on a cheap
model at all.

**Pre-filter.** Heuristics over roughly four and a half thousand seeded messages, of which about one in
five reaches a model. Tuned for recall: a false keep costs a fraction of a cent, a false discard loses
knowledge before anything is stored. `prefilter_version` exists so a better filter can re-examine prior
rejections.

**Curator.** One model call classifies a message five ways and extracts records. Cost and latency
concentrate here — this is roughly eighty percent of token volume — which is why the cache is keyed per
message and why messages are classified independently. Its schema is the flattest in the system by
deliberate choice, because this is the call that runs thousands of times and any per-call failure rate
compounds across the backfill.

**Cartographer.** Mostly deterministic. Alias resolution is fuzzy string matching against
`person_aliases`, which handles the overwhelming majority of cases at zero model cost. The model is
invoked only when an alias resolves to more than one person — and its permitted output there includes
*cannot determine*, which becomes a question rather than a guess. Holdings are append-only: a transfer
closes one row and opens another.

**Assessor.** Consumes the five detection queries. It never counts, groups or filters — SQL has already
done that, faster and more reliably than any model would. Its structured output is severity, phrasing,
aggregation across a capability area, and a suppression decision. Because it runs once per sweep rather
than once per message, it is the cheapest place in the system to spend money on a better model.

**Restraint.** A model call attached via `addHook` on the produce path rather than placed in the graph as
a node. The distinction is not stylistic: as a hook it cannot be routed around by the other agents, so the
veto holds structurally rather than by convention between prompts. Withheld items are written to
`quiet_decisions` with their reasoning, which is what makes the restraint behaviour demonstrable instead
of merely claimed.

The hook is registered on all three producing tasks — `assess`, `brief` and `respond` — so its scope is a
property of the container's wiring rather than of any one graph. Registering it only inside `assess` leaves
ungated the two surfaces a judge actually reads.

**Gating differs by output class**, because one rule applied to all three would be wrong in both
directions:

| Output class | Gate |
| --- | --- |
| Findings | Only where `dedupe_key` is new or severity has changed |
| Brief lines | Every line, every time a brief is generated |
| Answers | Every answer, before it is returned to the worker |

Briefs and answers are each produced once in response to one event and never recomputed, so there is
nothing to re-judge and no natural identity to key a gate on. Findings are the opposite case, and the
gate there earns its complexity twice over: because sweeps re-derive them from scratch, an ungated
Restraint would re-veto the same thirty settled items on every sweep forever — the second-largest model
consumer in the system, producing no new information. It is also a correctness point. Re-judging a settled
finding lets the quiet-decisions strip churn between sweeps, so the coordinator sees withheld items appear
and disappear for no reason they can observe.

The asymmetry is affordable because of volume: on the order of a hundred briefs and a couple of hundred
answers across the whole build, against thousands of finding evaluations.

**Briefer.** One call, three fixed sections, structured output as line-level records rather than prose
blocks — because `brief_lines` rows are individually assignable and each carries its own evidence
reference. Its difficulty is tone rather than logic, which is an argument for a stronger model on this
agent specifically.

**Respondent.** One call over the hydrated fact index — a couple of hundred claims, a few thousand tokens
— which is precisely why there is no vector store in this system. Its non-answer paths (stale, ambiguous,
unknown) are separate branches of the output schema, not a free-text field, so the UI and the tests can
depend on them.

**Why six agents rather than one.** One judgment each keeps prompts small and schemas flat, and flat
schemas are what cheap models reliably conform to. Failures localise to a single prompt. Models are
configurable per agent, so the three that produce read-aloud prose can be upgraded without touching the
one that dominates cost. And the split into two graphs — Curator → Cartographer for `ingest`, Assessor →
Restraint for `assess` — is what stops each periodic sweep from re-running extraction across the whole
history.

### Batching, and why the cache constrains it

The Curator is prompted with several messages at once to amortise the system prompt, but each message is
classified **independently** — the prompt forbids cross-message inference — and the cache is keyed per
message on `content_hash` plus `prompt_version`.

This ordering matters and is easy to get wrong: cache lookups happen *before* batches are formed, and
batches are assembled only from misses. Caching whole batches instead would be nearly worthless, since
batch composition changes on every run and a single new message would invalidate nine cached
classifications. Independent classification is what makes per-message caching sound, so it is a
correctness requirement rather than a prompt style preference.

### Context hydration per task

Hydrating everything into every request would multiply cost by the size of the register, so each task
receives only what it can use:

| Task | Hydrated context |
| --- | --- |
| `ingest` | The candidate messages, the alias table, and the assets index. **Not** the fact index — the Curator classifies text, it does not consult the register. |
| `assess` | Candidate findings from SQL, open commitments, organisation-level norms. |
| `respond` | The fact index — claim, id, holder, last-confirmed — plus the alias table. |
| `brief` | The subject's holdings, their open commitments, and coverage sets touching them. Not the whole register. |

The fact index is a few thousand tokens; sending it on every Curator call would make it the dominant
cost in the system for no benefit.

### Tools

The agent container has no database credentials, but agents without tools would be a weak use of the
SDK. So the worker exposes a narrow, token-authenticated data API on the domain Coolify already routes,
and the agent's Strands tools call it:

- `searchFacts(query)`
- `getEvidence(factId)`
- `getHoldings(assetRef)`
- `getPerson(alias)`

All read-only. The agent never writes; it returns proposed changes and the worker decides. Predictable
context is hydrated into the request payload; tools exist for pull-based lookups the agent cannot know
it needs in advance, chiefly drilling into evidence. Tool calls appear in traces, which is what feeds
the agent activity panel.

**The worker also serves an unauthenticated `GET /health`**, on a separate path from the data API but on
the same port, and therefore reachable on the public domain. That is accepted rather than prevented: it
returns a status and nothing else, so it must simply stay free of anything worth authenticating.
Separating it onto a second unrouted listener would be machinery bought for no gain. The endpoint exists
for Coolify, not for the product: Coolify's health checks want an HTTP endpoint, and pointing one at the
token-protected data API returns 401, which Coolify reads as unhealthy and answers by restarting the
container. That restart loop would bypass the worker's own exponential backoff — the mechanism
specifically added to stop unattended retry storms — while also re-running migrations and disturbing the
polling offset on every cycle. The endpoint returns a plain 200 after the database connection is
established, and nothing else.

**Coolify routes each service from a domain assigned in its UI, and that domain must carry the port**,
because neither the worker (8081) nor web (3000) listens on 80. The port-suffixed `SERVICE_FQDN_*` magic
variables are the documented alternative but have open bugs binding the wrong value across multiple
services, so the UI is the path to use.

### Models per agent

Every agent's model is set from its own environment variable — `CURATOR_MODEL`, `ASSESSOR_MODEL`, and
so on. The Curator runs on every candidate message and dominates cost and latency; the Assessor,
Restraint and Briefer produce the text a judge reads but consume under 4M tokens across the entire
build. Building on one cheap model everywhere, with the ability to point three agents at a stronger
model by changing environment variables, is deliberate insurance on output quality.

### Structured output reliability

The pipeline depends on strict schema conformance, and a cheap model's failure mode is not a crash but
plausible output that is subtly wrong — which surfaces as findings that look arbitrary. Two defences:
validate every response against its Zod schema and retry with the validation error fed back, and keep
schemas flat. Nested schemas are where cheap models break.

## Database schema

Postgres with Drizzle.

**Identity.** `people` (telegram user id nullable, since some people only appear by name; display
name; status `member` / `left` / `unknown`; joined and left timestamps). `person_aliases` (alias, and a
`kind` of handle / display name / nickname / first name / role reference). Alias is deliberately not
unique — two volunteers can both be "Priya", and ambiguity is *detected* by an alias resolving to more
than one person, which is precisely when the Cartographer escalates instead of guessing.

**Intake.** `messages` (source `telegram` or `seed`, sender, sent-at, text, reply-to, flags for
forwarded / edited / withdrawn / unprocessed, `prefilter_verdict`, `prefilter_version`, `curated_at`,
`content_hash`). Unique on `(chat_id, telegram_message_id)`.

`curator_cache`, keyed on `content_hash` plus `prompt_version`. Built on day one, not as a later
optimisation: it makes re-running backfill free and fast, and iteration speed matters more than the
money saved.

**Knowledge.** `assets` (one of six kinds, name, normalised key, `sensitivity` — which drives whether
an approval goes to the group or privately to the coordinator). `facts` (claim, confidence, source
message, stated-by, stated-at, `last_confirmed_at`, status `active` / `superseded` / `retired` /
`unverified` / `pending_approval`, `supersedes_fact_id`, `curator_reasoning`, **`match_key`**).
`holdings` (asset, holder nullable — null *is* the no-owner finding — `holder_external`,
`is_personal_resource`, `acquired_at`, `released_at`; transfers end one row and open another, nothing is
overwritten). `commitments` (substance, owner nullable — null is an unowned intent — promised-at,
deadline nullable, completion evidence, status, `asked_once_at`). `capabilities` and
`capability_coverage`.

`facts.match_key` — a normalised asset reference plus claim key — is what makes merge-on-restatement
possible. Without it there is no way to recognise that a new message restates a fact already held, so
every mention of the van keys becomes another row and the register fills with near-duplicates that all
look active. A restatement bumps `last_confirmed_at` and appends evidence; only a contradiction creates a
new row and sets `supersedes_fact_id`. This column does for facts what `dedupe_key` does for findings,
and omitting it produces the same class of failure.

**Findings.** `findings` (type, subtype, title using capability-subject phrasing, why-it-matters,
severity, confidence, subject reference, `holder_person_id` as a plain attribute, evidence, status,
dismissal reason, first and last seen, `assessor_reasoning`, and **`dedupe_key`**).

`dedupe_key` is the most important column in the schema. Sweeps re-derive findings from scratch, so
without it every sweep would either duplicate the register or resurrect something already dismissed.
Dismissals are recorded against the key, which is what makes dismissal actually permanent.

`quiet_decisions` (what was withheld, the reason, the run).

**Human loop.** `questions` (kind `verification` / `clarification` / `approval`, target, asked text,
the bot's Telegram message id so replies can be matched, answer, resolution, Strands `interrupt_id`
and `interrupt_name`, plus `status` including a `queued` state and a **nullable `asked_at`**).
`pending_changes` (proposed write, consequence, status). `agent_sessions`
(task, Strands session id, serialised snapshot).

**The ask budget is enforced in SQL against `questions`, not in a prompt.** Two open at a time and three
new per rolling twenty-four hours are both plain counts — `status = 'asked' and answer is null` for the
first, `asked_at > now() - interval '24 hours'` for the second — and priority is derived from `kind`
rather than stored, because approval outranking clarification outranking verification is fixed policy and
not a per-question judgment. A question that cannot be asked yet is inserted with `status = 'queued'` and
a null `asked_at`, which is why that column is nullable: an `asked_at` defaulting to insertion time would
make the rolling window count questions that were never sent. Nothing is discarded and nothing is asked
twice, and the waiting-on line renders queued and asked rows together, since to the coordinator both mean
Baton is holding something back pending an answer.

Consequence classification is **deterministic**, derived from the asset's kind and sensitivity, not
asked of a model. Whether a write is high-consequence is a policy question with a fixed answer —
financial control, credentials and named contacts for critical relationships always are — and letting a
cheap model decide would make the approval gate itself unreliable, which is the one thing that must not
be. The model supplies confidence; code supplies consequence; the matrix combines them.

**Operational.** `runs` (messages read, candidates, facts extracted, candidates *skipped*, findings
produced, and a JSONB `trace` — this table is the agent activity panel). `briefs` and `brief_lines`
(sections as line rows, because lines are individually assignable and each carries its own evidence).
`coordinator_state` (one row: `last_seen_at`). `app_settings` (chat id, org name, timezone,
coordinator person id).

The trace is returned by the agent in its response payload — nodes visited, model used, token counts,
tool calls made, and each agent's reasoning line — and stored by the worker. It is not read from
CloudWatch. The activity panel needs the trace in the same database as everything else it renders, and
an observability round trip to AWS for a panel in a self-hosted UI would be infrastructure bought for
nothing.

Auth needs no table: the passcode is exchanged for a signed cookie.

**Indexes that matter.** `messages(prefilter_verdict, curated_at)`, `facts(asset_id, status)`,
`holdings(asset_id, status)`, `findings(status, severity desc)`, `curator_cache(content_hash,
prompt_version)`.

**What is absent, structurally.** There is no attendance table and no per-person score column anywhere
— no completion rate, no reliability figure, no activity metric. The product's privacy guarantee is
enforced by the schema, so it cannot be broken by a careless prompt or a late feature. That is worth
stating in the README and in the video.

Because it is stated aloud, it is **tested rather than inspected**: a test introspects the live Drizzle
table objects and fails if any table or column name contains a scoring, ranking or attendance term. It
introspects the objects rather than grepping the source, because the source necessarily contains the words
it forbids — in the comment explaining the rule. The assertions are vacuous until tables exist and become
load-bearing the moment one is added, with nobody having to remember to re-check.

## Runtime flows

**Backfill.** The seeded transcript is normalised and pre-filtered. Candidates go to `ingest` in
batches of ten, strictly ordered by `sent_at`. Cached responses short-circuit the model. Facts,
holdings, commitments and coverage sets are built, then one `assess` pass produces the initial
register. Backfill holds the pipeline advisory lock throughout, so live ingest waits.

**Live message.** Long polling delivers an update. Messages from Baton itself are dropped at intake.
The message is persisted and pre-filtered. If a candidate, `ingest` runs — one model call — and facts
merge, supersede or retire. If a commitment closes, it closes. `assess` runs only if something
material changed.

**Question asked.** The worker recognises an operational question, hydrates the fact index, and calls
`respond`. Restraint gates the answer inside the agent before it is returned. A known fact is answered
with provenance and age; a stale one with a warning; an unknown becomes a question to the group if the
ask budget allows and is queued if it does not. Ambiguous holders route privately to the coordinator.

**Lifecycle event.** Telegram reports a join or leave. `people.status` updates, and `brief` runs
against the register. Restraint gates the output inside the agent. The brief is stored, surfaced in
the UI, and offered to its subject.

**Periodic sweep.** SQL derives candidate findings. If the candidate set is byte-identical to the last
sweep's, the run ends there — **no model is called at all**. Otherwise `assess` judges the changed
candidates, findings upsert on `dedupe_key`, dismissed keys are skipped, and Restraint reviews only new or
re-severitied items. Quiet decisions are written with their reasoning. The since-you-last-looked diff is
computed against `coordinator_state`.

The short-circuit must live in SQL, before the invocation, not in the Assessor's prompt. A sweep that
calls a model and receives "nothing has changed" has already paid for the answer. On a demo system sitting
idle between judging sessions nothing changes for days at a time, and an hourly unconditional sweep would
cost more across a month than the entire build.

**The approval round trip.** The one flow with real mechanical complexity:

1. A node or Restraint raises `event.interrupt({ name, reason })`. The graph halts; AgentCore returns
   `stopReason: 'interrupt'` with the interrupts array and a serialisable snapshot.
2. The worker writes a `questions` row and a `pending_changes` row, and stores the snapshot in
   `agent_sessions`.
3. The worker sends the approval request — to the group, or privately to the coordinator if the asset
   is sensitive.
4. Hours later a reply arrives. The worker matches it to the open question, checks the answerer is
   permitted, and calls `resume` with the snapshot and the `interruptResponse` blocks.
5. The graph continues from the interruption point. The worker applies or discards the pending change.

Snapshot durability, in order of preference: Strands snapshots serialised by the worker into Postgres
(no AWS-side state at all); a durable `SessionManager` storage backend such as S3 if the TS SDK ships
one; and as a floor, a deterministic pending-change path where the agent merely flags that approval is
required and plain code applies it. The floor keeps product behaviour identical but weakens the
interrupts claim, so it is a fallback, not a target.

## Seed transcript generation

The product document owns what the transcript must contain — the coverage table there is authoritative.
This section owns how `seed-plan.ts` and `seed-transcript.ts` produce it, and how the coverage claim is
verified rather than asserted.

**Six months, roughly four and a half thousand messages, twenty people.** Span was reduced from twelve
because span was never what the demo needed. The oldest claim is that a figure has rotted, and five
months carries that as well as eleven while halving Curator volume — which is both the dominant cost and
the slowest step in every backfill iteration, so it halves the cost of being wrong about a prompt too.

**Scaffold before prose.** Generation runs in two deterministic phases, and the ordering is what keeps
the output checkable:

1. **Plan.** A fixed roster of twenty people with their alias forms, a calendar of events across the six
   months, the asset inventory across all six kinds, the capability areas, and an explicit placement for
   every row of the coverage table — which message index carries it, on which date, from whom. This phase
   is pure data and is committed as a fixture, so a regenerated transcript exercises the same paths.
2. **Render.** Prose generated against that plan, in day-sized chunks so a model call never has to hold
   six months in context, with the planted material rendered in place rather than appended.

Writing prose first and hoping the paths appear is the failure mode here: the result reads well, exercises
maybe a third of the pipeline, and gives no signal about which third.

**The coverage report is fail-closed.** After render, the script re-scans its own output for every row of
the coverage table and writes a report naming each row, the messages that satisfy it, and any row with
none. **A missing row is a non-zero exit, not a warning.** The distinction matters because the failure this
prevents is silent: a transcript missing hearsay material does not look broken, it looks fine, and the
first sign of trouble is a prompt nobody can evaluate because there is nothing for it to be right about.

Rows the scanner cannot verify by pattern — that the prose reads as genuinely human, that aggregation
material really sits in one capability area — are reported as *asserted by plan*, traceable to the
placement that claims them. That is weaker than a match but still better than memory, because the claim is
at least written down and attributable.

**Account binding is part of generation, not a follow-up.** The two or three Telegram accounts used on
camera are bound to their seeded people during seeding, and the script asserts the binding: if the person
who will leave on camera is not the seeded holder of the donation page, generation fails. The orphan case
is the first fifteen seconds of the video, and it fails silently otherwise — the brief simply appears with
nothing interesting in it.

**A two-month slice is the development target**, produced by the same plan with a truncated calendar and
its coverage rows compressed into the shorter span rather than dropped. Development against the slice and
a full six-month pass only for the final demo is what keeps backfill iteration cheap.

## Edge cases and how they are handled

| Case | Handling |
| --- | --- |
| Baton ingesting its own messages | Dropped at intake by sender id. Without this, a stale figure it repeated returns as a freshly confirmed fact — a corruption loop with no visible symptom. |
| Membership events not arriving | `allowed_updates` must include `chat_member`, and the bot must be a group administrator. Both defaults are wrong, and the failure is silent: the brief simply never fires. |
| Telegram not reporting deletions | There is no deletion update. Withdrawing provenance is a coordinator action in the admin UI, and the product document no longer claims otherwise. |
| A message edited after curation | Reset `curated_at` and `prefilter_verdict`, re-curate, and supersede the facts the old text produced rather than mutating them. |
| Curation blocking intake | Poll loop persists only; a separate loop curates. Otherwise one slow model call stalls the live demo. |
| Restatement of a fact already held | Matched on `facts.match_key`; bumps `last_confirmed_at` and appends evidence. Without the key, the register fills with active near-duplicates. |
| Who may answer an approval | Verification and clarification accept any group member. Approvals accept only the coordinator; a volunteer's "yes" leaves it unresolved. |
| Two approvals pending on one asset | The second queues behind the first rather than being asked in parallel, since two answers could contradict and the second would silently win. |
| An answer arriving after its pending change was superseded | The question resolves as obsolete and the change is discarded, not applied. |
| Deciding a message is a question | Only when Baton is addressed by mention or reply. A question-mark heuristic in a twenty-person chat would answer rhetorical questions all day. |
| Out-of-order processing | Strict `sent_at` ordering. Supersession is order-dependent, so processing a contradiction backwards silently inverts a fact. |
| Backfill and live ingest colliding | A Postgres advisory lock. Only one pipeline task runs at a time. |
| Sweep running mid-ingest | Same lock. Otherwise findings are computed on half-updated state. |
| Duplicate updates after a crash | Unique `(chat_id, telegram_message_id)` with upsert. The polling offset may be committed after processing, so reprocessing is expected. |
| Pre-filter discarding a real fact | Verdicts stored with `prefilter_version`, so an improved filter re-evaluates prior discards instead of losing them permanently. |
| Replies that don't use Telegram's reply feature | Match on `reply_to` first; then the most recent open question from that sender within a window; then treat as ambiguous rather than guess. |
| Telegram rate limits | One throttled outbound queue for every message type, independent of the ask budget below — the queue protects the API, the budget protects the reader's patience. |
| The ask budget being exhausted | At most two open questions and three new per rolling 24 hours, counted in SQL against `questions`. A blocked ask is inserted `queued` with a null `asked_at`, never dropped and never asked twice. Its claim stays excluded from findings and briefs while it waits, so the cap produces a visible gap rather than an invented fact. |
| A high-consequence approval arriving while the budget is full of verifications | Priority derives from `kind`, so the approval is asked next and the verifications wait. Without ordering, the one ask that must not be delayed is the one a stale-figure check displaces. |
| A seeded behaviour path with no material | `seed-transcript.ts` re-scans its own output against the coverage table and exits non-zero on any unmatched row. A transcript missing a path does not look broken, which is why this cannot be a warning. |
| Repeated bot re-adds during testing | The introduction message is idempotent per chat. |
| A volunteer leaving and rejoining | Membership reactivates; orphan findings close through normal `dedupe_key` re-evaluation. |
| The coordinator leaving | Brief goes to the group; `app_settings.coordinator_person_id` must be reassigned before any approval can resolve. |
| Delivering a brief to someone who has left | A bot cannot message a departed user who never opened a chat with it. The brief is copyable text for the coordinator to pass on; direct delivery is attempted only when possible. |
| Seed identities not matching demo accounts | Seeding binds real Telegram user ids to the seeded people used on camera. If the volunteer who leaves is not the seeded owner of the donation page, the orphan case does not fire. |
| Relative date resolution | Resolved against the group's timezone from `app_settings`, not UTC. At IST, UTC would shift dates by a day and look like a bug in provenance. |
| Empty brief | Stated plainly — nothing appears to have left with them — rather than three empty sections, which reads as broken. |
| Facts with no asset | Answerable by the Respondent, but they can never produce a risk finding. Expected, not a bug. |
| Credentials pasted into the group | Messages stored verbatim, since provenance depends on them, but credential-shaped strings redacted at render time wherever quoted. |
| Messages from an unknown chat | Ignored. Only the configured chat id is processed. |
| Prompt change invalidating derived data | `prompt_version` in the cache key, plus a reset path that truncates derived tables while keeping `messages` and `curator_cache`. |
| Judges clicking Dismiss | `reset-demo.ts` restores the golden dump. Register actions are permanent by design, so the first curious judge would otherwise flatten the demo for everyone after. |
| Judges resetting the since-you-last-looked diff | `coordinator_state.last_seen_at` advances on view, so record the video before the URL is shared, or the diff is empty when judges arrive. |
| AgentCore cold start | Warm the runtime immediately before recording; the first invocation is the longest pause in the video. |
| An unattended worker crash-loop | Exponential backoff and a cap on consecutive failures. Without it, a worker retrying invocations for days while nobody is watching is the cheapest way to spend real money on this project. |
| Coolify restarting the worker on a failed health check | The check targets an unauthenticated `GET /health`, never the token-protected data API, which would answer 401 and read as unhealthy. A Coolify-driven restart loop bypasses the worker's own backoff entirely, so this is not covered by the row above. |
| Two worker containers running at once | Deploy the VM stack as a Coolify **Compose** resource, which does not roll. Rolling updates on an Application resource overlap old and new containers, and two `getUpdates` consumers on one bot token split the update stream with no visible error. |
| A local worker polling the deployed bot's token | A separate BotFather bot and private group for local development, configured with the same three Telegram settings. Sharing the token breaks both workers at once. |
| A local worker needing to serve the data API to AWS | It cannot. Run the agent locally with `AGENT_TRANSPORT=http` instead of tunnelling; the agent is stateless, so a local run is behaviourally identical. |
| Postgres accidentally published | Coolify has an explicit public-port toggle on database resources, so this is verified from outside the VM rather than assumed from the topology. |
| A Next.js build exhausting VM memory | Coolify builds on the VM, and a production Next.js build peaks far above a running Node process while Postgres is live. Check free memory first; build elsewhere and pull the image if it is tight. |
| A Dockerfile that cannot resolve `packages/core` | Build context is the repository root, not the app directory, because core is a workspace dependency of both apps. |

## Feature coverage

Every functionality in the product document, and the mechanism that implements it. A row with no
mechanism is a gap; there are none.

| F | Mechanism |
| --- | --- |
| F1 | Worker poll loop normalises updates into `messages` |
| F2 | `seed-transcript.ts` writes `messages` with `source = 'seed'`, through the same normaliser, with a fail-closed coverage report over the product document's coverage table |
| F3 | `chat_member` update → `brief` task |
| F4 | Message flags for forwarded and edited; edits re-curate and supersede; withdrawal is a coordinator action, as Telegram reports no deletions |
| F5 | `unprocessed` flag set at intake for non-text media |
| F6 | Deterministic pre-filter in the worker, `prefilter_verdict` + `prefilter_version` |
| F7 | Curator inside the `ingest` graph, structured output permitting multiple records per message |
| F8 | `facts.match_key` for merge, `supersedes_fact_id` for contradiction, `retired` status for negation |
| F9 | `unverified` status, low confidence, excluded from detection SQL |
| F10 | Resolved against `app_settings.timezone` at curation time |
| F11 | Curator noise classification, covered by the golden message set |
| F12 | `person_aliases` plus deterministic matching in the Cartographer, model call only on ambiguity |
| F13 | `holdings` as open and closed rows, never overwritten |
| F14 | `capability_coverage`; no attendance table exists to write to |
| F15 | Five detection queries mapped onto four rendered subtypes |
| F16 | `findings.severity` from the Assessor; `confidence` a separate column |
| F17 | Assessor aggregation and suppression over SQL candidates |
| F18 | Restraint hooked on all three producing tasks — `assess`, `brief`, `respond`; `quiet_decisions` rows; gated per output class |
| F19 | `findings.dedupe_key`, with dismissals recorded against the key |
| F20 | `respond` task, triggered by mention or reply |
| F21 | `questions` rows, targeted by `assets.sensitivity` |
| F22 | `my_chat_member` update, idempotent per chat |
| F23 | `brief` task with three fixed sections, on join and on leave |
| F24 | Copyable text in the UI; direct message attempted only where the user has opened a chat with the bot |
| F25 | `brief_lines` with assignment as a record, no notification sent |
| F26 | Next.js app: Continuity, Who holds what, Briefs |
| F27 | Fact detail panel over any screen, with render-time redaction |
| F28 | `runs` table including the JSONB trace returned by the agent |
| F29 | Passcode exchanged for a signed cookie, no user table |
| F30 | Facts never carry secret values; credential-shaped strings redacted wherever a message is quoted |
| F31 | Deterministic consequence classification from asset kind and sensitivity |
| F32 | Strands interrupt → `questions` + `pending_changes` + snapshot, resumed by the `resume` task |
| F33 | Detection SQL filters to `status = 'active'`, so pending changes cannot appear |
| F34 | Answerer identity checked against `app_settings.coordinator_person_id` before an approval resolves |
| F35 | Bot's own sender id excluded at intake |
| F36 | SQL counts over `questions` — open and rolling-24h — with `queued` status, nullable `asked_at`, and priority derived from `kind` |

## Configuration

All configuration is environment variables. No secrets in the repository.

**worker:** `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `COORDINATOR_TELEGRAM_ID`,
`AGENT_TRANSPORT`, `AGENTCORE_RUNTIME_ARN`, `AGENT_HTTP_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `DATA_API_TOKEN`, `ORG_TIMEZONE`.

`AGENT_TRANSPORT` is `agentcore` or `http`. Under `agentcore` the worker signs with SigV4 against
`AGENTCORE_RUNTIME_ARN`; under `http` it POSTs the identical envelope to `AGENT_HTTP_URL`, and the AWS
variables are unused. This is one interface with two implementations, and it exists for a specific
reason set out in the environments section: without it, nothing in the pipeline can be exercised without
a deploy, and prompt iteration across six agents is where most of the build time goes.

**agent:** `MODEL_BASE_URL`, `MODEL_API_KEY`, `CURATOR_MODEL`, `CARTOGRAPHER_MODEL`,
`ASSESSOR_MODEL`, `RESTRAINT_MODEL`, `BRIEFER_MODEL`, `RESPONDENT_MODEL`, `DATA_API_URL`,
`DATA_API_TOKEN`.

**web:** `DATABASE_URL`, `ADMIN_PASSCODE`, `SESSION_SECRET`.

**Where these values live differs by environment, and the split is a security property rather than an
accident.** Locally they come from a gitignored `.env`. On the VM they are held in Coolify's per-resource
environment configuration, which is what satisfies the product document's requirement that the bot token
sit in a secret store rather than in a file beside the code. The agent's variables are set on the
AgentCore runtime at launch. The consequence is that `MODEL_API_KEY` never touches the VM and
`DATABASE_URL` never touches AWS — neither side holds the other's secrets, and `.env.example` remains the
committed contract listing every name with no value.

Telegram setup is not configuration but it fails like configuration: privacy mode disabled through
BotFather, the bot promoted to group administrator, and `allowed_updates` set explicitly. All three are
covered in the Telegram integration section and belong in the README as prerequisites. **They must be
done once per bot**, which means twice — the demo bot and the local development bot below.

## Deployment

Two independent deploy paths, split on one rule: AWS holds stateless compute and nothing else, Coolify
holds everything stateful. Neither path can break the other, and neither shares a credential with it.

### Services used

**On AWS**

| Service | Role |
| --- | --- |
| Bedrock AgentCore Runtime | Hosts the agent container. The only compute on AWS. |
| ECR | Image registry the runtime pulls from. Cents a month. |
| CodeBuild | Builds the agent image remotely, which is why no local Docker daemon is required. |
| IAM | One user for the worker, scoped to `bedrock-agentcore:InvokeAgentRuntime`, plus an execution role for the runtime itself permitting ECR pull and CloudWatch Logs write. |
| CloudWatch Logs | Agent container logs only. **Not** the trace source — the trace returns in the response payload and is stored in Postgres. |
| S3 | Only if snapshot durability lands on rung two of the ladder. Otherwise unused. |

Deliberately absent: no VPC, no RDS, no load balancer, no Secrets Manager, no Lambda, no Bedrock model
access. Postgres is never reachable from AWS, so there is no network plumbing to build. The IAM user's
keys are the only AWS credential the project holds; the execution role is a setup step, not a secret.

**Outside AWS**

| Component | Role |
| --- | --- |
| The VM, via Coolify | Postgres, worker, web, and the proxy that fronts them |
| Coolify proxy (Traefik) | TLS termination, automatic Let's Encrypt certificates, routing, and the public URL judges open |
| Telegram Bot API | Intake and outbound. Long polling, so the bot needs no inbound port and no webhook registration. |
| Model provider | All six agents, over an OpenAI-compatible base URL, called from inside the AgentCore container |
| BotFather | Bot creation and disabling privacy mode. Manual, and once per bot. |

### agent → AgentCore

Express server implementing the AgentCore `/invocations` contract, containerised, deployed through the
AgentCore CLI so CodeBuild builds remotely and pushes to ECR. Redeploy is one command; the container is
stateless, so redeploying loses nothing and there is nothing to drain or migrate.

### worker, web and Postgres → Coolify

**Deployed as a single Coolify Docker Compose resource, not as separate Application resources.** This is
not a matter of convenience, and it is the most important sentence in this section.

Coolify applies rolling updates to Application resources: the replacement container starts, and the old
one stops once it is considered healthy. Without a health check it rolls blind, but either way there is a
window in which **two worker containers run simultaneously** — and two `getUpdates` consumers on one bot
token split the update stream unpredictably between them. During a deploy the bot would answer some
messages and silently drop others, with nothing in either container's log looking wrong. Coolify does not
apply rolling updates to Compose deployments, so deploying the stack as Compose gives stop-then-start
semantics for free and removes the failure entirely.

If web and worker are ever split into separate Application resources for independent deploys, **the worker
specifically must have rolling updates disabled.** That constraint is invisible in the code and someone
will otherwise remove it as dead configuration.

Three further consequences of Coolify owning the VM:

**Builds happen on the VM, not remotely.** Coolify builds images locally. A Next.js production build is
memory-hungry in a way a running Node process is not, and on a small VM it can exhaust RAM while Postgres
is live. Check actual available memory before relying on it; if it is tight, build the web image elsewhere
and have Coolify pull it rather than build it.

**Each Dockerfile takes the repository root as its build context**, not its own app directory, because
`packages/core` is a workspace dependency of both apps. This is the standard pnpm-monorepo-in-Docker trap
and it fails on the first build otherwise.

**Postgres is never published to a host port.** Coolify exposes an explicit public-port toggle for
database resources, so this is now something to verify actively rather than a structural guarantee. It is
reachable over the Docker network by the worker and web, and by `docker exec` for `pg_dump`, and by
nothing else.

**Migrations** run from `packages/core` via Drizzle on worker start.

### Environments

Two, and deliberately not three. A staging environment for a build with one human user costs setup time
and a third bot and buys nothing that the transport switch does not already provide.

| | local | demo (deployed) |
| --- | --- | --- |
| Postgres | Docker Compose on the dev machine | Coolify on the VM, unpublished port |
| worker, web | Run on the host against local Postgres | Coolify Compose resource |
| agent | The same Express app, run locally, `AGENT_TRANSPORT=http` | AgentCore Runtime, `AGENT_TRANSPORT=agentcore` |
| Telegram | A second bot, in a private test group | The demo bot, in the rescue group |
| Model provider | The same provider and real keys | The same provider and real keys |
| AWS | None, except when running G3, G4 and G5 | AgentCore, ECR, CodeBuild, IAM |
| Data | The two-month slice | Full six months, restored from the golden dump |

Three things force this shape, and each of them is a silent failure if ignored:

**A bot token supports exactly one `getUpdates` consumer.** A local worker polling the same token as the
deployed one splits the update stream, and both appear broken. Local development therefore requires its
own BotFather bot and its own private group — free, and five minutes — configured with the same three
settings as the real one. Skip the settings and the development environment silently has no membership
events, which makes the brief flow the one behaviour that cannot be tested.

**A local worker cannot serve `DATA_API_URL` to a deployed AgentCore container.** The agent calls back to
the worker for evidence lookups, and from AWS a development machine is unreachable. Tunnelling works and
pointing the local agent at the deployed data API works, but running the agent container locally is
cleaner than both: it is stateless and speaks plain Express, so a local run is behaviourally identical.

**Hence `AGENT_TRANSPORT`.** Without it there is no way to exercise the pipeline without a deploy. It also
gives back the only thing a staging environment would have offered — pointing the local worker at the
*deployed* runtime, which is `AGENT_TRANSPORT=agentcore` with the production ARN, and is how G4 and the
deploy path are verified without a full VM round trip.

**Data moves one direction only:** `pg_dump` from the deployed golden database down to local. Never
upward. That dump is what `reset-demo.ts` restores after a judge clicks Dismiss, so overwriting it from a
development machine destroys the demo's reset point.

### First-time setup order

The dependencies here are real, and two of them are not obvious:

1. BotFather: create both bots, privacy mode off on each.
2. Coolify: point DNS at the VM, create the resource, set its domain. **TLS must be issued before the
   agent is deployed**, because `DATA_API_URL` is set on the runtime at launch and has to resolve to a
   real HTTPS endpoint.
3. Compose up: Postgres, worker, web. Migrations run on worker start.
4. `agentcore launch`, with `DATA_API_URL` pointing at the live data API route.
5. Set `AGENT_TRANSPORT=agentcore` and `AGENTCORE_RUNTIME_ARN` on the worker, restart — this is G4.
6. Bot into the group, promoted to administrator, and confirm a `chat_member` event arrives — this is G6.
7. Seed, backfill, then `pg_dump` the golden database.

Note that G3 and G4 are deployment gates sitting in Phase 0. Deployment happens on day one, before
feature work — not at the end.

### Redeploying a change to `packages/core`

The Zod envelope is the contract between a worker on the VM and an agent on AWS, and the two deploy
independently. A shape change therefore opens a window where one validates against the other's old
schema. Deploy the agent first, then the worker, and accept a few seconds of failed invocations: the
worker has exponential backoff and the outbound queue retains its work. Versioning the envelope is not
worth it at this size, but the window is real rather than theoretical and is better known in advance.

## Smoke tests, before building anything real

In this order. Each one, failing, invalidates work that follows it.

1. **Strands TS with the OpenAI-compatible provider pointed at the model's base URL** — one agent,
   one call, locally. Nothing else matters if this fails.
2. **Structured output through that provider** — one Zod schema, ten runs on a messy sample message,
   count the conformance failures. This calibrates how defensive the retry logic must be.
3. **The same agent deployed to AgentCore, reaching the model from inside the container** — confirms
   egress and the deploy path together.
4. **A round trip from the VM** — worker invokes the deployed runtime over SigV4 and gets a result.
5. **An interrupt surviving a snapshot** — raise one, serialise, restore in a fresh invocation, resume.
   This is the riskiest mechanism in the design and determines which rung of the fallback ladder the
   approval gate lands on.

Also measure Curator latency on the first call. If the model does extended reasoning, per-call latency
may make the live path feel sluggish on camera, which argues for smaller batches or a non-reasoning
setting.

## Testing strategy

The pipeline is non-deterministic, so tests target the deterministic seams and use fixtures for the
rest.

- **Pre-filter** — table-driven unit tests over a labelled message corpus, scored on recall. Recall is
  the metric that matters; precision only costs money.
- **Schema conformance** — every Zod schema exercised against recorded model responses, including
  malformed ones, to prove the retry path works.
- **Detection SQL** — the five candidate queries tested against fixture data with known answers, plus a
  case asserting that `unverified` and `pending_approval` rows never appear. These are the correctness
  backbone and they are fully deterministic.
- **Fact matching** — restatement bumps `last_confirmed_at` without creating a row; contradiction
  creates one and links it. This is where a near-duplicate register comes from, so it is tested directly.
- **Dedupe and dismissal** — assert that two consecutive sweeps produce one finding, and that a
  dismissed finding never returns.
- **Ordering and supersession** — apply a contradiction forwards and backwards, assert the same final
  state given `sent_at` ordering.
- **Approval round trip** — an integration test with a stubbed agent: interrupt, snapshot, restore,
  resume, apply. Including the rejected path and an answer from a non-coordinator.
- **Ask budget** — a third simultaneous ask queues rather than sending; a fourth ask in twenty-four hours
  queues; an approval raised while the budget is full of verifications is asked before them; a queued ask
  is neither dropped nor duplicated. All four are deterministic SQL assertions.
- **Restraint scope** — assert the hook is registered on `assess`, `brief` and `respond`, and that a
  withheld brief line and a withheld answer each write a `quiet_decisions` row. This is the test that
  stops the veto silently narrowing to findings during a refactor.
- **Seed coverage** — the generator's report over its own output: every coverage row matched or explicitly
  asserted by plan, and a deliberately mutilated plan exits non-zero.
- **Redaction** — the credential helper over labelled secrets, provider key shapes, JWTs, connection
  strings and card numbers, **plus negative cases**: the emergency number, Indian mobile numbers, rupee
  amounts and ISO dates must survive unchanged. Over-redaction is the worse failure here, because a
  redacted emergency number is silent and permanent on every surface that quotes it.
- **Structural privacy guarantees** — Drizzle table introspection asserting no attendance table and no
  scoring column, with a case that proves the detection logic itself works.
- **Worker HTTP surface** — `/health` reachable with no token and reporting 503 when the database is
  unreachable; every `/data/*` route rejecting an absent and a wrong token, and admitting a correct one.
  This is what keeps a Coolify health check off the authenticated path.
- **Transport configuration** — each `AGENT_TRANSPORT` requiring only its own variables, an unknown
  transport rejected rather than defaulted, and the timezone defaulting to IST rather than UTC.
- **Agent behaviour** — a small golden set of messages with expected classifications, run manually
  rather than in CI, since the assertions are judgments and would be flaky.

## Cost

This system is built for a hackathon and will never carry a real organisation, so the cost question is
narrow: roughly forty hours of active development, then four weeks sitting deployed for judges. Those two
phases behave completely differently and are estimated separately. VM cost is excluded.

### Token volumes

| Agent | Volume driver | Tokens across the build |
| --- | --- | --- |
| Curator | ~900 candidates per backfill, batches of 10 → ~90 calls, across ~15 uncached backfills | ~2.5M |
| Restraint | Per new or re-severitied finding per sweep, plus every brief line and every answer | ~1.5M |
| Assessor | Once per changed sweep, ~200 runs | ~1M |
| Respondent | ~200 questions in development and rehearsal | ~0.7M |
| Briefer | ~100 briefs | ~0.4M |
| Cartographer | Model only on ambiguity, ~5% of extracted facts | ~0.25M |

About **6.5M tokens**, roughly 65% input and 35% output, with Curator and Restraint together making up
about two thirds. At cheap-tier rates that is a few dollars; at three times those rates it is still low
double digits. Halving the transcript took roughly 2.5M tokens off the Curator, and adding Restraint to
the brief and answer paths put about 0.3M back — a good trade, since the tokens removed were repetitive
classification and the ones added gate the only text a judge reads aloud.

Two things move this more than the published rate does. **Provider prompt caching**, if available, applies
to the Curator's constant system prompt and schema — around 1M tokens that could bill at a fraction.
And **how often the Curator cache is invalidated**: each meaningful prompt revision costs a fresh
0.15M-token backfill, so fifteen revisions is the estimate above and forty would roughly triple that
component.

### AgentCore

At 1 vCPU and 2 GB, the published rates work out to roughly **$0.11 per billed hour**. A few thousand
short invocations across the build is on the order of nine hours of compute — **under a dollar** — or
$3–5 if the runtime is kept warm through development sessions.

Confirm whether billing follows session lifetime rather than request processing, and terminate sessions
explicitly when a task returns. This is the one place in the project where a genuinely unpleasant surprise
is possible: under session-lifetime billing, a single session left open for four weeks is about 720 hours,
or roughly $79 for nothing.

### The idle month

A deployed runtime with no traffic bills nothing — AgentCore charges for invocations, not for existing.
Judges opening the live URL cost nothing at all, since the UI reads Postgres and never reaches a model.
ECR image storage is a few cents a month and CloudWatch stays inside the free tier.

Three things must hold for that to remain true, and all three are design decisions rather than vigilance:
the sweep short-circuits in SQL before any invocation, Restraint is gated on changed findings, and the
worker backs off rather than crash-looping. With those in place, four idle weeks cost approximately
nothing.

### Total

**Roughly $5–12 for the month, most likely around $7**, dominated by uncached backfill re-runs rather
than by AWS. The hackathon's AWS credits cover the AgentCore and ECR side entirely, so the only real
out-of-pocket spend is the model provider bill.

Two habits keep it there: develop against the two-month transcript slice and run the full six months only
for the final demo pass, and `pg_dump` a golden database as soon as one backfill produces good output —
every piece of UI, sweep and rehearsal work after that point costs nothing.

## Sequencing constraints

Not a schedule — the implementation plan owns that. These are the technical orderings that cannot be
rearranged:

- The five smoke tests precede all feature work.
- `packages/core` schemas precede all three apps, since they are the shared contract.
- The Curator cache precedes backfill tuning, or iteration becomes slow and expensive.
- Seed transcript generation precedes any judgment about extraction quality, because there is nothing
  to extract from until it exists.
- The seed plan fixture precedes rendered prose, and a passing coverage report precedes any conclusion
  drawn from a backfill. A prompt tuned against a transcript with unknown coverage is tuned against
  nothing.
- Telegram admin rights and `allowed_updates` must be verified against a real group before the brief
  flow is built, since a silent membership-event failure is indistinguishable from a code bug.
- Detection SQL precedes the Assessor, which consumes its output.
- A golden database dump precedes UI work, so the UI is built against fixed data at zero model cost.
- Seed-to-real-account binding precedes any demo rehearsal.
- Deployment precedes the video, and warming precedes recording.
- Coolify's TLS certificate must be issued before `agentcore launch`, because `DATA_API_URL` is set on
  the runtime at launch and must resolve to a real HTTPS endpoint.
- The second BotFather bot precedes any local development against the pipeline, since sharing the demo
  bot's token breaks both workers at once.
- `AGENT_TRANSPORT` exists before the worker's orchestration module is written, not after. Retrofitting a
  transport seam into a module built around a SigV4 client is more work than designing for two.

## Open items

- Which rung of the snapshot-durability ladder the approval gate lands on. Resolved by smoke test 5.
- Whether the Strands TS OpenAI-compatible provider accepts a custom base URL. Resolved by smoke
  test 1; if not, LiteLLM behind a proxy is the fallback.
- Whether provider prompt caching is available for the constant Curator system prompt and schema.
