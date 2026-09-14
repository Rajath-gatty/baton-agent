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

**Status — 2026-09-14 (fourth revision, re-verified).** 298 done · 17 partial · 69 pending, of 384.

Those four numbers are **counted from this file**, not maintained by hand:

```
grep -c '^- \[x\]'  # done      298
grep -c '^- \[~\]'  # partial    17
grep -c '^- \[ \]'  # pending    69
```

**Re-verified against the working tree, 2026-09-14 (later the same day). Nothing moved, and that is the
finding.** Every pending and partial item whose state is decidable from the repository was checked against
the code rather than against this document, and each one is still where it says it is: `AgentCoreTransport`
still rejects with *"not implemented yet"*; `smoke/g2-structured.ts` is still absent while
`apps/agent/package.json` still declares `smoke:g2`; `scripts/backfill.ts` still ends after intake with no
`openRun`, `runIngestPass` or `runSweepPass` call anywhere in `scripts/`; no `event.interrupt` call exists
in `apps/agent/src` — `NodeInterruptedError` only *catches* an interrupt the agent returns; `keepRate` is
asserted in exactly one place, `packages/core/test/prefilter.test.ts` at `< 0.75` over the 36-message
corpus, and nowhere against the rendered transcript; `questions` still has no `clarification_attempts`
column and `packages/core/drizzle` still holds four migrations, so the fifth is still owed;
`approvalText(claim, reason)` still carries no evidence excerpt; `matchApprovalReply` still refuses rather
than widening; `transport.close()` still appears once, in `main.ts` shutdown, never per task;
`apps/web/src/app/actions.ts` is still `SEAM:` comments; `reset-demo.ts` still prints *"not
implemented"*; no Dockerfile and no compose service pins `linux/arm64`; `ARCHITECTURE.md` does not exist
and `README.md` is still the one-line tagline; and none of the four Tier 2 items has any code. The
`.env.example` drift is unchanged — it still documents `5433` while `docker-compose.dev.yml` publishes
`5432:5432`. Nothing was ticked and nothing regressed. One marker moved, and only downward in strength:
the root-build-context item under **The VM — Coolify** is now `[~]` rather than `[ ]`, because
`docker-compose.yml` does declare `context: .` for both buildable services and the agent image was built
that way — which is why the counts read 17 partial and 69 pending rather than 16 and 70.

**Three things this pass learned that were not in the document.** `apps/web/.next/standalone` is absent
after the most recent host build, which reached *"Collecting build traces"* and stopped there — so the
`EPERM` blocker below is unchanged rather than quietly fixed, and the Linux image build is still the only
way to settle it. The Docker daemon is **not currently reachable** (`open //./pipe/dockerDesktopLinuxEngine:
The system cannot find the file specified`), so the three image items cannot be attempted at all right now;
the *"no longer blocked"* note under **Images** holds only while Docker Desktop is actually running, which
is a weaker statement than it reads as. And the most recent full `pnpm test` run left in the working tree
reports **worker 500 of 504**, four failures across `brief`, `detection` and `processing-loop`, every one a
foreign-key violation on a row whose parent had vanished — the exact signature of the cross-run
`baton_test` collision already diagnosed below, not a new fault. It is recorded because the "893 tests
pass" line above is only true of a clean serial run, and nothing in this repository enforces one.

**This revision is the web app's, and it adds no items — it ticks twenty-nine.** The admin UI is built,
it is one page, and every item in its section was observed in a browser at a stated viewport with the
console clean. Three land as `[~]` rather than `[x]` because their write seam does not persist yet, and
they say so.

**Two things this document previously implied were false, and neither could have been caught by reading
the code.** Route protection did not exist: `middleware.ts` sat one directory above where Next looks in a
`src/` app, so `GET /` served the entire register — findings, holders, quoted messages — to a request
with no cookie, silently, with nothing logged. And credential redaction was running in the browser, which
means the literal credential travelled in the page payload and was called redacted because it was never
painted. Both are fixed, both are now proved by observation, and both are recorded in full under
**Web — admin UI** rather than quietly corrected — because "the code exists" is precisely the evidence
that had them looking fine.

The count grew from 376 to 384 in the previous revision because it added eight items rather than only
ticking them: the `TELEGRAM_CHAT_ID` validation, the three new test files, and four properties of the
runtime loop that were implicit in the design and are now asserted — two loops rather than one, no
`setInterval`, the administrator check at startup, and the foreign-chat guard on `my_chat_member`.

The count grew from 364 to 376 because this revision added eleven items rather than only ticking them —
the `./env` subpath, the deleted intake orphans, the build-before-test guard, the `.dockerignore`, the
planted-material recall test, the agent-configuration test, the missing keep-rate guard, the two `arm64`
build requirements, and the two local setup steps under **Environments** whose absence had gone
unrecorded. Each is a thing that broke, or that stops something breaking again.

The item count grew from 329 to 364 in the first revision for the same reason: the
normalisation primitives and the three new schema objects that the worker needed, and two new
sections — **Worker — backfill** and **Worker — runtime loop** — for work that the previous revision had
folded invisibly into other sections. Splitting them out is the point: the runtime loop being unwired is
the single most misleading thing about the tick counts above, and it deserved its own heading rather than a
footnote.

`packages/core`, the database schema, seed data generation, **the agent container with all six
agents**, and **the worker's intake, derivation, detection, orchestration and approval halves** are
complete. `pnpm typecheck` passes on all five workspaces, `pnpm lint` is clean, `pnpm format` is clean,
`pnpm build` succeeds for core, worker and agent, and **893 tests pass** (265 in core, 504 in worker, 58
in the agent, 66 in scripts).

**Correction, measured 2026-09-14: the agent figure above is stale, and the total with it.** The agent
suite is **127** tests across 10 files, not 58 — the six test files added later the same day
(`agents`, `config`, `resume`, `server`, `structured`, `tools`) are not in that number.
`pnpm --filter @baton/agent test` reports 127 passing in 10 files, and `pnpm --filter @baton/scripts test`
reports 66, so the total is **962** rather than 893. Core and worker were not re-measured — the Docker
daemon was down — so those two figures still rest on the earlier run, with the flake caveat below.

**One flake, diagnosed rather than ignored.** A worker run reported 67 failures across four files once,
then passed 504/504 twice consecutively. The cause was two suites running at the same time against the
shared `baton_test` database — an earlier run had been interrupted and was still truncating tables when the
next began. `fileParallelism: false` serialises files *within* a run and nothing guards *across* runs, so
two concurrent invocations will always corrupt each other. Not worth building a lock for a single
developer, but worth knowing: a burst of unrelated-looking failures across several worker files means check
for a second running suite before believing them.

**Those test numbers were measured, and the previous revision's were not.** It claimed 797 (254 core, 476
worker, 45 agent, 22 scripts); the core figure omitted `env.test.ts` and the scripts figure omitted
`prefilter-recall.test.ts` entirely. More importantly, the suite could not run at all on a fresh checkout:
`TEST_DATABASE_URL` was absent from `.env`, so `db/testing.ts` refused to start, `packages/core` failed one
suite, and pnpm's recursive run aborted **before `apps/worker` executed**. The 476 worker tests — the
entire evidence base for the worker ticks below — were unverified when they were written down. They have
now been run and they all pass. See **Environments** for the setup step whose absence caused this.

One whole-repository command still does **not** pass. `pnpm build` fails for `apps/web` — but the
failure has moved twice and only the last of the three is left. It was an `EPERM` symlink error in the
Next standalone copy step; then, once `packages/core/dist` was rebuilt and stopped serving a stale API, a
webpack `UnhandledSchemeError` on `node:crypto` appeared *earlier* in the same build, reached from a
`use client` component through the core barrel. That one is fixed (see **Web — admin UI**), and
`next build` now compiles and generates every static page. What remains is the original `EPERM`, raised
while symlinking `node_modules` into `.next/standalone` — a Windows privilege for creating symlinks, not
a code fault, and the reason the Linux image build must be checked rather than assumed. `pnpm format` is
clean and `pnpm lint` is clean.

**The worker is now proved against live Postgres, not against generated SQL.** Docker runs on the
development machine, `docker-compose.dev.yml` brings up Postgres 17 on `127.0.0.1:5432`, and all four
migrations are applied to two databases — `baton` and a separate `baton_test`, both verified at 21 tables
against `information_schema`. Every worker item ticked below is proved by an integration test that executed
real SQL against that server. This is the single largest change since the last revision: the previous
status recorded that no migration had ever been applied, and that is no longer true.

**Unresolved port drift.** `.env.example` documents `5433` and explains that
`docker-compose.dev.yml` publishes `127.0.0.1:5433:5432` so a local Postgres already on 5432 cannot be
connected to by accident. The compose file publishes **5432**, so the comment describes a file that does
not say that, and the stated protection does not exist. The running database is on 5432 and this document
now records that. Deciding which one moves is a real choice and belongs in code, not here: the intent
behind 5433 is sound, so moving compose is the likelier fix.

**The worker is now a running service, not a library with a health check.**
`apps/worker/src/main.ts` runs migrations, starts the HTTP server, and then starts
`startWorkerRuntime` — which seeds `app_settings`, resolves the bot's identity, checks that
Baton is a group administrator, and runs two independent loops: intake polling and
persisting, and a tick deriving, answering and asking. Shutdown stops both loops and
drains the outbound queue. Every previously ticked worker behaviour is now reachable from
a running process rather than only from a test, and the wiring itself is test-proved by
`apps/worker/test/runtime.test.ts` — including a membership event firing a brief with no
button pressed, through a real `IntakeLoop`.

**Still not container-proved.** No worker image has been built or run, so "the worker
starts against live Postgres and polls" is proved with a fake Telegram and a fake
transport, not with a container and a bot. That distinction is kept on the last item of
**Worker — runtime loop**.

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

Three things are explicitly **not** done and should not be inferred from the above. **Every Phase 0 gate is
still unproven**, and **no model call has completed** — the six agents and every worker pass that invokes
them are wired, typechecked and tested against fake transports, but nothing here has yet had a model
answer it. Consequently `G1`, `G2`, `G4`, `G5` and `G6` bound what the tests below can claim: no AgentCore
invocation, no real interrupt, and no Telegram bot in a real group. **No container image has been
deployed** — the agent image builds and runs locally, no worker or web image has been built, and nothing is
on AWS. **Nothing has been curated**: intake is stage one of backfill, and stage two — candidates to
`ingest` in batches of ten, then one `assess` pass — needs a working model call, so `facts`, `holdings`,
`findings` and every derived table are still empty.

What is no longer on that list: **the worker's runtime loop is wired**, so the pipeline runs on a schedule
rather than only under a test.

**The gate blocker is now a credential, not untried code.** `G1` was run on 2026-09-14 and the result
splits cleanly: Strands reaches a custom base URL correctly and surfaces the provider's error faithfully,
so that half is proved and the LiteLLM-proxy contingency is closed. But `https://agentrouter.org/v1`
rejects the configured `MODEL_API_KEY` with `unauthorized_client_error` on every route including
`GET /models` — diagnosed with the SDK out of the path, ruling out streaming, headers, user-agent and
host availability. Until a working key exists, or `MODEL_BASE_URL` is repointed at another
OpenAI-compatible provider, **`G1`, `G2` and `G7` cannot progress and neither can backfill stage two**.
That is a five-minute fix with the right credential and an indefinite block without one, which makes it
the single most schedule-critical item in this document. Full detail under **Phase 0 — Gates**.

What is no longer a caveat: the four `/data/*` routes are implemented and answer real queries, the
migration path is proved against a live server, the normaliser exists and is shared by both the Telegram
and the seed intake paths, and **the seeded transcript is in Postgres** — 1,753 messages of the two-month
slice, loaded by `pnpm backfill -- --chat-id 0` through that shared normaliser. A previous revision of this
paragraph claimed no seeded message had entered Postgres while the **Environments** section ticked the
opposite; the tick was right.

**A stale `packages/core/dist` silently serves the previous API, and it hid an incomplete refactor.** Core's
exports resolve to `dist`, not `src`, so a `dist` built before a rename does not error — it satisfies the
old import. When intake primitives moved from `core/src/intake/` up to `core/src/`, the barrels were updated
but two old files were left behind as unreachable orphans and the `scripts` workspace was never migrated.
Because `dist` was stale, `pnpm test` and `pnpm typecheck` both passed against the *old* compiled core while
`src` had moved on; rebuilding core turned `apps/agent` green and `scripts` red in the same command. The
orphans are deleted, `scripts` is migrated, and the root `test` script now runs
`pnpm --filter @baton/core build` first. Only core is built, not `pnpm build`, because the `apps/web`
standalone build fails with `EPERM` on Windows and would block the whole suite. **Any claim in this document
of the form "N tests pass" is meaningless unless core was built first.**

**Open calibration decision: the pre-filter keep rate is 73%, against a design target of roughly one in
five.** `pnpm backfill` over the two-month slice reports **1,287 candidates and 466 discarded** of 1,753.
The current `core/src/prefilter.ts` treats `TEMPORAL` and `substantial_length` as direct keep signals; an
earlier implementation deliberately demoted temporal to a supporting signal, and the test that recorded why
noted that promoting it *"took the keep rate to 81% against a design target of roughly one in five."* That
guard was lost when the pre-filter was rewritten, and re-promoting temporal cost roughly 1.8× the Curator
volume — about 3,200 calls across the full six months instead of 880. `packages/core/test/prefilter.test.ts`
cannot catch this: its `keepRate < 0.75` bound is measured over 36 hand-labelled messages, and 73% passes
under it. Resolution is either demoting the two signals again and bumping `PREFILTER_VERSION` — which is
precisely what marks the existing 1,753 verdicts for re-evaluation — or accepting the cost after `G7`
reports real Curator latency. **Not yet decided.** See the pre-filter items under **Tests**.

---

## Phase 0 — Gates

Nothing below this section is worth starting until these pass. Each one, failing, invalidates work
that follows it.

- [~] **G1.** Strands TS agent with the OpenAI-compatible provider pointed at the model's base URL —
      one agent, one call, locally. Records whether a custom base URL is accepted at all.
      **Run 2026-09-14 via `pnpm --filter @baton/agent smoke:g1`. The SDK half passes; the provider
      rejects the credential.**

      What is proved: `OpenAIModel` with `clientConfig.baseURL` targets a non-OpenAI host correctly. The
      request was constructed, sent to `https://agentrouter.org/v1`, answered in 5.8s, and the provider's
      error was surfaced faithfully as a `ModelError`. `loadConfig` and `buildModel` were exercised on the
      real shipping path rather than a bespoke construction, which is why the smoke script calls them.
      **The design's LiteLLM-behind-a-proxy fallback is therefore not needed for base-URL support** — that
      contingency can be considered closed.

      What blocks it: every authenticated request returns HTTP 401
      `{"type":"unauthorized_client_error","message":"UNAUTHENTICATED"}` — *"unauthorized client detected,
      contact support"*. Diagnosed with Strands entirely out of the path, by raw `fetch`, and the cause is
      **the credential, not the code**. Ruled out one at a time: it is not streaming (non-streaming fails
      identically), not the SDK (raw `fetch` fails identically), not client fingerprinting (a browser
      `User-Agent` changes nothing), not the header form (`x-api-key` fails identically), and not the host
      being down (`GET /` returns 200 and serves the Agent Router app). `GET /models` fails too, so the
      rejection happens in the auth layer before any model routing — which also means `DEFAULT_MODEL`
      (`gpt-5.6-sol`) is unverified: nothing has yet reached the point of resolving a model name.

      To clear it: a working key for that service, or repoint `MODEL_BASE_URL` and `MODEL_API_KEY` at
      another OpenAI-compatible provider. No code change is implied either way.
- [ ] **G2.** Structured output through that provider — one Zod schema, ten runs on a messy sample
      message. Record the conformance failure count; it sets how defensive the retry logic must be.
      **Blocked behind G1's credential**, and the smoke script does not exist yet — `package.json`
      declares `smoke:g2` pointing at `smoke/g2-structured.ts`, which is unwritten
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
- [x] **`.dockerignore` at the repository root.** A consequence of the line above: with the root as
      context, its absence means the context is the whole working tree. Four failures it prevents, in
      increasing order of nastiness. (1) `.env` sits in the context of all three images — nothing copies it
      today, but a bot token in an ECR layer is fixed by rotating credentials, not by rebuilding. (2)
      `COPY packages/core packages/core` is a *directory* copy, so it carried the host's `dist` **and**
      `.tsbuildinfo`; `tsc --build` trusts `.tsbuildinfo` to decide what to recompile, so a stale one makes
      it skip the build and leave a stale `dist` in the image — core's exports resolve to `dist`, so that
      image serves the previous API without erroring, inside a container read through CloudWatch. (3)
      `node_modules` exists for `apps/agent`, `apps/worker` and `packages/core`, so those same copies landed
      pnpm symlink farms on top of the install the deps stage had already run. (4) Coolify builds on the VM,
      where memory is a recorded risk, and the context was shipping `docs/hackathon-ideas.json` (6.6MB) and
      the rendered transcript (834KB) on every deploy
- [x] ESLint guard proving the agent workspace cannot import a database client — verified by probe,
      fires on both `drizzle-orm` and `@baton/core/db`
- [x] **The root `test` script builds `@baton/core` first.** Core's exports resolve to `dist`, so a stale
      `dist` does not error — it silently satisfies imports against the *previous* API, and a whole suite can
      pass while `src` has moved on. This is not hypothetical: it masked an incomplete refactor for a full
      revision of this document. Only core is built, not `pnpm build`, because the `apps/web` standalone
      build fails with `EPERM` on Windows and would block the suite. **Treat any "N tests pass" claim made
      without a fresh core build as unmeasured.**
- [~] `.env.example` listing every variable, no real values — complete as a list, but it has drifted from
      the files it documents on one point: it states that `docker-compose.dev.yml` publishes
      `127.0.0.1:5433:5432`, and that file publishes `5432:5432`. A contract file that describes a
      configuration nobody is running is worse than a missing comment, because it is trusted

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
- [x] **`loadDotEnv` reachable only through `@baton/core/env`, never the barrel.** It reads the filesystem,
      and the barrel is imported by `use client` components in `apps/web` — `FactPanel.tsx` among them — so
      a `node:fs` import was reachable from a client bundle and survived only on tree-shaking. A subpath
      makes that structural. `db/migrate.ts` reaches it by dynamic import for the same reason. Only CLI and
      dev entry points may call it: a long-running container silently absorbing a stray `.env` is how you
      deploy against the wrong database
- [x] **The old intake locations are deleted, not merely bypassed** — `intake/prefilter.ts` and
      `intake/normalise.ts` were left on disk after the primitives moved to the top level of `src`,
      unreachable through any barrel but still importable by path. A stale `dist` was serving them, which is
      how the `scripts` workspace went on compiling against an API that no longer existed
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
      `apps/worker/src/main.ts`, and **all four migrations have been applied to live Postgres 17**
      (`127.0.0.1:5432`), to both `baton` and `baton_test`, each verified at 21 tables against
      `information_schema`. The schema is no longer proved by generated SQL alone: Postgres has accepted it.
      Note that `baton` sat at **one** of four migrations until this was re-checked — the previous revision
      recorded all four as applied before they were

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
- [x] `my_chat_member` → one-time introduction message, idempotent per chat `[F22]` —
      `handleBotMembershipEvent` is implemented and tested, its introduction goes through the outbound
      queue, and it is **now wired into the runtime** via `buildIntakeHandlers`. Guarded to the configured
      chat: this update type is not chat-filtered by `normaliseUpdate`, so without the guard the bot would
      introduce itself in any group it was added to
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
- [x] Exponential backoff and a cap on consecutive failures — `runtime/backoff.ts`, asserted by
      `test/backoff.test.ts` (9 cases). **An unattended crash-loop is the cheapest way to spend real money
      here**, and delay alone does not prevent it: an exponential curve with a ceiling still retries
      forever, just more slowly, and a revoked API key will not fix itself. So there are two protections —
      the delay for the transient case, the cap for the persistent one. Asserted properties: the curve
      doubles and clamps, jitter is downward only so the documented ceiling is never exceeded, a 2,000-
      failure streak does not overflow into `Infinity` milliseconds, and the count is **consecutive** rather
      than cumulative so a loop that works nine times and fails once is not eventually stopped for it
- [x] Context hydration per task, per the hydration table — Curator does **not** receive the fact index.
      `pipeline/hydrate.ts`; `hydrateIngestContext` omits it while `hydrateRespondContext` includes it.
      The fact index **is** the whole retrieval layer, with no vector store on purpose: a couple of hundred
      claims is a few thousand tokens, and embeddings over 200 rows would be ceremony that also introduces
      a way for the right fact to be absent from a request
- [x] Scheduler for the periodic sweep — the tick loop in `runtime/worker.ts` runs `runSweepPass` every
      cycle (15s by default). **Not `setInterval`:** an interval fires whether or not the previous cycle
      finished, so a slow tick would overlap itself and every overlap would find the pipeline lock held and
      do nothing but pay for the setup. The loop sleeps *after* completing, so the period is a gap rather
      than a schedule. A 15-second gap is affordable only because the sweep short-circuits in SQL when the
      candidate set is unchanged — an idle system calls no model at all, which is asserted by
      `test/tick.test.ts`
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

**Stage one is done and observed.** `pnpm backfill -- --chat-id 0` loads 1,753 messages of the two-month
slice, reports 1,287 candidates / 466 discarded / 2 unprocessed / 1 edit replayed, and a second run adds
nothing. Stage two — candidates to `ingest`, then one `assess` pass — is blocked on `G1`.

**One deviation from the design, recorded rather than hidden.** `scripts/src/backfill/messages.ts` still
holds its own `insert`, which is exactly the second insert path this section exists to prevent. Removing it
requires `apps/worker` to expose `persistMessage`, `openRun`, `runIngestPass` and `runSweepPass`, and
`apps/worker` has no `exports` map — so whether the worker becomes an importable library, or that
orchestration moves into `packages/core`, is an open architecture decision. Until it is taken, the
mitigation is that every field written comes from `expandRenderedMessage`, so the **normalisation** is
shared even though the insert is not. The two ticks below marked `[~]` are `[~]` for this reason alone.

- [~] Reads the rendered transcript artifact and feeds it through `packages/core`'s seed adapter — **no
      insert statement of its own** `[F2]`. Feeds through the adapter; the insert is still its own, per the
      deviation above
- [x] Uses `expandRenderedMessage` from `@baton/core` for edited messages. It returns `[original]` or
      `[original, edited]` as two events sharing one `telegramMessageId`, so the edit arrives as an upsert
      over the original rather than as a second row — which is what makes the seeded edit exercise the real
      `edited_message` path `[F4]`. Observed: one edit replayed. **The two variants cannot travel in one
      statement** — Postgres rejects an `INSERT` whose `ON CONFLICT` target is hit twice by a single
      command — so the edited variants are applied afterwards, in order, each resetting `curated_at`
- [~] Resolves seeded senders to `people` rows and passes `senderPersonId` **explicitly** to
      `persistMessage`. **17 of the 20 volunteers have no Telegram account**, so sender resolution cannot
      go through `senderTelegramUserId`; leaving it implicit silently attributes seventeen people's
      messages to nobody. Resolved and passed explicitly — but to the local insert, not `persistMessage`
- [x] Feeds messages in strict `sent_at` order, so reply pointers resolve and supersession lands the right
      way round — sorted here rather than trusted, ties broken on message id so the order is total
- [ ] Calls `runIngestPass` repeatedly under a single `runId` from `openRun(db, "backfill")`, so each
      transaction stays bounded while one run row spans the whole replay. A single transaction over 4,421
      messages would hold the advisory lock across every model call in the batch
- [ ] Finishes with `runSweepPass(deps, { runId, force: true })` — `force` exists precisely because a first
      run has no previous fingerprint to compare against, and without it the short-circuit would skip the
      only sweep that matters
- [x] Idempotent: a second run over the same artifact adds no duplicate messages, facts or findings —
      observed, twice over: `+0 new` people and aliases, and `messages` still at 1,753 rows afterwards
- [~] Reports what it did — messages read, skipped by the pre-filter, facts extracted, findings raised —
      because a backfill that silently half-worked looks identical to one that worked. Reports read,
      candidates, discarded, unprocessed, edits replayed and the resulting row count. **Facts extracted and
      findings raised are stage two**, so those two figures are absent rather than zero

## Worker — runtime loop

**Done, and test-proved.** `apps/worker/src/main.ts` is now deliberately thin — migrations, HTTP server,
`startWorkerRuntime`, signal handling — and all the behaviour lives in `runtime/worker.ts`,
`runtime/tick.ts` and `runtime/backoff.ts`, each drivable with a fake Telegram and a fake transport. Put
another way: the thing that turns the worker from a library into a service is itself testable, which the
obvious implementation (logic inline in `main.ts`) would not have been.

Three exported values in this layer exist to be asserted rather than inspected — `TICK_PASSES`,
`LOCKED_PASSES`, and the handler set built by `buildIntakeHandlers` — because each encodes a decision that
a refactor would reverse without failing anything.

- [x] `seedAppSettings` called at startup, before either loop — every hydration path reads `app_settings`
      for the chat id, org name and timezone, and a null timezone resolves relative dates against UTC,
      which at IST shifts them by a day and reads as a provenance bug rather than a timezone one
- [x] `IntakeLoop` started, with all four handlers wired: `applyMembershipEvent` **plus**
      `briefOnMembership(deps)` for `chat_member`; `handleBotMembershipEvent` for `my_chat_member`, with its
      introduction going through the `OutboundQueue`; `applyEditConsequences` for `edited_message`; and
      `dispositionOfReply` for `onQuestionToBot`. **Asserted as a set**, not individually: the loop's
      interface makes every handler optional, so one dropped in a refactor would neither fail to compile nor
      fail any other test. Each omission is a distinct silent failure, listed at the function
- [x] The tick, in order: `runIngestPass` → `runSweepPass` → `runRespondPass` → `runAskPass`. The order
      is not arbitrary — sweep before respond because an answer citing a finding needs the finding to exist,
      and ask last because it is the only pass that *sends*, so putting it first would always be sending the
      previous tick's decisions. The order is the exported `TICK_PASSES`, asserted directly
- [x] `runRespondPass` deliberately **outside** the pipeline advisory lock. It derives nothing and
      supersedes nothing, so it cannot race the order-dependent work, and holding the lock would make a
      group question wait behind a backfill — the one delay anybody notices during a demo. Proved **both**
      ways: structurally against the exported `LOCKED_PASSES`, and behaviourally by holding the lock from a
      separate reserved connection and observing that respond and ask still completed while ingest and sweep
      reported `lockHeld`
- [x] Exponential backoff and a cap on consecutive failures. **An unattended crash-loop is the cheapest way
      to spend real money here**, since every tick can invoke a model. Reaching the cap **stops the loop and
      does not exit the process**: Coolify restarts a container that exits, which would reset the counter and
      defeat the cap entirely — the restart loop the health-check design goes out of its way to avoid. A
      stopped loop in a live container keeps `/health` green and the failure legible.
      **A design error was found and fixed here by the test rather than by review:** the first version
      counted a tick as failed only when *every* pass failed, which meant ingest failing forever on a
      revoked key while the other three succeeded at doing nothing would never trip the cap — precisely the
      case it exists for. Any failed pass now fails the cycle, while the tick still runs the other passes
- [x] `queue.drain()` on shutdown, so a queued outbound message is not lost on redeploy — a dropped one is
      a question a volunteer was about to be asked, gone with nothing recording it. Drained **after** both
      loops stop, so nothing is still enqueueing
- [x] Health check stays green while a tick is running and goes red only when the database is unreachable —
      it probes Postgres and nothing else, so a slow model call cannot make it fail. Structural rather than
      defended: there is no tick state for it to read
- [~] Observed working: the worker container starts against live Postgres, polls, processes, and writes a
      `runs` row per tick. **This is the item that converts every test-proved tick above into a
      deployment-proved one.** The loops are proved to poll, process and write a `runs` row per tick against
      **live Postgres** — but with a fake Telegram and a fake transport, and **no worker image has been
      built or run**. What remains is the container, a real bot (`G6`) and a real model (`G1`)
- [x] Two loops rather than one, so curation never blocks polling — asserted independently of the pass
      logic: the tick loop exhausting its failure cap does not stop the intake loop
- [x] Neither loop uses `setInterval` — each sleeps *after* completing, so the period is a gap between
      cycles rather than a schedule. An interval fires whether or not the previous cycle finished, and an
      overlapping tick would find the lock held and pay for the setup to do nothing
- [x] The startup check that Baton is a group **administrator**, logged as a warning rather than enforced.
      Telegram delivers `chat_member` only to administrators, so a non-admin bot misses every join and
      departure and the brief never fires — with nothing erroring. One line in the deploy log is the
      difference between finding that now and finding it on camera
- [x] `my_chat_member` guarded to the configured chat. `normaliseUpdate` filters *messages* by chat id but
      not this update type, so without the guard adding the bot to any other group has it introduce itself
      there — a confusing way to discover a token was reused between the demo bot and the development one

## Agent — container

- [x] Express server implementing the AgentCore `/invocations` contract — plus `/ping`
- [x] Dispatch on `task`: `ingest`, `assess`, `brief`, `respond`, `resume` — five branches wired, all
      five now backed by real agents
- [x] Per-agent model configuration from environment variables — **validated by a Zod schema, with the
      environment injected rather than read from `process.env`**, matching the worker's pattern. This
      container's environment is the least inspectable in the system: set once at `agentcore launch`, with
      no manifest for it in this repository the way `docker-compose.yml` is one for the worker, and its logs
      read through CloudWatch. So it reports every missing variable in one message instead of throwing on
      the first — a container that fails, is redeployed, then fails on the next costs a deploy cycle per
      typo, on the slowest service to redeploy. Two regressions closed and asserted by
      `apps/agent/test/config.test.ts` (13 cases), both re-checked inside the built image: a non-numeric
      `AGENT_PORT` was `Number.parseInt` → `NaN`, and `app.listen(NaN)` binds an arbitrary free port, so the
      container came up healthy on a port nothing routed to and the failure presented as an egress problem;
      and an empty string counted as a value, so an exported `MODEL_API_KEY=` would have been sent to the
      provider. `AGENT_PORT` → `PORT` → 8080 precedence is asserted too, since the agent and the worker
      share one `.env` locally and both read `PORT`
- [x] Zod validation of every model response, with retry feeding the validation error back —
      `model/structured.ts`, three attempts, the validation error and the rejected output both fed
      back on the same agent so conversation history carries. **Not** the SDK's
      `structuredOutputSchema`, which throws `StructuredOutputError` without feeding the error back
- [x] Trace assembled and returned in the response payload — nodes, model, tokens, tool calls,
      reasoning. Model id comes from configuration, because the SDK exposes it on neither the result
      nor the metrics. The partial trace is returned on failure too, or a failed run is undiagnosable
- [x] Strands tools wired to the worker's data API — `searchFacts`, `getEvidence`, `getHoldings`,
      `getPerson`, declared with plain JSON Schema rather than Zod so no Zod schema crosses the SDK
      boundary. The four `/data/*` routes **answer real queries** and are integration-tested against
      live Postgres, so the pull path is answerable end to end — see **Worker — orchestration and API**.
      (A previous revision said here that they were still 501 stubs while that section said they were
      not; this one was the stale copy.)
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
| F18 Restraint on three paths, gated per output class | Gate, scoping and quiet-decision records done and asserted | **Done** — worker persists `quiet_decisions` from all three scopes and the web renders the strip inside the first viewport |
| F20 Answer with provenance and age | Four branches, age recomputed from the register | **Done** — worker detects the question and sends the reply |
| F21 Questions targeted by sensitivity | Respondent proposes the target | **Done** — worker writes `questions`, enforces the budget, and routes. Note the worker *overrides* the proposed target for `ambiguous_holder`, always privately |
| F23 Brief, three fixed sections, join and leave | Both variants, including the empty case | **Done** — worker fires it from a `chat_member` event |
| F25 Line-level brief records with evidence | Lines emitted with their own evidence refs | Worker writes `brief_lines` and they are assignable in the store; **the web surfaces them, and filing goes through the server-action seam without persisting yet** |

**F7, F12, F16, F17, F20, F21 and F23 are now closed outright.** F18 is closed on both halves. F25 has
only its web *write* outstanding — the lines, their evidence refs and the copy-and-file controls are all
rendered and observed. F11 waits on `G1`/`G2`. `[F13]` and `[F15]` are the worker's and are now complete
in the persistence and derivation section above. `[F24]`, `[F26]`, `[F27]`, `[F28]`, `[F29]` and `[F30]`
are closed by the web section below, `[F30]` more strictly than before: redaction moved to the server, so
a credential no longer travels to the browser at all.

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

**The admin UI is one page.** Four stops on one scrolling document — Continuity, Who holds what,
Briefs, Set aside — behind the passcode gate, which stays a route of its own because a page that
renders protected content cannot also be the page that decides whether to show it. This is a
deviation from the previous build, which had five routes, and it was taken for two reasons that are
structural rather than aesthetic: the fact panel is now mounted once for the entire product, so no
surface can quietly lack provenance; and what Baton withheld is a scroll from what it raised rather
than a click into a different screen. `/holdings`, `/briefs`, `/quiet` and `/dismissed` are deleted
and return 404 — verified, signed in, all four.

Every item below was **observed in a browser** against the running app, at a stated viewport, with the
console clean. Two of them were observed *failing first*, and both are recorded under the ticks
because each was invisible until something looked:

1. **Route protection did not exist.** `middleware.ts` sat at `apps/web/middleware.ts`, and Next only
   picks middleware up from beside the `app` directory — `src/`, in this app. It was never invoked:
   `GET /` returned the entire admin UI, findings and all, to a request with no cookie, and nothing
   failed, warned or logged. The only symptom was the absence of a redirect nobody had checked for.
   Moved to `apps/web/src/middleware.ts`; `GET /` now answers 307 to `/login`.
2. **No `use client` component could import the `@baton/core` barrel.** The barrel re-exports
   `normalise.js`, which imports `node:crypto`, so webpack fails the build outright on scheme
   resolution — it is not a tree-shaking question, which is what a previous note in this document
   assumed. Two new subpaths, `@baton/core/constants` and `@baton/core/redact`, are the entry points a
   browser bundle may use; both files have zero imports of their own, so the property is structural.

- [x] Shared passcode exchanged for a signed session cookie `[F29]` — observed: wrong passcode reports
      *"That passcode was not recognised."* with `aria-invalid` set and no redirect; the correct
      passcode lands on `/`; `Sign off` clears the cookie and the next `GET /` redirects again
- [x] Route protection on every page and API route — observed, and see failure (1) above, which is the
      whole reason this item is now proved by observation rather than by the file existing
- [x] **Continuity** — header with last-run status and navigation `[F26]`. The navigation moves within
      the document: `aria-current` is set from scroll position, and all four stops mark correctly,
      including at the very foot of the page
- [x] State of the organisation in one sentence
- [x] Since-you-last-looked diff, against `coordinator_state`
- [x] Waiting-on line for open questions, rendering `queued` and `asked` together — both mean Baton is
      holding something back `[F36]`
- [x] Unread-brief banner
- [x] Ranked register, five to eight finding cards — seven, as dense chart rows
- [x] Finding card: capability-subject title, subtype badge, why-it-matters, evidence count,
      confidence, holder as a small attribute
- [x] Finding actions: resolve, already have a backup, dismiss `[F19]` — three controls carrying all
      seven states through a transition; the writes themselves are the seam in `app/actions.ts`
- [x] Quiet-decisions strip, expanded by default, with a link to the full list `[F18]`
- [x] Dismissed-findings list reachable from the register footer `[F19]` — reachable from the strip's
      own header now rather than a footer row of its own, which cost thirty pixels of the fold budget
      to say two words
- [x] **State line, register and quiet-decisions strip all fit the first viewport — measured, not
      claimed.** At 1440×900: header bottom 44px, last of seven finding rows 753.8px, quiet strip
      872.4px, leaving 27.6px of slack, *with the state sentence wrapping to two lines*. It did not fit
      before this build: the same three things ended at 1214px, 314px below the fold, so the product's
      signature was off-screen on the screen it exists to be on. What bought it back: the quiet strip
      became one line per decision rather than a stacked block (−159px), the finding row's three lines
      and paddings were retuned against the fold (−175px), and the register footer folded into the
      strip header. Also verified at 1920×1080
- [x] **Who holds what** — inventory grouped by asset kind `[F26]`. All six kinds shown, including the
      empty ones, because a kind the group depends on nothing of is itself information
- [x] Row: claim, holder, coverage count, confidence, last confirmed, status — the asset label is a
      real `Claim` and opens the fact panel, so the inventory is one gesture from provenance like every
      other surface. Where no fact backs the asset it stays plain text rather than guessing an id into
      the panel and opening the wrong thing
- [x] **Briefs** — current brief and all past briefs `[F25]`
- [x] Brief copyable as text `[F25]`
- [~] Brief lines individually assignable, as a record with no notification `[F25]` — the control ships
      complete and goes through the server-action seam rather than staying local, so the
      no-notification promise is kept by the write path and not by a component that could later grow a
      send call. **The write itself is still a seam**: nothing is persisted yet
- [x] **Brief offered to its subject — copyable text always; direct message only where that person has
      previously opened a chat with the bot** `[F24]`. Both states are rendered and both were observed:
      the arrival brief offers an enabled *Send privately*, and the departure brief shows a **disabled**
      *Direct message unavailable* with the platform reason beside it. A button that silently failed
      would have been worse than none, which is why the fixture carries one subject of each kind
- [x] **Fact detail** panel, openable from any claim on any surface `[F27]` — mounted once for the whole
      document; observed opening from a register finding and from an inventory row
- [x] Fact detail: claim, status, holder history, source message quoted verbatim with sender and date
- [x] Fact detail: supersession chain and Baton's stated reasoning — the Curator's own reasoning when
      there is one, and otherwise the register's stated rule for that status, *labelled as the fallback*
      rather than presented as a judgement about that particular claim
- [~] Fact detail actions: correct, retire, mark verified — all three present with their disabled and
      pending states, and `Mark verified` correctly only enabled for a fact awaiting confirmation.
      **Demonstration-only**: they exercise the states and write nothing
- [x] **Credential redaction applied everywhere a message is quoted `[F30]` — and moved to the server.**
      Observed: the Instagram quote renders `password is [redacted]` with a REDACTED badge. It was being
      redacted *at render* in a client component, which means the literal credential was in the page
      payload and readable in the network tab, and called redacted because the pixels never showed it.
      The raw text is now stripped before it crosses the boundary; the only copy the browser receives is
      the redacted one
- [~] Withdraw-provenance action, since Telegram reports no deletions `[F4]` — present, two-press
      (asks, then acts), and the panel honours it: the quote is replaced by an explanation and a
      WITHDRWN badge while the claim, its status and its chain are untouched, and the text stops
      travelling from the server as well as stops showing. **The persistence is a seam**
- [x] **Agent activity** slide-over from the header `[F28]`
- [x] Activity panel: messages read, facts extracted, candidates skipped, run trace
- [x] Empty states read as good news, not errors
- [x] Absent by design, verify: no question box, no charts, no volunteer pages, no settings page,
      no mobile layout — and now no second page at all. The viewport is declared at a fixed 1280 width
      rather than left to reflow, so a phone renders the chart zoomed out and legible instead of
      pretending to be responsive

**Two reads cross the server boundary explicitly.** The fact panel and the activity panel are the only
surfaces that read on demand, and both are client components, so they call `app/panel-actions.ts`
rather than importing `lib/data.ts`. Importing the read seam from the client would ship every fixture
to the browser today and a database client once the schema lands. `lib/data.ts` remains the single
place the UI reaches for data; that file is the doorway the two panels knock on.

**The three writes the fixtures cannot honour are named, not hidden.** `resolveFinding`,
`markHasBackup` and `dismissFinding` revalidate and return success without persisting, and the fact
panel's correct/retire/verify are local timers. The architectural decision they wait on — whether the
web app writes to Postgres directly or POSTs to the worker so the register's invariants stay in one
owner — is recorded in `app/actions.ts` and is deliberately not being guessed at.

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
- [x] Enters through the same normaliser as live traffic, `source = 'seed'` `[F2]` — the renderer emits
      normalised-shape records and tags `source: "seed"`, and `scripts/backfill.ts` now loads them through
      core's seed adapter. 1,753 messages of the two-month slice are in Postgres. There is deliberately no
      second normaliser in the seed path: a second one would drift on exactly the fields nobody checks —
      provenance flags, the content hash, the unprocessed flag. **The insert, unlike the normalisation, is
      still local to `scripts`** — see the deviation recorded under **Worker — backfill**
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
- [x] Pre-filter — recall over the **planted** material, in `scripts/test/prefilter-recall.test.ts`. Every
      authored placement carrying a non-noise coverage row is asserted to survive, and every planted case is
      asserted to keep at least one carrier, so tightening a rule cannot silently remove the stale-figure
      case that opens the video. Runs against the committed plan fixture, not the gitignored transcript, so
      it works on a fresh clone. Scope is deliberately narrow: rule-level behaviour belongs to core's test
      above, and two files asserting the same rules is how they come to disagree. It also asserts the one
      input it synthesises — `isUnprocessed`, derived exactly as `fromRenderedMessage` derives it — because
      getting that wrong would dismiss a captioned attachment as unreadable and take its coverage row with it
- [ ] **Pre-filter — keep rate asserted against the rendered transcript, not the hand-labelled corpus.**
      This is the guard that is missing, and its absence is why a 73% keep rate reached a backfill run
      unnoticed. Core's bound is `keepRate < 0.75` over 36 messages; the real slice is 1,753 and 73% passes
      under it. An earlier revision of the scripts test carried two assertions that encoded the calibration —
      that a date word alone and length alone must not earn a keep — and they were removed as obsolete when
      the pre-filter was rewritten, because the rewrite had made them fail. They were guarding something
      real. See the open calibration decision in the status block
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
- [x] **`TELEGRAM_CHAT_ID` validated as a single integer.** Everything downstream takes one number —
      `IntakeLoop`, `app_settings.chat_id`, the `(chat_id, telegram_message_id)` constraint — and the design
      is explicit that other chats are ignored. A comma-separated list would parse as `NaN` and match no
      chat at all, so the bot would appear to be in the group, poll successfully, and silently ignore every
      message. That is indistinguishable from privacy mode being left on, which is the *other* thing that
      produces exactly no messages. Found because the real `.env` held three comma-separated ids
- [x] Backoff — `test/backoff.test.ts`, 9 cases. See **Worker — orchestration and API**
- [x] The tick — `test/tick.test.ts`, 10 cases: the pass order as a readable value, a run row per pass,
      respond and ask completing while another connection holds the pipeline lock, a failing pass not
      aborting the tick and being recorded as a failed run, and an idle tick calling no model at all
- [x] The runtime supervisor — `test/runtime.test.ts`, 9 cases. The file that proves the worker is a
      service: settings seeded before the loops, `getMe` before the first `getUpdates`, the
      not-an-administrator warning, polling writing a `runs` row, **a `chat_member` event producing a
      `briefs` row through a real `IntakeLoop` with no button pressed**, shutdown draining the queue, the
      tick loop giving up after its cap while the intake loop keeps running, the handler set, and the
      foreign-chat guard
- [x] Agent configuration — `apps/agent/test/config.test.ts`, 13 cases. Weighted toward *how it fails*
      rather than whether it parses, because this is the container whose logs are hardest to reach: every
      missing variable reported at once, an empty string treated as absent, a non-numeric or out-of-range
      port refused instead of binding `NaN`, `AGENT_PORT` beating `PORT`, and one role pointed at a stronger
      model without disturbing the other five
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
compose files could only be validated by `docker compose config` no longer applies. Multi-stage
pnpm-workspace builds are where small mistakes hide, so these precede any deploy attempt.

**A `.dockerignore` now exists, and every image build depends on it.** All three Dockerfiles take the
repository root as context, so without it the context was the entire working tree. See the item under
**Repository and tooling** for the four failures it prevents — the stale-`.tsbuildinfo` one is not
hypothetical and would have shipped a stale `packages/core/dist` inside an image.

- [x] `docker build -f apps/agent/Dockerfile .` succeeds — built in ~73s, 385MB. The container also
      **starts and reports healthy**, which exercises its own `HEALTHCHECK` against `/ping`, so the
      AgentCore contract is proved locally rather than assumed. Configuration failures were checked in the
      container too: a missing environment names all four required variables at once, and `AGENT_PORT=http`
      is rejected rather than binding `NaN`
- [ ] `docker build -f apps/worker/Dockerfile .` succeeds
- [ ] `docker build -f apps/web/Dockerfile .` succeeds — the standalone trace must include
      `packages/core`, or the image starts and fails on first import. **Known blocker, now narrowed to
      one cause:** `pnpm build` for `apps/web` fails on the host with an `EPERM` while symlinking
      `node_modules` into `.next/standalone`, which is a Windows symlink-privilege matter rather than a
      code fault. Everything before that step now passes — `next build` compiles and generates all
      static pages. A second failure that had appeared in front of it is fixed: once `packages/core/dist`
      was rebuilt, webpack raised `UnhandledSchemeError: node:crypto`, reached from a `use client`
      component through the core barrel, and that is resolved by the `@baton/core/constants` and
      `@baton/core/redact` subpaths. The Linux image build may not hit the `EPERM` at all, but it must be
      checked rather than assumed. **Re-checked 2026-09-14:** `apps/web/.next` exists from a build that
      reached *"Collecting build traces"*, and `apps/web/.next/standalone` is still absent — so the
      symlink step is still where it stops, and no host build has yet produced the trace this image copies
      **A third blocker was found and fixed earlier:** this Dockerfile copies `/repo/apps/web/public`
      unconditionally and that directory did not exist, so the build failed on a `COPY` whose source was
      missing — an error that reads as a Dockerfile bug rather than an absent directory. `public/.gitkeep`
      now holds it open, and says in its own text that it may only be deleted together with that `COPY`
- [ ] **Images built for `linux/arm64`.** AgentCore Runtime requires arm64 for all deployed agents, and no
      Dockerfile pins a platform — a default build on an x86 machine produces amd64 and the runtime rejects
      it. The agent build above was amd64, so it proves the Dockerfile and not the target architecture.
      Deploying through the AgentCore CLI makes this moot, because CodeBuild builds arm64 remotely; building
      locally to push does not, and needs `--platform=linux/arm64` with the slowness emulation implies
- [ ] Web build peak memory recorded, and compared against the VM's free memory
- [x] `docker compose -f docker-compose.dev.yml up -d` brings Postgres up healthy — Postgres 17 on
      `127.0.0.1:5432`, hosting both `baton` and `baton_test`, and every worker integration test runs
      against it. **`.env.example` documents 5433 and claims this file publishes `5433:5432`; it publishes
      `5432:5432`.** The protection that comment describes — not colliding with a Postgres already on 5432 —
      does not currently exist. Fix one or the other; moving compose to 5433 preserves the stated intent
- [ ] Worker container starts, runs migrations, and answers `/health` with 200 — migrations and `/health`
      are both proved on the host; the container has not been built

### AWS — the agent

- [ ] Agent container built and deployed to AgentCore via the AgentCore CLI, CodeBuild building remotely
- [ ] **Built for `linux/arm64`.** AgentCore requires arm64 for every deployed agent and neither Dockerfile
      pins a platform, so a build on an x86 machine produces amd64 and the runtime rejects the image. Going
      through the AgentCore CLI makes this a non-issue, because CodeBuild builds arm64 remotely — which is
      also the reason a local Docker daemon is optional for this path. Building locally to push is the case
      that breaks, and it needs `--platform=linux/arm64` and the slowness emulation implies
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
- [~] Each Dockerfile builds with the **repository root** as context, so `packages/core` resolves — the
      configuration is in place and says why: `docker-compose.yml` sets `context: .` for both `worker` and
      `web` with the workspace-dependency reason written beside it, and the agent image was actually built
      that way. What remains is the other two builds themselves, which is the two items under **Images**
- [ ] VM free memory checked against a Next.js production build; image built elsewhere if tight
- [ ] Environment variables held in Coolify's per-resource config, not a file beside the code
- [ ] No second reverse proxy anywhere — Coolify's proxy owns ports 80 and 443
- [ ] Bot token in Coolify's environment config, never committed

### Environments

- [ ] `AGENT_TRANSPORT` implemented as one interface with two implementations: `agentcore` (SigV4) and
      `http` (local agent), with the AWS variables unused under `http`
- [ ] Second BotFather bot and private test group for local development, with privacy mode off, promoted
      to administrator, and `allowed_updates` set — all three, or membership events are silently absent
- [x] **A separate `baton_test` database, with `TEST_DATABASE_URL` set.** `db/testing.ts` truncates every
      table between cases and refuses to run unless this URL is present *and* differs from `DATABASE_URL` —
      pointed at the development database it would destroy the seeded history and the golden reset point
      without failing a single assertion. Both databases live on the same server under the same `baton`
      role; only the database name differs. `setupTestDatabase` migrates it on every run, so it only has to
      exist. **This step was undocumented, and its absence is why 476 worker tests had never run** on a
      machine that otherwise looked correctly configured: pnpm's recursive run aborted in `packages/core`
      before `apps/worker` was reached
- [x] **`AGENT_PORT` set locally.** Both the agent and the worker read `PORT`, which is correct in
      production where each is its own container, but locally they share one `.env` — so without
      `AGENT_PORT=8080` the agent binds the worker's 8081 and `AGENT_HTTP_URL` then points at nothing.
      Documented in `.env.example`; it had drifted out of the real `.env`
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
