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

**Status — 2026-09-14.** 240 done · 8 partial · 116 pending, of 364.

The item count grew from 329 to 364 because this revision added items rather than only ticking them: the
normalisation primitives and the three new schema objects that the worker needed, and two new sections —
**Worker — backfill** and **Worker — runtime loop** — for work that the previous revision had folded
invisibly into other sections. Splitting them out is the point: the runtime loop being unwired is the
single most misleading thing about the tick counts above, and it deserved its own heading rather than a
footnote.

`packages/core`, the database schema, seed data generation, **the agent container with all six
agents**, and **the worker's intake, derivation, detection, orchestration and approval halves** are
complete. `pnpm typecheck` passes on all five workspaces, `pnpm lint` is clean, `pnpm build` succeeds for
core, worker and agent, and **797 tests pass** (254 in core, 476 in worker, 45 in the agent, 22 in
scripts).

Two whole-repository commands do **not** currently pass, and the earlier claim that they did has been
corrected rather than carried forward. `pnpm format` exits non-zero on **17 files, every one of them under
`apps/web`** — untouched by the worker work and unformatted before it started. `pnpm build` fails for
`apps/web` with an `EPERM` symlink error in the Next standalone copy step, confirmed pre-existing by
stashing the worker changes and rebuilding. Both belong to the web app and neither is fixed here, but a
tracking document that claims a green command which is red is worse than one that admits the red.

**The worker is now proved against live Postgres, not against generated SQL.** Docker runs on the
development machine, `docker-compose.dev.yml` brings up Postgres 17.10 on `127.0.0.1:5433`, and all four
migrations are applied to two databases — `baton` and a separate `baton_test`, both at 21 tables. Every
worker item ticked below is proved by an integration test that executed real SQL against that server.
This is the single largest change since the last revision: the previous status recorded that no migration
had ever been applied, and that is no longer true.

**One thing the ticks below must not be read as saying: `apps/worker/src/main.ts` starts no loops.** It
runs migrations, opens the HTTP server, and stops. The intake loop, the processing loop, the sweep
scheduler and the ask and respond passes are all implemented and integration-tested, but nothing calls
them in a running container — that wiring is the **Worker — runtime loop** section below, and until it is
done the worker is a library with a health check. Every behavioural item in the four worker sections is
therefore honest about being test-proved rather than deployment-proved.

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

The schema is 21 tables across four migrations —
`0000_tranquil_wolfpack.sql`, then `0001_unknown_wolf_cub.sql` (`worker_state`, the polling offset),
`0002_next_psylocke.sql` (`facts.value_signature`) and `0003_outstanding_nightmare.sql`
(`messages.is_question_to_bot`, `question_answered_at` and their index) — and three guarantees the
checklist previously left to inspection are now automated: the no-database-client rule in `apps/agent` by
ESLint, the no-attendance-table / no-scoring-column rule by Drizzle introspection over all 21 tables, and the
weight-bearing columns and indexes by `packages/core/test/schema-invariants.test.ts` — which asserts that
`questions.asked_at` is nullable **with no default**, that `holdings.holder_person_id` and
`commitments.owner_person_id` stay nullable, that `facts.match_key` and `findings.dedupe_key` exist, and
that all five named indexes appear in the generated SQL.

Seed generation runs in the two phases the design requires. `pnpm seed:plan` writes a committed fixture —
20 people, 12 assets across all six kinds, 6 capabilities, 61 events, 43 authored placements covering all
26 coverage rows and all 5 planted cases — and refuses to write an invalid plan. `pnpm seed:transcript`
renders 4,421 messages across six months and its coverage report exits non-zero on any unmatched row; the
two-month development slice keeps every row while compressing rather than dropping.

Five things are explicitly **not** done and should not be inferred from the above. **Every Phase 0 gate is
still unproven**, and **no model call has been made** — the six agents and every worker pass that invokes
them are wired, typechecked and tested against fake transports, but nothing here has ever seen a model.
Consequently `G1`, `G2`, `G4`, `G5` and `G6` bound what the tests below can claim: no AgentCore
invocation, no real interrupt, and no Telegram bot in a real group. **No container image has been built**
and no deployment has happened. **No seeded message has entered Postgres**: the transcript is still an
artifact on disk. The normaliser it was waiting on now exists in `packages/core`, so the remaining work is
`scripts/backfill.ts` replaying the artifact through it — the **Worker — backfill** section below. And
**the worker's runtime loop is not wired**, as described above.

What is no longer a caveat: the four `/data/*` routes are implemented and answer real queries, the
migration path is proved against a live server, and the normaliser exists and is shared by both the
Telegram and the seed intake paths.

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

- [x] Drizzle schema for every table (see next section) — 21 tables, verified by test:
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
- [x] **Normalisation primitives** — `normalise.ts` (`contentHash`, text normalisation),
      `keys.ts` (`normalisedKey`, `buildMatchKey`, `buildDedupeKey`), `value-signature.ts`. These live in
      core rather than the worker because the seed backfill and live Telegram traffic must produce
      byte-identical keys; two copies would drift and the drift would show up as duplicate facts
- [x] **`NormalisedMessage` and its two adapters** — one internal shape with a Telegram adapter and a
      seed adapter `[F1]` `[F2]`. The shape is the contract that makes "seeded messages enter through the
      same normaliser as live traffic" structural rather than a promise
- [x] Deterministic pre-filter — `prefilter.ts` with `PREFILTER_VERSION`, recall-biased `[F6]`
- [x] Relative-date resolution against an organisation timezone — `timezone.ts`, never UTC `[F10]`
- [x] Deterministic consequence classification — `consequence.ts`, from asset kind and sensitivity
      `[F31]`
- [x] Deterministic alias matching — `alias-match.ts` (`AliasIndex`, `editDistanceWithin`,
      `needsEscalation`) `[F12]`. **Moved here from `apps/agent`, which now re-exports it**, because the
      worker must re-attribute cache-hit messages without a model call and the two paths have to agree
      exactly
- [x] Question detection — `intake/question.ts`, two signals only: an @-mention or a reply to the bot
      `[F20]`. 17 tests, weighted toward the negatives, because the restraint is the part that needs
      proving
- [x] Integration-test harness — `db/testing.ts`, truncating between tests against a separate
      `baton_test` database, so core and worker suites can both hit real Postgres

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
- [x] `worker_state` — the committed `getUpdates` offset, added by `0001_unknown_wolf_cub.sql`. In the
      database rather than in memory because a restart that forgets the offset re-reads the whole backlog
      and re-answers questions in front of the group
- [x] `facts.value_signature`, added by `0002_next_psylocke.sql` — what makes "the same claim restated"
      distinguishable from "a different claim about the same thing", which is the restatement/
      contradiction fork `[F8]`
- [x] `messages.is_question_to_bot` and `question_answered_at`, added by
      `0003_outstanding_nightmare.sql`, with an index on the pair. **Persisted rather than re-derived:**
      the reply signal needs the replied-to message's sender and the bot's own messages are never stored,
      so after intake the fact is unrecoverable from `messages` alone. `question_answered_at` is what
      makes answering idempotent — without it a restart re-answers the entire transcript in front of the
      group
- [x] Indexes: `messages(prefilter_verdict, curated_at)`, `facts(asset_id, status)`,
      `holdings(asset_id, status)`, `findings(status, severity desc)`,
      `curator_cache(content_hash, prompt_version)` — all five asserted against the generated SQL
- [x] Migrations run from `packages/core` on worker start — `runMigrations` is called first in
      `apps/worker/src/main.ts`, and **all four migrations have been applied to live Postgres 17.10**
      (`127.0.0.1:5433`), to both `baton` and `baton_test`, each verified at 21 tables by `\d`. The schema
      is no longer proved by generated SQL alone: Postgres has accepted it

**Structural guarantees — verify by inspection, not by intent:**

- [x] No attendance table exists anywhere — enforced by test, not inspection: Drizzle table
      introspection in `packages/core/test/privacy-guarantees.test.ts`. **No longer vacuous** — it now
      introspects 21 real tables
- [x] No per-person score column exists anywhere — no completion rate, no reliability figure, no activity
      metric. Same test, over every column of all 21 tables. `capability_coverage` records that someone
      was seen doing something and deliberately does not record how often or how well

## Worker — Telegram

Implemented and integration-tested against live Postgres with a fake Telegram transport. **No item here
has spoken to Telegram's real API** — that is `G6`, still unproven — and `IntakeLoop` is not started by
`main.ts`, so read every tick as "the behaviour is proved by a test", not "it is running.".

- [x] Long-poll loop against `getUpdates` with committed offset — `telegram/intake-loop.ts`, offset
      persisted in `worker_state` so a restart resumes rather than re-reading the backlog
- [x] `allowed_updates` set to `["message", "edited_message", "chat_member", "my_chat_member"]` —
      `TELEGRAM_ALLOWED_UPDATES` in core, sent on **every** poll rather than once, because Telegram
      remembers it per call and an omission silently narrows what arrives
- [x] Normaliser producing one internal message shape `[F1]` — in `packages/core`, shared with the seed
      path
- [x] Messages from an unrecognised chat id ignored — `reason: "foreign_chat"`, counted rather than
      silently dropped, because "ignored 400 updates" is only actionable with a why
- [x] **Bot's own messages dropped at intake** `[F35]` — `reason: "own_message"`, and when the bot's user
      id is not yet known nothing is treated as the bot's, which is the safe direction
- [x] Forwarded messages attributed to the forwarder and flagged `[F4]` — original author recorded as
      plain text, never as a person reference; reads Bot API 7.0+ `forward_origin` first, then the legacy
      fields, since a deployed bot may be talking to either
- [x] `edited_message` resets `curated_at` and `prefilter_verdict`, triggers re-curation `[F4]` —
      `pipeline/edits.ts`, keyed on `content_hash` so a redelivery of identical text does not re-curate
- [x] Re-curation after an edit supersedes prior facts rather than mutating them `[F4]` —
      `applyEditConsequences`
- [x] Non-text media logged with `unprocessed` `[F5]` — and a photo *caption* is curated normally, so the
      flag marks a gap in what can be read rather than the presence of a file
- [x] `chat_member` join/leave → lifecycle event recorded `[F3]` — `pipeline/lifecycle.ts`
- [~] `my_chat_member` → one-time introduction message, idempotent per chat `[F22]` —
      `handleBotMembershipEvent` is implemented and tested, and its introduction goes through the outbound
      queue. **Not wired into `main.ts`**; see **Worker — runtime loop** below
- [x] Question detection: mention of the bot, or reply to it — nothing else `[F20]`. A question mark,
      question words and the bot's name in prose are deliberately **not** signals: a bot that answers
      anything ending in "?" teaches the group to ignore it, and no later code change undoes that
- [~] Reply matching: `reply_to` first, then most recent open question from that sender in a window,
      then ambiguous — **only the first rung is implemented.** `matchApprovalReply` uses the exact
      bot-message-id match and refuses rather than widening, because for an approval a wrong match applies
      a change nobody approved. The window fallback is still fine for verifications and is not built
- [x] Outbound queue with a rate limit, used by **every** outbound path — `telegram/outbound-queue.ts`
- [x] Ask budget enforced in SQL: at most two open questions, three new per rolling 24 hours `[F36]` —
      `pipeline/ask.ts`, counted in SQL rather than asked of a prompt
- [x] Ask priority derived from `kind` — approval, then clarification, then verification `[F36]`. Derived,
      never stored: the ordering is fixed policy, not a per-question judgment
- [x] A blocked ask is inserted `queued`, never dropped and never asked twice `[F36]`
- [x] A queued ask's claim stays excluded from findings and briefs while it waits `[F36]`
- [x] Private-message path to the coordinator, with graceful fallback when no private chat exists —
      `telegram/private-delivery.ts`, reporting `sent` or `undeliverable` and never throwing, because a
      bot cannot open a chat with someone who has never written to it

## Worker — pre-filter

- [x] Deterministic heuristics, recall-biased `[F6]` — `packages/core/src/prefilter.ts`
- [x] Verdict and `prefilter_version` written for every message, kept and discarded alike — a discarded
      message keeps its verdict, which is what makes the re-evaluation path below possible
- [x] Re-evaluation path for previously discarded messages when the version changes —
      `pipeline/prefilter.ts`, selecting on a `prefilter_version` mismatch
- [x] Skipped count exposed to `runs` `[F28]`

## Worker — persistence and derivation

- [x] Intake loop and processing loop are **separate** — curation never blocks polling. Two modules,
      `telegram/intake-loop.ts` and `pipeline/processing-loop.ts`, sharing only the database
- [x] Strict `sent_at` ordering through the processing loop — asserted directly, because supersession is
      order-dependent and a contradiction processed backwards silently inverts a fact
- [x] Postgres advisory lock so only one pipeline task runs at a time — `store/lock.ts`, using
      `pg_try_advisory_xact_lock` **inside a transaction**. Session-level `pg_try_advisory_lock` was
      rejected: with a pooled connection the unlock can land on a different connection and leave the lock
      held forever. The accepted cost is that the transaction spans the model call
- [x] Curator cache lookup happens **before** batches are formed; batches contain misses only —
      `store/curator-cache.ts`. Cache hits are re-attributed deterministically by the worker via core's
      `AliasIndex`, because attributions depend on the mutable alias table and so cannot be cached
- [x] Fact merge on restatement via `match_key` — bumps `last_confirmed_at`, appends evidence `[F8]`.
      Never drags the confirmation date backwards when an older message arrives late
- [x] Fact supersession on contradiction — new row, `supersedes_fact_id` set `[F8]`
- [x] Fact retirement on negation `[F8]`
- [x] Hearsay written at low confidence with `unverified` status `[F9]`
- [x] Relative dates resolved against `app_settings.timezone`, not UTC `[F10]`
- [x] Holdings written as history; transfer closes one row and opens another `[F13]`. The branch is driven
      by the **fact outcome**, not by comparing holders, so there is only one copy of the
      value-signature judgment. Documented limitation: two simultaneous co-holders of one asset is
      unreachable through extraction, because a shared `match_key` reads the second as a transfer — the
      gap is in extraction, not in storage
- [x] Commitment closure detected from later messages
- [x] Coverage sets updated from participation evidence `[F14]`
- [x] Deterministic consequence classification from asset kind and sensitivity `[F31]` — in
      `packages/core/src/consequence.ts`
- [x] Detection SQL: `sole_holder` (asset)
- [x] Detection SQL: `sole_holder` (capability variant)
- [x] Detection SQL: `no_owner`
- [x] Detection SQL: `not_ours`
- [x] Detection SQL: `loose_end`
- [x] Five queries render as exactly four UI subtypes, matching the design document `[F15]`
- [x] **Every detection query filters `status = 'active'`** — this is what keeps pending changes out of
      findings `[F33]`. Asserted per query, and separately on the two other routes a pending claim could
      leak through: the respond fact index and the brief holdings join
- [x] Findings upsert on `dedupe_key`; dismissed keys skipped `[F19]` — a dismissed key is dropped
      *before* the Assessor, so the model is never asked about it either
- [x] Sweep short-circuits in SQL when the candidate set is unchanged — no invocation at all. The
      fingerprint deliberately **excludes `previousSeverity` and `evidenceExcerpts`**: `previousSeverity`
      is read back out of `findings`, so including it means the short-circuit never fires once while every
      other test still passes. A short-circuited sweep still writes a `runs` row, because "nothing had
      changed" is a result and a silent sweep is indistinguishable from a scheduler that stopped
- [x] Restraint invoked only for new or re-severitied findings
- [x] `runs` row written for every pipeline execution, including the trace returned by the agent `[F28]`

Three thresholds in this section are **my numbers, not the design's**, kept isolated and documented as
tunable: `LOOSE_END_UNDATED_DAYS = 3`, `WEAK_EVIDENCE_CONFIDENCE = 0.7`, `CLOSURE_OVERLAP_THRESHOLD = 0.5`.

Two decisions here are worth stating because a reader would otherwise assume the opposite. A **suppressed**
finding leaves an existing open row alone, bumping `last_seen_at` rather than resolving it — suppression
means "not worth raising", not "no longer true", and withdrawing something a coordinator has already read,
with no explanation, is worse than leaving a thin item where Dismiss is one click away. An **aggregated**
finding resolves, rather than acquiring a fourth status the UI has no way to render. Curation reset is
**content-hash driven**, not event-driven. Alias learning refuses `role_reference`, and `sensitivity` on
assets ratchets **up only**.

## Worker — orchestration and API

- [x] Agent invocation client behind one interface with two transports — `AGENT_TRANSPORT=agentcore`
      (SigV4) and `http` (local agent). Built before the orchestration module, not retrofitted
- [ ] SigV4-signed AgentCore invocation client — interface in place, implementation lands with G4.
      Everything below is proved over `AGENT_TRANSPORT=http` against a fake agent
- [~] Explicit session termination when a task returns — `transport.close()` exists and `main.ts` calls it
      on shutdown, but it is not called per task. Which of the two is correct depends on `G8`, the billing
      boundary, so this deliberately waits rather than guessing
- [ ] Exponential backoff and a cap on consecutive failures — **not built.** See **Worker — runtime loop**
      below; an unattended crash-loop is the cheapest way to spend real money here
- [x] Context hydration per task, per the hydration table — Curator does **not** receive the fact index.
      `pipeline/hydrate.ts`; `hydrateIngestContext` omits it while `hydrateRespondContext` includes it.
      The fact index **is** the whole retrieval layer, with no vector store on purpose: a couple of hundred
      claims is a few thousand tokens, and embeddings over 200 rows would be ceremony that also introduces
      a way for the right fact to be absent from a request
- [ ] Scheduler for the periodic sweep — `sweepWouldDoAnything()` exists so the scheduler can check
      cheaply without taking the pipeline lock, but nothing schedules. See **Worker — runtime loop** below
- [x] Data API: `searchFacts`, `getEvidence`, `getHoldings`, `getPerson` — read-only. **No longer 501
      stubs**; all four answer real queries and are integration-tested against live Postgres
- [x] Data API bearer-token auth — verified by test: absent and wrong tokens rejected on every route,
      the correct token admitted
- [ ] Data API exposed through the Coolify proxy on a dedicated route
- [x] Unauthenticated `GET /health`, separate from the data API route and not published publicly —
      verified by test, including the 503 path when the database is unreachable

## Worker — backfill

`scripts/backfill.ts` replays the committed transcript artifact into Postgres through the **same**
normaliser live Telegram traffic uses. It is a separate section because it is the last thing standing
between the seeded six months and a database that can be demonstrated, and because every item below is a
place where a second, subtly different insert path could creep in.

- [ ] Reads the rendered transcript artifact and feeds it through `packages/core`'s seed adapter — **no
      insert statement of its own** `[F2]`
- [ ] Uses `expandRenderedMessage` from `@baton/core` for edited messages. It returns `[original]` or
      `[original, edited]` as two events sharing one `telegramMessageId`, so the edit arrives as an upsert
      over the original rather than as a second row — which is what makes the seeded edit exercise the real
      `edited_message` path `[F4]`
- [ ] Resolves seeded senders to `people` rows and passes `senderPersonId` **explicitly** to
      `persistMessage`. **17 of the 20 volunteers have no Telegram account**, so sender resolution cannot
      go through `senderTelegramUserId`; leaving it implicit silently attributes seventeen people's
      messages to nobody
- [ ] Feeds messages in strict `sent_at` order, so reply pointers resolve and supersession lands the right
      way round
- [ ] Calls `runIngestPass` repeatedly under a single `runId` from `openRun(db, "backfill")`, so each
      transaction stays bounded while one run row spans the whole replay. A single transaction over 4,421
      messages would hold the advisory lock across every model call in the batch
- [ ] Finishes with `runSweepPass(deps, { runId, force: true })` — `force` exists precisely because a first
      run has no previous fingerprint to compare against, and without it the short-circuit would skip the
      only sweep that matters
- [ ] Idempotent: a second run over the same artifact adds no duplicate messages, facts or findings
- [ ] Reports what it did — messages read, skipped by the pre-filter, facts extracted, findings raised —
      because a backfill that silently half-worked looks identical to one that worked

## Worker — runtime loop

**`apps/worker/src/main.ts` currently runs migrations, starts the HTTP server, and stops.** Everything in
the worker sections above is reachable only from tests until this section is done. It is listed separately
rather than folded into those sections so that the distinction cannot be lost by skimming ticks.

- [ ] `seedAppSettings` called at startup — nothing calls it yet, and every hydration path reads
      `app_settings` for the chat id, org name and timezone
- [ ] `IntakeLoop` started, with all four handlers wired: `applyMembershipEvent` **plus**
      `briefOnMembership(deps)` for `chat_member`; `handleBotMembershipEvent` for `my_chat_member`, with its
      introduction going through the `OutboundQueue`; `applyEditConsequences` for `edited_message`; and
      `dispositionOfReply` for `onQuestionToBot`
- [ ] The tick, in order: `runIngestPass` → `runSweepPass` → `runRespondPass` → `runAskPass`. The order
      is not arbitrary — a finding must exist before it can be asked about, and answering reads the
      register the ingest pass just wrote
- [ ] `runRespondPass` deliberately **outside** the pipeline advisory lock. It derives nothing and
      supersedes nothing, so it cannot race the order-dependent work, and holding the lock would make a
      group question wait behind a backfill — the one delay anybody notices during a demo
- [ ] Exponential backoff and a cap on consecutive failures. **An unattended crash-loop is the cheapest way
      to spend real money here**, since every tick can invoke a model
- [ ] `queue.drain()` on shutdown, so a queued outbound message is not lost on redeploy
- [ ] Health check stays green while a tick is running and goes red only when the database is unreachable —
      otherwise Coolify restarts the container mid-pipeline
- [ ] Observed working: the worker container starts against live Postgres, polls, processes, and writes a
      `runs` row per tick. **This is the item that converts every test-proved tick above into a
      deployment-proved one**

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
| F12 Alias matching, model only on ambiguity | **Complete** — schema, core and agent all done | — |
| F11 Noise as a first-class outcome | Prompt and schema done | The golden message set is a manual run and needs **G1/G2** |
| F16 Severity from the Assessor, confidence separate | Both produced, on separate axes | **Done** — worker writes the two columns |
| F17 Aggregation and suppression over SQL candidates | Judgment implemented | **Done** — the five detection queries exist and feed it candidates |
| F18 Restraint on three paths, gated per output class | Gate, scoping and quiet-decision records done and asserted | Worker persists `quiet_decisions` from all three scopes; **web still renders the strip** |
| F20 Answer with provenance and age | Four branches, age recomputed from the register | **Done** — worker detects the question and sends the reply |
| F21 Questions targeted by sensitivity | Respondent proposes the target | **Done** — worker writes `questions`, enforces the budget, and routes. Note the worker *overrides* the proposed target for `ambiguous_holder`, always privately |
| F23 Brief, three fixed sections, join and leave | Both variants, including the empty case | **Done** — worker fires it from a `chat_member` event |
| F25 Line-level brief records with evidence | Lines emitted with their own evidence refs | Worker writes `brief_lines` and they are assignable in the store; **web still surfaces them** |

**F7, F12, F16, F17, F20, F21 and F23 are now closed outright.** F18 and F25 have only their web half
outstanding. F11 waits on `G1`/`G2`. `[F13]` and `[F15]` are the worker's and are now complete in the
persistence and derivation section above.

`[F32]` interrupt raising and `[F33]` pending changes staying out of findings belong to the Approval round
trip below. **`[F33]` is now closed on all three routes.** `[F32]` has its whole worker half built — a
returned interrupt is stored, asked, answered and resumed — but **nothing in the agent raises an interrupt
yet**, so that entrance is still unreachable, and `G5` has not proved a snapshot survives a real round
trip either.

## Approval round trip

**There are two entrances to this gate, and the design's step-by-step describes only the second.** Missing
the first is the easiest way to build half this feature:

1. **The worker's own consequence gate.** `decideFactStatus` classifies consequence deterministically from
   asset kind and sensitivity, and writes a high-consequence weak claim as `pending_approval` with
   `requiresApproval` set. There is no interrupt, no snapshot and nothing to resume. This is the path the
   seeded demo exercises `[F31]`, and **nothing consumed `requiresApproval` until this work** — it was a
   dead flag.
2. **An agent interrupt.** `stopReason: "interrupt"` plus a snapshot, stored in `agent_sessions` and
   resumed later `[F32]`.

Both write a `pending_changes` row and an approval `questions` row, and both resolve through
`answerApproval`. The only difference at resolution is whether a session exists — which is why
`pending_changes.agent_session_id` is nullable.

- [ ] Interrupt raised via `event.interrupt({ name, reason })` — **agent side, still not done.** The
      worker's half below is built and tested against a fake interrupting agent, so this is the one seam
      that closes entrance 2
- [x] Interrupt returned to the worker with `stopReason` and the interrupts array — consumed by
      `recordInterrupts`. **One session is stored for the whole response**, not one per interrupt: the
      snapshot is the graph's state and there is one graph, so a resume carries every answer at once,
      which is what an `interruptResponses` array is for
- [x] Worker writes `questions` + `pending_changes` + snapshot
- [~] Approval message names all four things: action, uncertainty, evidence, effect of refusal `[F32]` —
      action, uncertainty (the `decideFactStatus` reason, verbatim) and the effect of refusal are all
      explicit. **Evidence appears only as the quoted claim**, not as a separate excerpt. Closing this is a
      change to `approvalText` alone
- [x] Routing by `assets.sensitivity` — group, or coordinator privately. High consequence goes privately:
      an approval about who controls the money, asked in front of twenty people, hands the group the very
      authority the gate exists to withhold
- [x] Pending changes excluded from every finding and every brief `[F33]` — enforced on three separate
      routes and asserted on each: the detection queries, the respond fact index, and the brief holdings
      join. The third is the one nobody would think to check
- [x] Never adopted on timeout; never discarded `[F33]` — holds **by construction**: no expiry path
      exists anywhere, so there is no code that could adopt or drop one. Recorded as an absence
      deliberately, because a future timeout sweep would silently break it
- [x] **Answerer identity checked** — approvals resolve only for the coordinator `[F34]`. A volunteer's
      "yes" is `not_permitted` and changes **nothing**; treating it as a rejection was rejected, because
      then anyone could veto
- [x] Verification and clarification accept any group member's answer `[F34]` — `dispositionOfReply`.
      These are questions of fact and the group is the authority on its own facts, unlike an approval,
      which is a question of authority
- [~] Ambiguous reply → ask once more, then route to the coordinator and stop asking the group — **only
      the safe half is built.** An unreadable reply returns `unclear` and leaves the question open, which
      is correct as far as it goes: a silently declined approval is indistinguishable from one nobody
      answered, so the coordinator would never learn their reply was discarded. The **escalation** — re-ask
      once, then switch the target and stop asking the group — is not implemented, and needs a
      `clarification_attempts` counter that `questions` does not currently have, so it means a fifth
      migration
- [x] `resume` task restores the snapshot and passes `interruptResponse` blocks — `resumeSession`
      validates the result against the **original node's** schema, not the wrapped task result, because
      `resume` returns the node's own output. **Documented consequence: a resumed output carries no quiet
      decisions and has not been through Restraint a second time.** Unproven end to end until `G5`
- [x] Second approval on the same asset queues behind the first — stored `pending` with **no** question,
      and promoted when the first resolves. The queue-behind check is scoped to the **asset**, not the
      fact, because two proposals about who controls the bank account conflict even when they concern
      different claims about it. Asking both in parallel was rejected: two answers could contradict and the
      second would silently win. `promoteNextForAsset` is the other half of this — without it the second
      proposal sits forever with nothing asking about it, which is worse than asking both
- [x] Answer arriving after its pending change was superseded resolves as obsolete — and staleness is
      checked **before** authority, so a volunteer's reply to a question that was already moot reports
      `obsolete` rather than `not_permitted`. An answer arriving after the claim was superseded is not a
      late yes
- [ ] Fallback rung recorded, if G5 forced one — nothing to record until `G5` runs

Approve stamps the fact `active` with `verified_at`, because "a human agreed to this, on this day" is the
strongest provenance the register has. **Reject writes `unverified`, not `retired`** — retired means an
arrangement the register once held has ended, which would be a lie about something never recorded.
`unverified` says plainly that Baton was told this and does not believe it: invisible to every detection
query, still readable in the fact detail, and re-askable if the group says it again.

`COORDINATOR_TELEGRAM_ID` parses as a **comma-separated list**. `app_settings.coordinator_person_id`
remains the primary authority and the one coordinator the UI names; the list is a second-operator escape
hatch, so a single-id column cannot lock out the other operator. It is not a widening of who may approve —
everyone on it is named in the environment.

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
      drift. **The normaliser now exists** in `packages/core`, with a seed adapter beside the Telegram
      one, so the remaining work is `scripts/backfill.ts` consuming the artifact through it — see
      **Worker — backfill** above
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

- [x] Pre-filter — table-driven over a labelled corpus, scored on **recall**. Recall floor asserted at
      1.0 over the must-keep set, with keep-rate reported and loosely bounded — enough to fail a
      degenerate filter that keeps everything, not tight enough to tempt anyone into trading recall for it.
      **Honest limitation stated in the file:** the corpus is hand-labelled, so a passing score proves the
      rules match this author's expectations, not a real group's chatter. Its value is as a regression guard
- [~] Schema conformance — every Zod schema against recorded responses, including malformed ones. 26
      cases in `packages/core/test/agent-schemas.test.ts` cover all six schemas and every malformed
      branch the design names — suppression with no reason, a withholding with no reason, an empty brief
      that does not say so, a stale answer with no age, an ambiguous holder with one candidate. The
      retry path they are meant to prove now exists (`apps/agent/src/model/structured.ts`) and its
      JSON-extraction seam is tested directly, but the loop itself is still exercised against
      hand-written fixtures: **real recorded model responses wait on G2**
- [x] Detection SQL — five queries against fixtures with known answers, run against live Postgres
- [x] Detection SQL — `unverified` and `pending_approval` rows never appear. Asserted per query, and
      separately on the respond fact index and the brief holdings join
- [x] Fact matching — restatement bumps without inserting; contradiction inserts and links
- [x] Dedupe — two consecutive sweeps produce one finding
- [x] Dismissal — a dismissed finding never returns — and the second sweep never sends it to the Assessor
      either, so a dismissal saves the model call as well as the row
- [x] Ordering — a contradiction applied forwards and backwards reaches the same state. The two orders are
      computed independently and compared, rather than one being spot-checked
- [x] Approval round trip — interrupt, snapshot, restore, resume, apply. Against a fake interrupting
      agent; the real round trip waits on `G5`
- [x] Approval round trip — rejected path, asserting `unverified` rather than `retired`
- [x] Approval round trip — answer from a non-coordinator does not resolve, and changes nothing
- [x] Ask budget — a third simultaneous ask queues rather than sending `[F36]`
- [x] Ask budget — a fourth ask inside 24 hours queues `[F36]`
- [x] Ask budget — an approval raised while the budget is full of verifications is asked before them `[F36]`
- [x] Ask budget — a queued ask is neither dropped nor duplicated `[F36]`
- [x] Restraint scope — hook registered on `assess`, `brief` **and** `respond`, asserted directly `[F18]`
      — `apps/agent/test/restraint-scope.test.ts` asserts the wiring set is exactly those three and that
      `ingest` is absent; `apps/agent/test/gate.test.ts` asserts a withholding produces a quiet decision
      from each of the three scopes, that an unjudged item is withheld rather than surfaced, and that a
      settled finding is never re-sent to the model
- [x] Restraint scope — a withheld brief line and a withheld answer each write a `quiet_decisions` row
      `[F18]`, now asserted on the **worker** side too: the brief test checks that `scope='brief_line'` is
      written while the finding and answer scopes stay at zero, so the veto cannot have quietly narrowed to
      findings. A brief whose every line was withheld stores as an empty brief rather than as nothing
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
- [x] **Integration harness against a real server** — a separate `baton_test` database, truncated between
      tests. `fileParallelism: false` in `packages/core` and `apps/worker` because both suites share that
      database, and in `apps/agent` because the Strands SDK exhausts memory otherwise
- [x] Intake persistence — the unique constraint on `(chat_id, telegram_message_id)` proved by a
      redelivery, forwarded and media flags, reply pointers
- [x] Edits — an edit resets curation, supersedes rather than mutates, and an identical-text redelivery
      does not re-curate
- [x] Lifecycle — a `chat_member` join and leave each record an event, and a status change that is neither
      does not
- [x] Outbound queue — the rate limit observed, and every outbound path going through it
- [x] Question detection — 17 cases, weighted toward the negatives; plus an edit that adds or removes an
      @-mention flipping the flag, and a text change clearing `question_answered_at`
- [x] Respond — the four Respondent branches, `withheld` sending nothing, an `unknown` queueing a
      follow-up through the ask budget rather than sending directly, and answering being idempotent
- [x] Briefs — departure and arrival scoping, the empty brief, one brief per transition, and **the
      membership event firing a brief end to end**: a real `IntakeLoop`, a real `chat_member` update, and a
      `briefs` row afterwards with no button pressed. That seam *is* the feature, and it is the failure that
      looks fine until the demo
- [ ] Golden message set with expected classifications, run manually

## Deployment

### Images — build locally before deploying anything

**No longer blocked.** The Docker daemon runs on the development machine, so the earlier note that the
compose files could only be validated by `docker compose config` no longer applies. Postgres is up and
serving; no application image has been built yet. Multi-stage pnpm-workspace builds are where small
mistakes hide, so these precede any deploy attempt.

- [ ] `docker build -f apps/agent/Dockerfile .` succeeds
- [ ] `docker build -f apps/worker/Dockerfile .` succeeds
- [ ] `docker build -f apps/web/Dockerfile .` succeeds — the standalone trace must include
      `packages/core`, or the image starts and fails on first import. **Known blocker:** `pnpm build` for
      `apps/web` currently fails on the host with an `EPERM` symlink error during the Next standalone copy.
      Confirmed pre-existing and unrelated to the worker work (reproduced with the worker changes stashed);
      the Linux image build may not hit it, but it must be checked rather than assumed
- [ ] Web build peak memory recorded, and compared against the VM's free memory
- [x] `docker compose -f docker-compose.dev.yml up -d` brings Postgres up healthy — Postgres 17.10 on
      `127.0.0.1:5433`, hosting both `baton` and `baton_test`, and every worker integration test runs
      against it
- [ ] Worker container starts, runs migrations, and answers `/health` with 200 — migrations and `/health`
      are both proved on the host; the container has not been built

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
