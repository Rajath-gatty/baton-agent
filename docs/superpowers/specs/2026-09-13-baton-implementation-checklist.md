# Baton — Implementation Checklist

**Date:** 2026-09-13
**Status:** Tracking document
**Derived from:** `2026-09-12-baton-technical-design.md` and `2026-09-12-baton-design.md`
**Purpose:** One place to see what is built and what is not. Every item is phrased so that its state is
observable — you can look at the code, the database, or a screen and say done or not done. Items that
cannot be checked that way have been rewritten until they can be.

Feature references in brackets, `[F7]`, point back to the functionality table in the design document, so
nothing in that table can be quietly lost.

**Legend:** `[ ]` pending · `[x]` done · `[~]` partial, note what remains · `[-]` cut, record why

**Marking discipline.** An item is `[x]` only when it has been observed working — a command that passed,
a test that runs, a screen that rendered. "The code exists" is `[~]`, not `[x]`. Where an item is proved
by an automated check rather than by inspection, the item says so, because an inspection result decays the
moment someone edits the file and a test does not.

**Status — 2026-09-13.** 157 done · 6 partial · 167 pending, of 330.

`packages/core`, the database schema, seed data generation, the agent container with all six agents, and
**intake — the normaliser, the pre-filter and the backfill's first stage** are complete. `pnpm typecheck`
passes on all five workspaces, `pnpm lint` is clean, `pnpm format` conforms, and 237 tests pass (106 in
core, 75 in scripts, 45 in the agent, 11 in worker).

**Seeded messages are now in Postgres.** `pnpm backfill -- --chat-id 0` loads the roster into `people` and
`person_aliases`, then 1,753 messages of the two-month slice through the same normaliser and pre-filter
that live traffic will use — 717 candidates, 1,036 discarded, every row carrying a verdict and a version.
It holds the pipeline advisory lock throughout and is idempotent. The transcript is no longer an artifact
on disk only.

The agent container dispatches all five tasks against real agents. `ingest` and `assess` are SDK
`Graph`s; `brief` and `respond` are single agents; all three producing tasks run their output through the
Restraint gate, and `ingest` cannot, because the type does not admit it. Every model response is
validated against its Zod schema with the validation error fed back on retry, and the trace — nodes,
model, tokens, tool calls, reasoning — is assembled and returned in the response payload.

Four guarantees in this layer are automated rather than inspected. Restraint's scope is asserted against
the wiring set, so it cannot silently narrow to findings; a withholding is asserted to produce a quiet
decision from each of the three scopes; the observation constraint is asserted present in all six
prompts, so a seventh cannot omit it; and the no-database-client rule was re-verified by probe after the
Strands SDK was added, since a new dependency is exactly when that rule would break unnoticed.

Two design deviations are recorded in the Agents section below, both forced by the SDK rather than
chosen: Restraint is a produce-path gate rather than an `addHook`, and `Graph` uses a custom `Node`
subclass rather than `AgentNode`.

The schema is 20 tables with the first migration generated at
`packages/core/drizzle/0000_tranquil_wolfpack.sql`, and three guarantees the checklist previously left to
inspection are now automated: the no-database-client rule in `apps/agent` by ESLint, the
no-attendance-table / no-scoring-column rule by Drizzle introspection over all 20 tables, and the
weight-bearing columns and indexes by `packages/core/test/schema-invariants.test.ts` — which asserts that
`questions.asked_at` is nullable **with no default**, that `holdings.holder_person_id` and
`commitments.owner_person_id` stay nullable, that `facts.match_key` and `findings.dedupe_key` exist, and
that all five named indexes appear in the generated SQL.

Seed generation runs in the two phases the design requires. `pnpm seed:plan` writes a committed fixture —
20 people, 12 assets across all six kinds, 6 capabilities, 61 events, 43 authored placements covering all
26 coverage rows and all 5 planted cases — and refuses to write an invalid plan. `pnpm seed:transcript`
renders 4,421 messages across six months and its coverage report exits non-zero on any unmatched row; the
two-month development slice keeps every row while compressing rather than dropping.

Four things are explicitly **not** done and should not be inferred from the above. Every Phase 0 gate is
unproven, which is the next work — and **no model call has been made**, so the six agents are wired,
typechecked and unit-tested but have never seen a model. **Nothing has been curated**: intake is stage one
of backfill, and stage two — candidates to `ingest` in batches of ten, then one `assess` pass — needs a
working model call, so `facts`, `holdings`, `findings` and every derived table are still empty. **No
container image has been built**, so the three Dockerfiles are unproven; on Windows the web build also
fails creating symlinks for Next's standalone output, which is an OS permission limitation rather than a
code defect, and Coolify builds that image on Linux. And the worker's four `/data/*` routes are still 501
stubs, so the agent's tool pull-path is wired and typed but not yet answerable.

**Resolved since the last revision.** Hardware virtualization was disabled on the development machine,
which blocked Docker entirely. It now runs: `pnpm pg:up` brings up Postgres 17 on `127.0.0.1:5432` and
`pnpm db:migrate` has applied the first migration, creating all 20 tables. The schema is therefore no
longer proved only by generated SQL — Postgres has accepted it, and the five weight-bearing column
invariants were re-checked against `information_schema` on the live database.

---

## Phase 0 — Gates

Nothing below this section is worth starting until these pass. Each one, failing, invalidates work
that follows it.

- [ ] **G1.** Strands TS agent with the OpenAI-compatible provider pointed at the model's base URL —
      one agent, one call, locally. Records whether a custom base URL is accepted at all.
- [ ] **G2.** Structured output through that provider — one Zod schema, ten runs on a messy sample
      message. Record the conformance failure count; it sets how defensive the retry logic must be.
- [ ] **G3.** Same agent deployed to AgentCore, reaching the model from inside the container. Confirms
      egress and the deploy path together.
- [ ] **G4.** Worker on the VM invokes the deployed runtime over SigV4 and gets a result back.
- [ ] **G5.** An interrupt survives a snapshot — raise, serialise, restore in a fresh invocation,
      resume. Determines which rung of the approval-gate fallback ladder the build lands on.
- [ ] **G6.** Telegram: bot in a real group, promoted to administrator, privacy mode off,
      `allowed_updates` set — confirm a `chat_member` event actually arrives. Silent failure here is
      indistinguishable from a code bug later. Do this for **both** bots, demo and local.
- [ ] **G7.** Record Curator latency on a batch of ten. If the model does extended reasoning, decide
      now whether to shrink batches or disable reasoning mode.
- [ ] **G8.** Confirm AgentCore billing boundary — session lifetime or request processing — and
      implement explicit session termination either way.
- [ ] **G9.** Coolify: a trivial Compose resource deploys, gets a TLS certificate on the public
      hostname, and passes an unauthenticated `/health` check. Then redeploy it and **confirm the old
      container stops before the new one starts** — if containers overlap, the worker cannot be deployed
      this way and the rolling setting must be found and disabled before any Telegram work begins.

---

## Repository and tooling

- [x] pnpm workspace root with `apps/*` and `packages/*`
- [x] `apps/agent`, `apps/worker`, `apps/web`, `packages/core` created
- [x] `scripts/seed-plan.ts`, `scripts/seed-transcript.ts`, `scripts/backfill.ts`,
      `scripts/reset-demo.ts` stubs in place
- [x] TypeScript strict mode across all workspaces — `tsconfig.base.json`, also
      `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; `pnpm typecheck` passes on all five
- [x] Single lint and format config at the root — `eslint.config.mjs` + `.prettierrc.json`
- [x] `.env.example` listing every variable from the config section, no real values
- [x] `.gitignore` covering `.env`, build output, and any database dump — and scoped so it does not
      swallow `docs/`, since the architecture diagram must be committed. Drizzle migrations deliberately
      not ignored.
- [x] `.gitattributes` normalising to LF, so `pnpm format` does not fail on a fresh Windows clone
- [x] MIT `LICENSE` file at the root, with a matching license field
- [x] Docker Compose for Postgres locally — `docker-compose.dev.yml`, bound to `127.0.0.1`
- [x] Deployment Compose for Coolify — `docker-compose.yml`, Postgres with no `ports:` key
- [x] Dockerfiles for agent, worker and web, all taking the **repository root** as build context
- [x] ESLint guard proving the agent workspace cannot import a database client — verified by probe,
      fires on both `drizzle-orm` and `@baton/core/db`

## packages/core

Built before the three apps, because it is the contract between them.

- [x] Drizzle schema for every table (see next section) — 20 tables, verified by test:
      `packages/core/test/schema-invariants.test.ts` asserts the table set, the columns that must stay
      nullable, and the constraints as generated
- [x] Zod schema: Curator output — five-way classification plus extracted records, **flat**
- [x] Zod schema: Cartographer output — attributions, resolved identity, `cannot_determine` branch
- [x] Zod schema: Assessor output — subtype, severity, confidence, reasoning, suppression flag
- [x] Zod schema: Restraint output — surface or withhold, with reason
- [x] Zod schema: Briefer output — three sections as line-level records, each with evidence refs
- [x] Zod schema: Respondent output — separate branches for answer, stale answer, ambiguous, unknown
- [x] Zod schema: agent request envelope (`task`, payload, hydrated context)
- [x] Zod schema: agent response envelope including the `trace` array
- [x] Prompt files, each carrying a `prompt_version` constant — versions, the observation constraint,
      the shared JSON output contract, and all six prompt bodies. `OBSERVATION_CONSTRAINT` lives in
      `prompts/constraints.ts` rather than the barrel, because the six bodies import it and the barrel
      re-exports them, which in the barrel would be a cycle
- [x] Shared types exported for the web app to consume — verified by probe: `apps/web` resolves core's
      types across the `Bundler`/`NodeNext` resolution boundary
- [x] `@baton/core` exports resolve to `dist`, not `src`, so the production containers can load them —
      which imposes a build order, core before either app, handled by project references and each
      Dockerfile
- [x] Core barrel does not re-export `./db`, so the agent cannot acquire a database client transitively
- [x] Credential-redaction helper, used by every surface that quotes a message `[F30]` — 20 tests,
      including negative cases proving Indian mobile numbers and the emergency number survive

## Database schema

Each table is one item; the columns that carry design weight are called out separately because omitting
them causes specific, known failures.

- [x] `people` — telegram user id **nullable**, display name, status, joined/left timestamps
- [x] `person_aliases` — alias, kind; alias **not unique** (ambiguity must be representable) `[F12]`
- [x] `messages` — source, sender, sent-at, text, reply-to, flags, `content_hash`
- [x] `messages` unique constraint on `(chat_id, telegram_message_id)`
- [x] `messages.prefilter_verdict` **and** `prefilter_version` `[F6]`
- [x] `messages.curated_at`
- [x] `messages` flags: forwarded, edited, withdrawn, unprocessed `[F4]` `[F5]`
- [x] `curator_cache` keyed on `content_hash` + `prompt_version` — the composite primary key *is* that
      index, so a second one would be dead weight
- [x] `assets` — six kinds, name, normalised key, `sensitivity`
- [x] `facts` — claim, confidence, source message, stated-by/at, `last_confirmed_at`, status, sensitivity
- [x] `facts.supersedes_fact_id` `[F8]`
- [x] `facts.match_key` — **without this the register fills with active near-duplicates** `[F8]`
- [x] `facts.curator_reasoning` — shown in the fact detail panel `[F27]`
- [x] `holdings` — asset, holder **nullable**, `holder_external`, `is_personal_resource`
- [x] `holdings.acquired_at` / `released_at`, append-only, never overwritten `[F13]`
- [x] `commitments` — substance, owner **nullable**, promised-at, deadline **nullable**, evidence, status
- [x] `commitments.asked_once_at` — ask-once-then-stop enforced in data, not in prompt
- [x] `capabilities`
- [x] `capability_coverage` `[F14]`
- [x] `findings` — type, subtype, title, why-it-matters, severity, confidence, evidence, status
- [x] `findings.dedupe_key` — **without this every sweep duplicates or resurrects** `[F19]`
- [x] `findings` first-seen / last-seen, dismissal reason, `assessor_reasoning`
- [x] `quiet_decisions` — what, why, which run `[F18]` — plus `scope`, so a test can prove the veto has
      not narrowed to findings
- [x] `questions` — kind, target, asked text, bot's telegram message id, answer, resolution
- [x] `questions.status` includes a `queued` state, and `asked_at` is **nullable** — a default of
      insertion time makes the rolling window count questions never sent `[F36]`. Asserted by test,
      including the absence of a default
- [x] `questions.interrupt_id` and `interrupt_name` `[F32]`
- [x] `pending_changes` — proposed write, consequence, status `[F31]` `[F33]`
- [x] `agent_sessions` — task, Strands session id, serialised snapshot
- [x] `runs` — messages read, candidates, extracted, **skipped**, findings, JSONB `trace` `[F28]`
- [x] `briefs` and `brief_lines` — lines as rows, assignable, each with evidence refs `[F25]`
- [x] `coordinator_state` — single row, `last_seen_at` — single row enforced by a check constraint
- [x] `app_settings` — chat id, org name, timezone, `coordinator_person_id` — same check constraint
- [x] Indexes: `messages(prefilter_verdict, curated_at)`, `facts(asset_id, status)`,
      `holdings(asset_id, status)`, `findings(status, severity desc)`,
      `curator_cache(content_hash, prompt_version)` — all five asserted against the generated SQL
- [~] Migrations run from `packages/core` on worker start — `runMigrations` is called first in
      `apps/worker/src/main.ts` and `drizzle/0000_tranquil_wolfpack.sql` **has now been applied to a live
      database**: `pnpm pg:up` brings up Postgres 17 and `pnpm db:migrate` created all 20 tables. Re-running
      it is a no-op, as the worker's start path requires. Also confirmed against live Postgres rather than
      generated SQL: `questions.asked_at` is nullable **with no default**, `holdings.holder_person_id` and
      `commitments.owner_person_id` are nullable, and `facts.match_key` and `findings.dedupe_key` are NOT
      NULL. What remains is only that the **worker** has never been the thing that ran it on start

**Structural guarantees — verify by inspection, not by intent:**

- [x] No attendance table exists anywhere — enforced by test, not inspection: Drizzle table
      introspection in `packages/core/test/privacy-guarantees.test.ts`. **No longer vacuous** — it now
      introspects 20 real tables
- [x] No per-person score column exists anywhere — no completion rate, no reliability figure, no activity
      metric. Same test, over every column of all 20 tables. `capability_coverage` records that someone
      was seen doing something and deliberately does not record how often or how well

## Worker — Telegram

- [ ] Long-poll loop against `getUpdates` with committed offset
- [ ] `allowed_updates` set to `["message", "edited_message", "chat_member", "my_chat_member"]`
- [x] Normaliser producing one internal message shape `[F1]` — `@baton/core/intake`, not the worker,
      because `scripts/backfill.ts` and the poll loop are different processes and the only way to
      guarantee they share it is for there to be one copy neither owns. Seeded and Telegram inputs
      converge on `NormalisedMessage`, whose field names mirror `messages` columns so there is no
      second mapping step to drift
- [x] Messages from an unrecognised chat id ignored — `normaliseTelegramMessage` returns null
- [x] **Bot's own messages dropped at intake** `[F35]` — by sender id, in the same function
- [x] Forwarded messages attributed to the forwarder and flagged `[F4]` — the forwarder put it in
      front of the group, so the message is theirs; `forwarded_from` records where it came from
- [ ] `edited_message` resets `curated_at` and `prefilter_verdict`, triggers re-curation `[F4]`
- [ ] Re-curation after an edit supersedes prior facts rather than mutating them `[F4]`
- [x] Non-text media logged with `unprocessed` `[F5]` — and kept as a *candidate*, so a voice note
      that carried a fact is visible as a gap rather than silently absent
- [ ] `chat_member` join/leave → lifecycle event recorded `[F3]`
- [ ] `my_chat_member` → one-time introduction message, idempotent per chat `[F22]`
- [ ] Question detection: mention of the bot, or reply to it — nothing else `[F20]`
- [ ] Reply matching: `reply_to` first, then most recent open question from that sender in a window,
      then ambiguous
- [ ] Outbound queue with a rate limit, used by **every** outbound path
- [ ] Ask budget enforced in SQL: at most two open questions, three new per rolling 24 hours `[F36]`
- [ ] Ask priority derived from `kind` — approval, then clarification, then verification `[F36]`
- [ ] A blocked ask is inserted `queued`, never dropped and never asked twice `[F36]`
- [ ] A queued ask's claim stays excluded from findings and briefs while it waits `[F36]`
- [ ] Private-message path to the coordinator, with graceful fallback when no private chat exists

## Worker — pre-filter

- [x] Deterministic heuristics, recall-biased `[F6]` — `@baton/core/intake`. **Triggering** signals keep
      a message on their own (asset nouns, holding, commitment, reported speech, termination, figures,
      money, participation, lifecycle, contact details, forwards, credentials); **supporting** signals
      (temporal reference, substantial length) only count alongside a trigger. Promoting those two to
      triggers put the keep rate at 81% against a design target of roughly one in five, by keeping
      stories about adopted dogs
- [x] Verdict and `prefilter_version` written for every message, kept and discarded alike — verified in
      Postgres: 717 candidate + 1,036 discarded, all at version 1, none null
- [x] **Recall proved against the planted corpus, not asserted** — `scripts/test/prefilter-recall.test.ts`
      runs every authored placement through the filter and fails if any placement carrying a non-noise
      coverage row is discarded, or if any of the five planted cases loses every carrier. It runs on the
      committed plan fixture rather than the derived transcript, so it works on a fresh clone. This is
      the test that stops a token-saving tweak silently eating the stale-figure case that opens the video
- [~] Re-evaluation path for previously discarded messages when the version changes — the backfill upsert
      adopts `excluded.prefilter_verdict`, so bumping the version and re-running re-examines every stored
      message. There is no automatic re-scan in the worker yet
- [ ] Skipped count exposed to `runs` `[F28]` — counted and printed by the backfill, but no `runs` row is
      written yet

**Measured on the two-month slice.** 1,753 messages → 717 candidates (41%), against a design target
nearer 20%. Two things bound the cost of that gap and both were measured rather than assumed: the
candidates contain only **101 distinct `content_hash` values**, so the curator cache collapses 717
messages into 101 model calls, and the keep rate was reduced from 81% before any planted material was
lost. Tightening further is a precision exercise with a working harness in place; each attempt must keep
the recall test green, and the one attempt that pruned generic asset nouns cost a planted durable fact
for three points of keep rate, which is the wrong trade.

## Worker — persistence and derivation

- [ ] Intake loop and processing loop are **separate** — curation never blocks polling
- [~] Strict `sent_at` ordering through the processing loop — the backfill sorts strictly, breaking ties
      on message id so the order is total and a re-run replays it identically. The live processing loop
      does not exist yet
- [x] Postgres advisory lock so only one pipeline task runs at a time — the backfill takes
      `PIPELINE_LOCK_KEY` with `pg_try_advisory_lock`, not the blocking form: a backfill silently queued
      behind a running worker is indistinguishable from one that has hung
- [ ] Curator cache lookup happens **before** batches are formed; batches contain misses only
- [ ] Fact merge on restatement via `match_key` — bumps `last_confirmed_at`, appends evidence `[F8]`
- [ ] Fact supersession on contradiction — new row, `supersedes_fact_id` set `[F8]`
- [ ] Fact retirement on negation `[F8]`
- [ ] Hearsay written at low confidence with `unverified` status `[F9]`
- [ ] Relative dates resolved against `app_settings.timezone`, not UTC `[F10]`
- [ ] Holdings written as history; transfer closes one row and opens another `[F13]`
- [ ] Commitment closure detected from later messages
- [ ] Coverage sets updated from participation evidence `[F14]`
- [ ] Deterministic consequence classification from asset kind and sensitivity `[F31]`
- [ ] Detection SQL: `sole_holder` (asset)
- [ ] Detection SQL: `sole_holder` (capability variant)
- [ ] Detection SQL: `no_owner`
- [ ] Detection SQL: `not_ours`
- [ ] Detection SQL: `loose_end`
- [ ] Five queries render as exactly four UI subtypes, matching the design document `[F15]`
- [ ] **Every detection query filters `status = 'active'`** — this is what keeps pending changes out of
      findings `[F33]`
- [ ] Findings upsert on `dedupe_key`; dismissed keys skipped `[F19]`
- [ ] Sweep short-circuits in SQL when the candidate set is unchanged — no invocation at all
- [ ] Restraint invoked only for new or re-severitied findings
- [ ] `runs` row written for every pipeline execution, including the trace returned by the agent `[F28]`

## Worker — orchestration and API

- [x] Agent invocation client behind one interface with two transports — `AGENT_TRANSPORT=agentcore`
      (SigV4) and `http` (local agent). Built before the orchestration module, not retrofitted
- [ ] SigV4-signed AgentCore invocation client — interface in place, implementation lands with G4
- [ ] Explicit session termination when a task returns — `transport.close()` seam exists
- [ ] Exponential backoff and a cap on consecutive failures
- [ ] Context hydration per task, per the hydration table — Curator does **not** receive the fact index
- [ ] Scheduler for the periodic sweep
- [ ] Data API: `searchFacts`, `getEvidence`, `getHoldings`, `getPerson` — read-only
- [x] Data API bearer-token auth — verified by test: absent and wrong tokens rejected on every route,
      the correct token admitted
- [ ] Data API exposed through the Coolify proxy on a dedicated route
- [x] Unauthenticated `GET /health`, separate from the data API route and not published publicly —
      verified by test, including the 503 path when the database is unreachable

## Agent — container

- [x] Express server implementing the AgentCore `/invocations` contract — plus `/ping`
- [x] Dispatch on `task`: `ingest`, `assess`, `brief`, `respond`, `resume` — five branches wired, all
      five now backed by real agents
- [x] Per-agent model configuration from environment variables
- [x] Zod validation of every model response, with retry feeding the validation error back —
      `model/structured.ts`, three attempts, the validation error and the rejected output both fed
      back on the same agent so conversation history carries. **Not** the SDK's
      `structuredOutputSchema`, which throws `StructuredOutputError` without feeding the error back
- [x] Trace assembled and returned in the response payload — nodes, model, tokens, tool calls,
      reasoning. Model id comes from configuration, because the SDK exposes it on neither the result
      nor the metrics. The partial trace is returned on failure too, or a failed run is undiagnosable
- [x] Strands tools wired to the worker's data API — `searchFacts`, `getEvidence`, `getHoldings`,
      `getPerson`, declared with plain JSON Schema rather than Zod so no Zod schema crosses the SDK
      boundary. **The four `/data/*` routes are still 501 stubs**, so the pull path is wired and
      typed but not yet answerable
- [x] Dockerfile, Node 22+
- [x] No database client anywhere in this workspace — verify by dependency inspection. Declared deps
      are `@baton/core`, `express`, `zod`, `@strands-agents/sdk` and `openai` (the last two are the
      agent framework and its OpenAI-compatible provider), and ESLint fails on any DB import
      (re-verified by probe after the SDK was added)
- [x] **Zod 4 in `apps/agent`, Zod 3 in `packages/core`.** The SDK peer-depends on `zod@^4.1.12` and
      calls `z.toJSONSchema` while its barrel initialises, so importing it at all requires v4 — a
      runtime failure, not a typing one. Core keeps v3, shared with Drizzle and the web app. The two
      never meet: this workspace imports no Zod (see `SchemaValidator` in `model/structured.ts`) and
      only ever calls `safeParse` on core's schema objects, which is instance-local

## Agent — the six agents

- [x] **Curator** — five-way classification, multiple records per message, noise as a first-class
      outcome `[F7]`
- [x] Curator rejects conditionals, hypotheticals and jokes `[F11]`
- [x] Curator prompt forbids cross-message inference, so per-message caching stays sound — asserted by
      test, along with the Curator having **no tools**, which is the other half of the same guarantee
- [x] **Cartographer** — deterministic alias matching first `[F12]`. Exact, then single-character typo,
      then bare-first-name, tried in order and never blended. Combining marks are preserved, or
      Devanagari names normalise to a different string and match nothing
- [x] Cartographer model call only on ambiguity, with `cannot_determine` permitted. A mention matching
      one person resolves in code; several or none escalate, and the resolver never breaks a tie
- [x] **Assessor** — severity over consequence, reversibility, urgency; confidence separate `[F16]`
- [x] Assessor aggregates by capability area `[F17]`
- [x] Assessor suppresses below an evidence threshold `[F17]` — with a reason, enforced by the schema,
      and a suppressed candidate becomes a quiet decision without being sent to Restraint
- [x] Assessor phrases every finding about a capability, never a person — checked in code against the
      holder names the worker supplied, word-boundary matched, and recorded in the trace rather than
      silently rewritten
- [x] Assessor may not invent a `dedupe_key` — an unknown key is dropped, since the key is the upsert
      target and dismissals are recorded against it
- [x] **Restraint** attached on the produce path, not as a graph node `[F18]` — see the deviation note
      below
- [x] Restraint hook registered on **all three producing tasks** — `assess`, `brief` and `respond`
      `[F18]`. Asserted by test against `RESTRAINT_ATTACHED_TASKS`, and `ingest` cannot be registered
      as producing because the type does not admit it
- [x] Gating per output class: findings only when `dedupe_key` is new or severity changed; **every**
      brief line and **every** answer, unconditionally `[F18]`
- [x] Restraint withholding writes a `quiet_decisions` row with reasoning — from any of the three
      paths `[F18]`. Asserted per path. An item Restraint returned no decision for is withheld, not
      surfaced
- [x] Restraint reasoning is item-level or organisation-level, never about a person
- [x] **Briefer** — three fixed sections `[F23]`
- [x] Briefer emits line-level records with evidence refs, not prose blocks `[F25]`
- [x] Briefer handles the empty case with a plain sentence — and reaches it without a model call when
      there is no material, or when gating withholds every line
- [x] Briefer arrival variant, same sections, scoped to unowned and single-held items `[F23]`
- [x] **Respondent** — answer with provenance and age `[F20]`
- [x] Respondent stale-answer branch, with the age stated — age and staleness are **recomputed** from
      the register's own dates, so a model calling a five-month-old claim fresh is overruled
- [x] Respondent unknown branch, becoming a question `[F21]` — also the fallback when nothing it cited
      resolves, since provenance that does not resolve is worse than none
- [x] Respondent ambiguous-holder branch, routed privately `[F21]`
- [x] `ingest` graph: Curator → Cartographer — the one task with no Restraint hook, as it produces no
      text
- [x] `assess` graph: Assessor, gated by Restraint
- [x] `brief` task: Briefer, gated by Restraint on produce
- [x] `respond` task: Respondent, gated by Restraint on produce
- [x] Observation constraint honoured in every prompt: *seen doing*, never *can do* — asserted by test
      across all six, so a seventh prompt cannot quietly omit it

**Two deviations from the technical design, both forced by the real SDK.**

1. **Restraint is a produce-path gate, not an `addHook`.** The design describes it as a hook on the
   produce path. `@strands-agents/sdk` has no after-node hook that can modify or suppress what a node
   produced — `AfterNodeCallEvent` and `NodeResultEvent` expose the result read-only, and the only
   documented veto is `BeforeNodeCallEvent.cancel`, which fires *before* a node runs and so cannot
   judge its output. An `addHook` implementation would have been an observer that could not withhold
   anything. Every property the design was buying is kept: the gate is the only thing that assembles a
   producing task's result, a producing handler's signature requires one, and `producing()` in
   `tasks/index.ts` is the only thing that supplies one — so the veto is still structural rather than a
   convention between prompts, and its scope is still a plain value a test can read.

2. **`Graph` uses a custom `Node` subclass, not `AgentNode`.** `AgentNode` invokes the agent itself and
   passes the previous node's *text* onward, which would cost the validate-and-retry loop and the
   Cartographer's deterministic alias pass, and would make the Cartographer re-parse the Curator's JSON
   out of a chat message. `Node` is abstract with one abstract method, so `PipelineNode` extends it.
   Ordering, per-node status and duration, failure capture and the hook surface remain the SDK's.
   Typed results pass between nodes by closure, because `MultiAgentResult` exposes no app state.

### Feature coverage from this section

Every item above is `[x]`, but a ticked item is not a delivered feature: most of these features have a
worker or web half that is still pending, and reading the ticks as feature completion is exactly the
mistake this table exists to prevent. What the agent layer actually closes:

| F | Agent side | Still needed elsewhere |
| --- | --- | --- |
| F7 Curator, multiple records per message | **Complete** | — |
| F12 Alias matching, model only on ambiguity | **Complete** — schema and agent both done | — |
| F11 Noise as a first-class outcome | Prompt and schema done | The golden message set is a manual run and needs **G1/G2** |
| F16 Severity from the Assessor, confidence separate | Both produced, on separate axes | Worker writes the two columns |
| F17 Aggregation and suppression over SQL candidates | Judgment implemented | **The five detection queries do not exist yet**, so there are no candidates to judge |
| F18 Restraint on three paths, gated per output class | Gate, scoping and quiet-decision records done and asserted | Worker persists `quiet_decisions`; web renders the strip |
| F20 Answer with provenance and age | Four branches, age recomputed from the register | Worker detects the question — mention or reply — and sends the reply |
| F21 Questions targeted by sensitivity | Respondent proposes the target | Worker writes `questions` rows, enforces the ask budget, and routes |
| F23 Brief, three fixed sections, join and leave | Both variants, including the empty case | Worker fires it from a `chat_member` event |
| F25 Line-level brief records with evidence | Lines emitted with their own evidence refs | Worker writes `brief_lines`; web makes them assignable |

So **F7 and F12 are closed outright**; the other eight are half-built, with the named half outstanding.
`[F13]` and `[F15]` are referenced by the schema and worker sections rather than this one — the
Cartographer writes holdings as history through the worker, and the five queries that render as four
subtypes are the worker's — so neither advanced here.

Two features this section does **not** touch, despite being agent-adjacent: `[F32]` interrupt raising and
`[F33]` pending changes staying out of findings both belong to the Approval round trip below. The `resume`
mechanism is implemented, but nothing raises an interrupt yet, so it is unreachable.

## Approval round trip

- [ ] Interrupt raised via `event.interrupt({ name, reason })`
- [ ] Interrupt returned to the worker with `stopReason` and the interrupts array
- [ ] Worker writes `questions` + `pending_changes` + snapshot
- [ ] Approval message names all four things: action, uncertainty, evidence, effect of refusal `[F32]`
- [ ] Routing by `assets.sensitivity` — group, or coordinator privately
- [ ] Pending changes excluded from every finding and every brief `[F33]`
- [ ] Never adopted on timeout; never discarded `[F33]`
- [ ] **Answerer identity checked** — approvals resolve only for the coordinator `[F34]`
- [ ] Verification and clarification accept any group member's answer `[F34]`
- [ ] Ambiguous reply → ask once more, then route to the coordinator and stop asking the group
- [ ] `resume` task restores the snapshot and passes `interruptResponse` blocks
- [ ] Second approval on the same asset queues behind the first
- [ ] Answer arriving after its pending change was superseded resolves as obsolete
- [ ] Fallback rung recorded, if G5 forced one

## Web — admin UI

- [ ] Shared passcode exchanged for a signed session cookie `[F29]`
- [ ] Route protection on every page and API route
- [ ] **Continuity** — header with last-run status and navigation `[F26]`
- [ ] State of the organisation in one sentence
- [ ] Since-you-last-looked diff, against `coordinator_state`
- [ ] Waiting-on line for open questions, rendering `queued` and `asked` together — both mean Baton is
      holding something back `[F36]`
- [ ] Unread-brief banner
- [ ] Ranked register, five to eight finding cards
- [ ] Finding card: capability-subject title, subtype badge, why-it-matters, evidence count,
      confidence, holder as a small attribute
- [ ] Finding actions: resolve, already have a backup, dismiss `[F19]`
- [ ] Quiet-decisions strip, expanded by default, with a link to the full list `[F18]`
- [ ] Dismissed-findings list reachable from the register footer `[F19]`
- [ ] State line, register and quiet-decisions strip all fit the first viewport
- [ ] **Who holds what** — inventory grouped by asset kind `[F26]`
- [ ] Row: claim, holder, coverage count, confidence, last confirmed, status
- [ ] **Briefs** — current brief and all past briefs `[F25]`
- [ ] Brief copyable as text `[F25]`
- [ ] Brief lines individually assignable, as a record with no notification `[F25]`
- [ ] Brief offered to its subject — copyable text always; direct message only where that person has
      previously opened a chat with the bot `[F24]`
- [ ] **Fact detail** panel, openable from any claim on any surface `[F27]`
- [ ] Fact detail: claim, status, holder history, source message quoted verbatim with sender and date
- [ ] Fact detail: supersession chain and Baton's stated reasoning
- [ ] Fact detail actions: correct, retire, mark verified
- [ ] Credential redaction applied everywhere a message is quoted `[F30]`
- [ ] Withdraw-provenance action, since Telegram reports no deletions `[F4]`
- [ ] **Agent activity** slide-over from the header `[F28]`
- [ ] Activity panel: messages read, facts extracted, candidates skipped, run trace
- [ ] Empty states read as good news, not errors
- [ ] Absent by design, verify: no question box, no charts, no volunteer pages, no settings page,
      no mobile layout

## Seed data

### Generation

- [x] `seed-plan.ts` produces the deterministic plan — roster of twenty with alias forms, six-month event
      calendar, asset inventory across all six kinds, capability areas, and a placement for every coverage
      row below. Pure data: no model, no database, no network. Every assertion runs before anything is
      written, so an invalid plan fails at generation
- [x] Plan output committed as a fixture, so a regenerated transcript exercises the same paths —
      `scripts/fixtures/seed-plan.json`, compared **byte for byte** against a fresh `buildPlan()` by test,
      and `seed-transcript.ts` refuses to render from a stale fixture
- [x] `seed-transcript.ts` renders prose against the plan, in day-sized chunks
- [~] **Six-month** transcript, twenty people, ~4,500 messages, reads as genuinely human — 4,421 messages,
      20 people, 2026-03-15 → 2026-09-12. What remains is only the last clause: filler is rendered from
      deterministic templates, which reads as plausible operational chatter rather than as genuinely human.
      A model-backed `FillerProvider` replaces it and the seam already exists; **blocked on G1 and G2**.
      Placed material is authored and verbatim either way, so no coverage row depends on this
- [ ] Enters through the same normaliser as live traffic, `source = 'seed'` `[F2]` — the renderer emits
      normalised-shape records and tags `source: "seed"`, but nothing loads them yet. Deliberately not
      done here: a second insert path in the seed script would be a second normaliser and the two would
      drift. **Waiting on C's normaliser**; `backfill.ts` consumes the artifact through it
- [x] Currency INR, copy readable internationally — ₹ amounts throughout, Bengaluru place names, English
      that needs no local knowledge to follow
- [x] Two-month slice available for development, full six months for the final pass —
      `pnpm seed:transcript -- --months 2` gives 1,753 messages with **every coverage row still matched**;
      placements compress into the shorter span rather than dropping, and their relative order is asserted
      by test
- [x] **Coverage report emitted after render, keyed to the rows below, exiting non-zero on any unmatched
      row** — a warning is not sufficient, because a transcript missing a path looks fine `[F2]`. Observed
      failing on a real gap (`relative_dates`, before its material was added) and passing afterwards
- [x] Rows the scanner cannot pattern-match reported as *asserted by plan*, traceable to their placement —
      two rows, each printing the plan message ids that claim it. A row with neither a scanner rule nor a
      plan assertion is itself a non-zero exit
- [~] **Seed people bound to real Telegram user ids** for every account used on camera, asserted by the
      script — the leaver must be the seeded owner of the donation page or the opening case does not fire.
      The binding *mechanism* is done and both halves are enforced: the plan asserts that the volunteer
      bound to `leaver` is the sender of the donation-page message, and the transcript exits non-zero
      unless `SEED_TELEGRAM_ID_{COORDINATOR,LEAVER,ARRIVER}` are set. **No real ids yet** — the demo
      accounts do not exist, so runs currently pass `--allow-unbound`

### Planted cases — the demo spine

- [x] The orphan — donation page owner is the volunteer who leaves on camera. `pm006`, 8 April, from the
      person bound to the `leaver` role. Asserted, not assumed
- [x] The restraint — four-day-old undated promise, nothing blocked on it. `pm042`, 9 September
- [x] The stale answer — sterilisation rate, five months old. `pm008`, 13 April, and never restated
- [x] The provenance click — a brief line traceable to a five-month-old message. The same `pm006`, which is
      why one message carries two cases rather than the fact being authored twice
- [x] The approval — one ambiguous message about financial control changing hands. `pm040` and `pm041`,
      3–4 September. Deliberately readable as an offer rather than a change
- [x] Cases woven through the transcript, not appended — asserted by test: case material spans more than
      one month, and every placed message is rendered in date order among that day's ordinary chatter

### Coverage rows — every behaviour path has material

One item per row of the coverage table in the design document. A path with no material cannot be
demonstrated and has almost certainly never been tested.

**All 26 are satisfied and verified by the coverage report: 24 matched by pattern against the rendered
output, 2 asserted by plan.** Each row below names the requirement the scanner checks, so a paraphrase that
destroys the material fails rather than passing quietly.

- [x] Durable fact — a settlement arrangement, a number printed on something, a named account holder
- [x] Commitment — one dated promise and one undated intention. Both halves checked; half is a failure
- [x] Participation evidence — post-event thanks naming several people, more than once `[F14]` — count ≥ 2
- [x] Lifecycle — one departure and one arrival inside the seeded window, before the live one `[F3]`
- [x] Noise — jokes, agreement fragments, logistics chatter, a conditional about something that does not
      exist `[F11]`
- [x] Pre-filter recall — a durable fact buried in an otherwise chatty message `[F6]`
- [x] Multiple records per message — one message carrying both a fact and a commitment `[F7]`
- [x] Restatement — the same fact stated again months later, in different words `[F8]`
- [x] Contradiction — a fact replaced by a later one, the clinic's terms change `[F8]`
- [x] Negation — an arrangement explicitly ended `[F8]`
- [x] Hearsay — someone relaying what a third party said `[F9]`
- [x] Relative dates — "next Tuesday", "end of the month", "last week" `[F10]` — all three checked
- [x] Identity — every alias kind: handle, display name, nickname, first name, role reference `[F12]`
- [x] Ambiguity — one first name resolving to two different people `[F12]` — a real collision in the
      roster, not a phrase: two people answer to "Priya"
- [x] Six asset kinds — at least one each: login, physical item, financial control, relationship,
      document, public presence `[F13]` — one scanner pattern per kind, plus a structural assertion on the
      inventory
- [x] Transfer of holding — one asset changing hands, so holdings history carries a closed row `[F13]`
- [x] Personal resource — an asset that is actually someone's own property, the van `[F15]`
- [x] Commitment closure — a promise later evidenced as done
- [x] Capability coverage — one capability with several observed participants, one with exactly one `[F14]`
      — **asserted by plan**: a property of the participation pools, checked in `plan.ts` rather than by a
      regex over prose
- [x] Aggregation — three separate exposures inside a single capability area `[F17]` — **asserted by
      plan**, traceable to four placements in foster placement
- [x] Suppression — a candidate finding resting on one throwaway mention `[F17]`
- [x] Answerable question — an operational figure the coordinator is visibly asked more than once `[F20]`
      — count ≥ 3: stated once, asked twice
- [x] Unknown — a question the transcript deliberately never answers `[F21]`
- [x] Credential exposure — a credential-shaped string pasted into the group `[F30]`
- [x] Media — a voice note and an image `[F5]` — checked on `mediaKind`, not on words
- [x] Provenance edge cases — one forwarded message and one later edited `[F4]` — checked on the flags

## Tests

- [ ] Pre-filter — table-driven over a labelled corpus, scored on **recall**
- [~] Schema conformance — every Zod schema against recorded responses, including malformed ones. 26
      cases in `packages/core/test/agent-schemas.test.ts` cover all six schemas and every malformed
      branch the design names — suppression with no reason, a withholding with no reason, an empty brief
      that does not say so, a stale answer with no age, an ambiguous holder with one candidate. The
      retry path they are meant to prove now exists (`apps/agent/src/model/structured.ts`) and its
      JSON-extraction seam is tested directly, but the loop itself is still exercised against
      hand-written fixtures: **real recorded model responses wait on G2**
- [ ] Detection SQL — five queries against fixtures with known answers
- [ ] Detection SQL — `unverified` and `pending_approval` rows never appear
- [ ] Fact matching — restatement bumps without inserting; contradiction inserts and links
- [ ] Dedupe — two consecutive sweeps produce one finding
- [ ] Dismissal — a dismissed finding never returns
- [ ] Ordering — a contradiction applied forwards and backwards reaches the same state
- [ ] Approval round trip — interrupt, snapshot, restore, resume, apply
- [ ] Approval round trip — rejected path
- [ ] Approval round trip — answer from a non-coordinator does not resolve
- [ ] Ask budget — a third simultaneous ask queues rather than sending `[F36]`
- [ ] Ask budget — a fourth ask inside 24 hours queues `[F36]`
- [ ] Ask budget — an approval raised while the budget is full of verifications is asked before them `[F36]`
- [ ] Ask budget — a queued ask is neither dropped nor duplicated `[F36]`
- [x] Restraint scope — hook registered on `assess`, `brief` **and** `respond`, asserted directly `[F18]`
      — `apps/agent/test/restraint-scope.test.ts` asserts the wiring set is exactly those three and that
      `ingest` is absent; `apps/agent/test/gate.test.ts` asserts a withholding produces a quiet decision
      from each of the three scopes, that an unjudged item is withheld rather than surfaced, and that a
      settled finding is never re-sent to the model
- [ ] Restraint scope — a withheld brief line and a withheld answer each write a `quiet_decisions` row `[F18]`
- [x] Seed coverage — every coverage row matched or asserted by plan; a mutilated plan exits non-zero
      `[F2]`. 22 tests in `scripts/test/seed-coverage.test.ts`, and the mutilation cases are the point:
      removing a row's only material, **paraphrasing** it, satisfying only half of a two-part row, and
      dropping a count-based row to one occurrence each report as missing. A fail-closed check never
      observed failing is indistinguishable from one that always passes
- [x] Redaction — a credential-shaped string never renders. 20 cases, including negative cases proving
      the emergency number, Indian mobile numbers, rupee amounts and ISO dates survive unchanged
- [x] Structural privacy guarantees — Drizzle introspection asserting no attendance table and no scoring
      column, plus a case proving the detection logic itself works
- [x] Worker HTTP surface — `/health` unauthenticated and 503 when the database is down; every `/data/*`
      route rejecting absent and wrong tokens and admitting the correct one
- [x] Transport configuration — each `AGENT_TRANSPORT` requiring only its own variables, an unknown
      transport rejected rather than defaulted, timezone defaulting to IST
- [ ] Golden message set with expected classifications, run manually

## Deployment

### Images — build locally before deploying anything

Blocked at initialization: the Docker daemon was unavailable, so the compose files are validated by
`docker compose config` only and no image has been built. Multi-stage pnpm-workspace builds are where
small mistakes hide, so these precede any deploy attempt.

- [ ] `docker build -f apps/agent/Dockerfile .` succeeds
- [ ] `docker build -f apps/worker/Dockerfile .` succeeds
- [ ] `docker build -f apps/web/Dockerfile .` succeeds — the standalone trace must include
      `packages/core`, or the image starts and fails on first import
- [ ] Web build peak memory recorded, and compared against the VM's free memory
- [ ] `docker compose -f docker-compose.dev.yml up -d` brings Postgres up healthy
- [ ] Worker container starts, runs migrations, and answers `/health` with 200

### AWS — the agent

- [ ] Agent container built and deployed to AgentCore via the AgentCore CLI, CodeBuild building remotely
- [ ] IAM user scoped to `bedrock-agentcore:InvokeAgentRuntime` only
- [ ] AgentCore execution role permitting ECR pull and CloudWatch Logs write
- [ ] Agent environment set at launch, including `DATA_API_URL` pointing at the live route
- [ ] Verify absent by inspection: no VPC, no RDS, no Secrets Manager, no load balancer

### VM — Coolify

- [ ] Postgres, worker and web deployed as a **single Coolify Docker Compose resource**
- [ ] **Rolling updates do not apply** — verified by deploying as Compose, or explicitly disabled on the
      worker if it is ever split into its own Application resource. Two `getUpdates` consumers on one
      token split the update stream with no visible error
- [ ] Coolify proxy serving the admin UI over TLS on the public hostname
- [ ] Coolify proxy serving the data API route with bearer-token auth
- [ ] TLS certificate issued **before** `agentcore launch`, since `DATA_API_URL` must resolve
- [ ] Unauthenticated `GET /health` on the worker, not published publicly, used as the Coolify health check
- [ ] Health check does **not** target the token-protected data API — a 401 reads as unhealthy and
      restart-loops past the worker's own backoff
- [ ] Postgres public-port toggle off — verify from outside the VM, not from the topology diagram
- [ ] Each Dockerfile builds with the **repository root** as context, so `packages/core` resolves
- [ ] VM free memory checked against a Next.js production build; image built elsewhere if tight
- [ ] Environment variables held in Coolify's per-resource config, not a file beside the code
- [ ] No second reverse proxy anywhere — Coolify's proxy owns ports 80 and 443
- [ ] Bot token in Coolify's environment config, never committed

### Environments

- [ ] `AGENT_TRANSPORT` implemented as one interface with two implementations: `agentcore` (SigV4) and
      `http` (local agent), with the AWS variables unused under `http`
- [ ] Second BotFather bot and private test group for local development, with privacy mode off, promoted
      to administrator, and `allowed_updates` set — all three, or membership events are silently absent
- [ ] Local stack runs with no AWS credentials at all
- [ ] Local worker can be pointed at the **deployed** runtime by env change alone, for verifying G4
- [x] Two-month slice loaded locally; full six months only on the deployed environment — 1,753 messages
      in Postgres via `pnpm backfill -- --chat-id 0`, idempotent on re-run
- [ ] `pg_dump` flows deployed → local only; never local → deployed, which would destroy the reset point
- [ ] `reset-demo.ts` restores the golden dump
- [ ] Golden `pg_dump` taken after the first good backfill
- [ ] Deploy order for a `packages/core` shape change recorded: agent first, then worker

## Demo and submission

- [ ] Backfill run against the full six months, with a passing coverage report
- [ ] Register reviewed by eye — five to eight findings, phrased about capabilities
- [ ] Rehearsal: all five planted cases, end to end
- [ ] AgentCore warmed immediately before recording
- [ ] Video recorded **before** the URL is shared, so the since-you-last-looked diff is not empty
- [ ] Video under five minutes, opening on a departure and a brief writing itself
- [ ] Group-answering behaviour appears second, never first
- [ ] The boundary line stated aloud: what the organisation knows, not what its people do
- [ ] Telegram-over-WhatsApp substitution stated aloud
- [ ] README: setup, prerequisites, judge passcode, architecture, Strands usage map
- [ ] README: seeded-history rationale, and the no-score / no-attendance guarantee
- [ ] README prerequisites: bot admin, privacy mode off, coordinator has messaged the bot
- [ ] Architecture diagram, committed at `ARCHITECTURE.md` and linked from the README — outside any
      ignored path
- [ ] Public repository, MIT license detectable in the About section
- [ ] About field set to the short description
- [ ] Live URL reachable
- [ ] AWS Builder ID on the submission
- [ ] Good Neighbor track selected

---

## Cut order, if the schedule slips

Degrade in this order and stop as soon as the schedule is recovered. Record each as `[-]` with the
reason.

1. [ ] Coverage inference narrows to explicit thanks-lists only
2. [ ] Coverage dropped from findings, which then run on holdings alone
3. [ ] Identity resolution reduces to exact handle matching
4. [ ] Ask-instead-of-guess becomes a logged question with a canned answer
5. [ ] Seeded history shrinks from six months to three, keeping every coverage row and rescaling the
       stale figure so it still sits near the start of the window

**Never cut.** If one of these is at risk, cut from the list above first, then from anything not in the
design document at all:

- Restraint behaviour and its visible reasoning
- The human-approval gate on uncertain high-consequence writes
- One-person risk detection
- Provenance on every claim
- The brief firing from a lifecycle event rather than a button

## Deferred — Tier 2

Only if ahead of schedule. Do not start any of these while a Phase 0 gate is unproven.

- [ ] Proactive stale-fact section in the register, with the full verification loop
- [ ] Plaintext-credential exposure detection
- [ ] Conflicting-holder resolution as a workflow
- [ ] Transfers of holding as first-class events
