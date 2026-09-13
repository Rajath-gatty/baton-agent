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

**Status — 2026-09-13.** 34 done · 1 partial · 292 pending, of 327.

Repository and tooling complete and verified: `pnpm typecheck` passes on all five workspaces, `pnpm lint`
is clean, `pnpm format` conforms, and 34 tests pass (23 in core, 11 in worker). Two guarantees that the
checklist previously left to inspection are now automated — the no-database-client rule in `apps/agent` by
ESLint, and the no-attendance-table / no-scoring-column rule by Drizzle introspection.

Two things are explicitly **not** done and should not be inferred from the above. Every Phase 0 gate is
unproven, which is the next work. And no container image has been built — the Docker daemon was
unavailable at initialization, so the compose files are validated by `docker compose config` only and all
three Dockerfiles remain untested.

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

- [~] Drizzle schema for every table (see next section) — pgEnums defined from the shared constants;
      table definitions remain
- [ ] Zod schema: Curator output — five-way classification plus extracted records, **flat**
- [ ] Zod schema: Cartographer output — attributions, resolved identity, `cannot_determine` branch
- [ ] Zod schema: Assessor output — subtype, severity, confidence, reasoning, suppression flag
- [ ] Zod schema: Restraint output — surface or withhold, with reason
- [ ] Zod schema: Briefer output — three sections as line-level records, each with evidence refs
- [ ] Zod schema: Respondent output — separate branches for answer, stale answer, ambiguous, unknown
- [x] Zod schema: agent request envelope (`task`, payload, hydrated context)
- [x] Zod schema: agent response envelope including the `trace` array
- [x] Prompt files, each carrying a `prompt_version` constant — versions and the observation constraint
      in place; the prompt bodies themselves land with each agent
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

- [ ] `people` — telegram user id **nullable**, display name, status, joined/left timestamps
- [ ] `person_aliases` — alias, kind; alias **not unique** (ambiguity must be representable) `[F12]`
- [ ] `messages` — source, sender, sent-at, text, reply-to, flags, `content_hash`
- [ ] `messages` unique constraint on `(chat_id, telegram_message_id)`
- [ ] `messages.prefilter_verdict` **and** `prefilter_version` `[F6]`
- [ ] `messages.curated_at`
- [ ] `messages` flags: forwarded, edited, withdrawn, unprocessed `[F4]` `[F5]`
- [ ] `curator_cache` keyed on `content_hash` + `prompt_version`
- [ ] `assets` — six kinds, name, normalised key, `sensitivity`
- [ ] `facts` — claim, confidence, source message, stated-by/at, `last_confirmed_at`, status, sensitivity
- [ ] `facts.supersedes_fact_id` `[F8]`
- [ ] `facts.match_key` — **without this the register fills with active near-duplicates** `[F8]`
- [ ] `facts.curator_reasoning` — shown in the fact detail panel `[F27]`
- [ ] `holdings` — asset, holder **nullable**, `holder_external`, `is_personal_resource`
- [ ] `holdings.acquired_at` / `released_at`, append-only, never overwritten `[F13]`
- [ ] `commitments` — substance, owner **nullable**, promised-at, deadline **nullable**, evidence, status
- [ ] `commitments.asked_once_at` — ask-once-then-stop enforced in data, not in prompt
- [ ] `capabilities`
- [ ] `capability_coverage` `[F14]`
- [ ] `findings` — type, subtype, title, why-it-matters, severity, confidence, evidence, status
- [ ] `findings.dedupe_key` — **without this every sweep duplicates or resurrects** `[F19]`
- [ ] `findings` first-seen / last-seen, dismissal reason, `assessor_reasoning`
- [ ] `quiet_decisions` — what, why, which run `[F18]`
- [ ] `questions` — kind, target, asked text, bot's telegram message id, answer, resolution
- [ ] `questions.status` includes a `queued` state, and `asked_at` is **nullable** — a default of
      insertion time makes the rolling window count questions never sent `[F36]`
- [ ] `questions.interrupt_id` and `interrupt_name` `[F32]`
- [ ] `pending_changes` — proposed write, consequence, status `[F31]` `[F33]`
- [ ] `agent_sessions` — task, Strands session id, serialised snapshot
- [ ] `runs` — messages read, candidates, extracted, **skipped**, findings, JSONB `trace` `[F28]`
- [ ] `briefs` and `brief_lines` — lines as rows, assignable, each with evidence refs `[F25]`
- [ ] `coordinator_state` — single row, `last_seen_at`
- [ ] `app_settings` — chat id, org name, timezone, `coordinator_person_id`
- [ ] Indexes: `messages(prefilter_verdict, curated_at)`, `facts(asset_id, status)`,
      `holdings(asset_id, status)`, `findings(status, severity desc)`,
      `curator_cache(content_hash, prompt_version)`
- [ ] Migrations run from `packages/core` on worker start

**Structural guarantees — verify by inspection, not by intent:**

- [x] No attendance table exists anywhere — enforced by test, not inspection: Drizzle table
      introspection in `packages/core/test/privacy-guarantees.test.ts`
- [x] No per-person score column exists anywhere — no completion rate, reliability figure, or activity
      metric. Same test, which is vacuous while the schema has no tables and load-bearing the moment one
      is added.

## Worker — Telegram

- [ ] Long-poll loop against `getUpdates` with committed offset
- [ ] `allowed_updates` set to `["message", "edited_message", "chat_member", "my_chat_member"]`
- [ ] Normaliser producing one internal message shape `[F1]`
- [ ] Messages from an unrecognised chat id ignored
- [ ] **Bot's own messages dropped at intake** `[F35]`
- [ ] Forwarded messages attributed to the forwarder and flagged `[F4]`
- [ ] `edited_message` resets `curated_at` and `prefilter_verdict`, triggers re-curation `[F4]`
- [ ] Re-curation after an edit supersedes prior facts rather than mutating them `[F4]`
- [ ] Non-text media logged with `unprocessed` `[F5]`
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

- [ ] Deterministic heuristics, recall-biased `[F6]`
- [ ] Verdict and `prefilter_version` written for every message, kept and discarded alike
- [ ] Re-evaluation path for previously discarded messages when the version changes
- [ ] Skipped count exposed to `runs` `[F28]`

## Worker — persistence and derivation

- [ ] Intake loop and processing loop are **separate** — curation never blocks polling
- [ ] Strict `sent_at` ordering through the processing loop
- [ ] Postgres advisory lock so only one pipeline task runs at a time
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
- [x] Dispatch on `task`: `ingest`, `assess`, `brief`, `respond`, `resume` — five branches wired, handlers
      return a well-formed error envelope until each agent lands
- [x] Per-agent model configuration from environment variables
- [ ] Zod validation of every model response, with retry feeding the validation error back
- [ ] Trace assembled and returned in the response payload — nodes, model, tokens, tool calls, reasoning
- [ ] Strands tools wired to the worker's data API
- [x] Dockerfile, Node 22+
- [x] No database client anywhere in this workspace — verify by dependency inspection. Declared deps are
      `@baton/core`, `express`, `zod` only, and ESLint fails on any DB import (verified by probe)

## Agent — the six agents

- [ ] **Curator** — five-way classification, multiple records per message, noise as a first-class
      outcome `[F7]`
- [ ] Curator rejects conditionals, hypotheticals and jokes `[F11]`
- [ ] Curator prompt forbids cross-message inference, so per-message caching stays sound
- [ ] **Cartographer** — deterministic alias matching first `[F12]`
- [ ] Cartographer model call only on ambiguity, with `cannot_determine` permitted
- [ ] **Assessor** — severity over consequence, reversibility, urgency; confidence separate `[F16]`
- [ ] Assessor aggregates by capability area `[F17]`
- [ ] Assessor suppresses below an evidence threshold `[F17]`
- [ ] Assessor phrases every finding about a capability, never a person
- [ ] **Restraint** attached via `addHook`, not as a graph node `[F18]`
- [ ] Restraint hook registered on **all three producing tasks** — `assess`, `brief`, `respond` `[F18]`
- [ ] Gating per output class: findings only when `dedupe_key` is new or severity changed; **every** brief
      line and **every** answer, unconditionally `[F18]`
- [ ] Restraint withholding writes a `quiet_decisions` row with reasoning — from any of the three paths `[F18]`
- [ ] Restraint reasoning is item-level or organisation-level, never about a person
- [ ] **Briefer** — three fixed sections `[F23]`
- [ ] Briefer emits line-level records with evidence refs, not prose blocks `[F25]`
- [ ] Briefer handles the empty case with a plain sentence
- [ ] Briefer arrival variant, same sections, scoped to unowned and single-held items `[F23]`
- [ ] **Respondent** — answer with provenance and age `[F20]`
- [ ] Respondent stale-answer branch, with the age stated
- [ ] Respondent unknown branch, becoming a question `[F21]`
- [ ] Respondent ambiguous-holder branch, routed privately `[F21]`
- [ ] `ingest` graph: Curator → Cartographer — the one task with no Restraint hook, as it produces no text
- [ ] `assess` graph: Assessor with Restraint hooked
- [ ] `brief` task: Briefer with Restraint hooked on produce
- [ ] `respond` task: Respondent with Restraint hooked on produce
- [ ] Observation constraint honoured in every prompt: *seen doing*, never *can do*

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

- [ ] `seed-plan.ts` produces the deterministic plan — roster of twenty with alias forms, six-month event
      calendar, asset inventory across all six kinds, capability areas, and a placement for every coverage
      row below
- [ ] Plan output committed as a fixture, so a regenerated transcript exercises the same paths
- [ ] `seed-transcript.ts` renders prose against the plan, in day-sized chunks
- [ ] **Six-month** transcript, twenty people, ~4,500 messages, reads as genuinely human
- [ ] Enters through the same normaliser as live traffic, `source = 'seed'` `[F2]`
- [ ] Currency INR, copy readable internationally
- [ ] Two-month slice available for development, full six months for the final pass
- [ ] **Coverage report emitted after render, keyed to the rows below, exiting non-zero on any unmatched
      row** — a warning is not sufficient, because a transcript missing a path looks fine `[F2]`
- [ ] Rows the scanner cannot pattern-match reported as *asserted by plan*, traceable to their placement
- [ ] **Seed people bound to real Telegram user ids** for every account used on camera, asserted by the
      script — the leaver must be the seeded owner of the donation page or the opening case does not fire

### Planted cases — the demo spine

- [ ] The orphan — donation page owner is the volunteer who leaves on camera
- [ ] The restraint — four-day-old undated promise, nothing blocked on it
- [ ] The stale answer — sterilisation rate, five months old
- [ ] The provenance click — a brief line traceable to a five-month-old message
- [ ] The approval — one ambiguous message about financial control changing hands
- [ ] Cases woven through the transcript, not appended

### Coverage rows — every behaviour path has material

One item per row of the coverage table in the design document. A path with no material cannot be
demonstrated and has almost certainly never been tested.

- [ ] Durable fact — a settlement arrangement, a number printed on something, a named account holder
- [ ] Commitment — one dated promise and one undated intention
- [ ] Participation evidence — post-event thanks naming several people, more than once `[F14]`
- [ ] Lifecycle — one departure and one arrival inside the seeded window, before the live one `[F3]`
- [ ] Noise — jokes, agreement fragments, logistics chatter, a conditional about something that does not
      exist `[F11]`
- [ ] Pre-filter recall — a durable fact buried in an otherwise chatty message `[F6]`
- [ ] Multiple records per message — one message carrying both a fact and a commitment `[F7]`
- [ ] Restatement — the same fact stated again months later, in different words `[F8]`
- [ ] Contradiction — a fact replaced by a later one, the clinic's terms change `[F8]`
- [ ] Negation — an arrangement explicitly ended `[F8]`
- [ ] Hearsay — someone relaying what a third party said `[F9]`
- [ ] Relative dates — "next Tuesday", "end of the month", "last week" `[F10]`
- [ ] Identity — every alias kind: handle, display name, nickname, first name, role reference `[F12]`
- [ ] Ambiguity — one first name resolving to two different people `[F12]`
- [ ] Six asset kinds — at least one each: login, physical item, financial control, relationship,
      document, public presence `[F13]`
- [ ] Transfer of holding — one asset changing hands, so holdings history carries a closed row `[F13]`
- [ ] Personal resource — an asset that is actually someone's own property, the van `[F15]`
- [ ] Commitment closure — a promise later evidenced as done
- [ ] Capability coverage — one capability with several observed participants, one with exactly one `[F14]`
- [ ] Aggregation — three separate exposures inside a single capability area `[F17]`
- [ ] Suppression — a candidate finding resting on one throwaway mention `[F17]`
- [ ] Answerable question — an operational figure the coordinator is visibly asked more than once `[F20]`
- [ ] Unknown — a question the transcript deliberately never answers `[F21]`
- [ ] Credential exposure — a credential-shaped string pasted into the group `[F30]`
- [ ] Media — a voice note and an image `[F5]`
- [ ] Provenance edge cases — one forwarded message and one later edited `[F4]`

## Tests

- [ ] Pre-filter — table-driven over a labelled corpus, scored on **recall**
- [ ] Schema conformance — every Zod schema against recorded responses, including malformed ones
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
- [ ] Restraint scope — hook registered on `assess`, `brief` **and** `respond`, asserted directly `[F18]`
- [ ] Restraint scope — a withheld brief line and a withheld answer each write a `quiet_decisions` row `[F18]`
- [ ] Seed coverage — every coverage row matched or asserted by plan; a mutilated plan exits non-zero `[F2]`
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
- [ ] Two-month slice loaded locally; full six months only on the deployed environment
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
