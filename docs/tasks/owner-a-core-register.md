# Owner A — Core & Register

**Your remit:** the database and everything derived from it. Nothing in Baton is true until your schema
says so, and every finding the product shows is produced by your SQL.

**Your share:** 113 of 332 items.
**Companion documents:** `docs/work-split.md` for the team protocol, and the implementation checklist for
the full item text of the sections assigned to you wholesale.

---

## Files you own

Nobody else edits these. If you need a change outside this list, ask its owner.

```
packages/core/src/constants.ts
packages/core/src/redact.ts
packages/core/src/schemas/envelope.ts          ← the contract across the AWS boundary
packages/core/src/prompts/shared.ts
packages/core/src/db/**                        ← sole generator of migrations
packages/core/drizzle/**                       ← nobody else runs db:generate, ever
apps/worker/src/prefilter/**
apps/worker/src/persistence/**
apps/worker/src/detection/**
apps/worker/src/processing/**                  ← processing loop, scheduler, backoff
apps/worker/src/orchestration/**               ← per-task context hydration
apps/worker/src/api/routes/data.ts             ← the four read-only handlers
scripts/backfill.ts
tsconfig*.json, eslint.config.mjs, .prettierrc.json
```

**Test files follow their source**: `redact.ts` is tested by `test/redact.test.ts`. Never a shared test
file.

## Files you must not touch

`apps/agent/**` and the six per-agent schema and prompt files are B's. `apps/web/**`,
`apps/worker/src/telegram/**`, `apps/worker/src/human-loop/**`, `apps/worker/src/api/server.ts`, the
Dockerfiles and the compose files are C's. `apps/worker/src/agent/transport.ts` is B's.

`apps/worker/src/config.ts` is shared — **append only**, in your own commented block, and never reorder
existing keys.

---

## Do these first — they block other people

### Gates (3 items)

- [ ] **G1.** Strands TS agent with the OpenAI-compatible provider pointed at the model's base URL — one
      agent, one call, locally. Records whether a custom base URL is accepted at all.
- [ ] **G2.** Structured output through that provider — one Zod schema, ten runs on a messy sample
      message. Record the conformance failure count; it sets how defensive the retry logic must be.
- [ ] **G7.** Record Curator latency on a batch of ten. If the model does extended reasoning, decide now
      whether to shrink batches or disable reasoning mode.

**G1 and G2 block B entirely** — B has nothing to deploy to AgentCore until an agent runs locally. They
are about an hour of work. Do them before anything else, and post the result in chat: does the provider
accept a custom base URL, and how many of ten runs failed schema conformance.

### Then the schema, then a fixture for C

Your `Database schema` section is the second thing that unblocks people: C cannot build a screen and B
cannot hydrate context until the tables exist.

Immediately after the first migration lands, hand C a **hand-written fixture dump** — about twenty rows.
A few people, a few assets, holdings with one deliberately unowned, three or four findings across
different subtypes, one brief with a handful of lines. Not realistic, just structurally complete. C's
entire admin UI is blocked until this exists, and the golden dump is days away.

---

## Sections assigned to you wholesale

Work these from the implementation checklist; every item in them is yours.

| Section | Items |
| --- | --- |
| Database schema | 36 |
| Worker — pre-filter | 4 |
| Worker — persistence and derivation | 24 |

The two structural-guarantee items in `Database schema` are already `[x]` and enforced by
`packages/core/test/privacy-guarantees.test.ts`. They are vacuous today and become load-bearing the
moment you add a table — if that test ever fails, you have added a column the product promises does not
exist.

Three items in there carry more weight than their one line suggests:

- **`facts.match_key`** — without it, every mention of the van keys becomes another active row and the
  register fills with near-duplicates that all look current.
- **`findings.dedupe_key`** — without it, every sweep either duplicates the register or resurrects
  something already dismissed. Dismissals are recorded against the key, which is what makes dismissal
  permanent.
- **`questions.asked_at` nullable** — a default of insertion time makes the ask budget's rolling window
  count questions that were never sent.

---

## Split sections — your items only

### From `Repository and tooling` (10 items, all already done)

- [x] pnpm workspace root with `apps/*` and `packages/*`
- [x] `apps/agent`, `apps/worker`, `apps/web`, `packages/core` created
- [x] `scripts/seed-plan.ts`, `scripts/seed-transcript.ts`, `scripts/backfill.ts`, `scripts/reset-demo.ts` stubs in place
- [x] TypeScript strict mode across all workspaces
- [x] Single lint and format config at the root
- [x] `.env.example` listing every variable from the config section, no real values
- [x] `.gitignore` covering `.env`, build output, and any database dump
- [x] `.gitattributes` normalising to LF
- [x] MIT `LICENSE` file at the root, with a matching license field
- [x] ESLint guard proving the agent workspace cannot import a database client

### From `packages/core` (8 items)

- [~] Drizzle schema for every table — pgEnums defined from the shared constants; table definitions remain
- [x] Zod schema: agent request envelope (`task`, payload, hydrated context)
- [x] Zod schema: agent response envelope including the `trace` array
- [x] Prompt files, each carrying a `prompt_version` constant — the versions and the observation
      constraint. **The six prompt bodies are B's.**
- [x] Shared types exported for the web app to consume
- [x] `@baton/core` exports resolve to `dist`, not `src`, so the production containers can load them
- [x] Core barrel does not re-export `./db`, so the agent cannot acquire a database client transitively
- [x] Credential-redaction helper, used by every surface that quotes a message `[F30]`

### From `Worker — orchestration and API` (4 items)

- [ ] Exponential backoff and a cap on consecutive failures
- [ ] Context hydration per task, per the hydration table — Curator does **not** receive the fact index
- [ ] Scheduler for the periodic sweep
- [ ] Data API: `searchFacts`, `getEvidence`, `getHoldings`, `getPerson` — read-only

### From `Approval round trip` (1 item)

- [ ] Pending changes excluded from every finding and every brief `[F33]`

This is yours because it is enforced in SQL, not in prompt text: every detection query filters
`status = 'active'`, so `unverified` and `pending_approval` rows are invisible to detection. B raises the
interrupt and C routes the question; you guarantee the pending change cannot leak into a finding.

### From `Tests` (9 items)

- [ ] Pre-filter — table-driven over a labelled corpus, scored on **recall**
- [ ] Detection SQL — five queries against fixtures with known answers
- [ ] Detection SQL — `unverified` and `pending_approval` rows never appear
- [ ] Fact matching — restatement bumps without inserting; contradiction inserts and links
- [ ] Dedupe — two consecutive sweeps produce one finding
- [ ] Dismissal — a dismissed finding never returns
- [ ] Ordering — a contradiction applied forwards and backwards reaches the same state
- [x] Redaction — a credential-shaped string never renders
- [x] Structural privacy guarantees — Drizzle introspection asserting no attendance table and no scoring column

The detection SQL tests are the correctness backbone of the whole product and they are fully
deterministic. They are the highest-value tests anyone writes on this project.

### From `Environments` (4 items)

- [ ] Two-month slice loaded locally; full six months only on the deployed environment
- [ ] `pg_dump` flows deployed → local only; never local → deployed, which would destroy the reset point
- [ ] Golden `pg_dump` taken after the first good backfill
- [ ] Deploy order for a `packages/core` shape change recorded: agent first, then worker

### From `Demo and submission` (3 items)

- [ ] Backfill run against the full six months, with a passing coverage report
- [ ] Register reviewed by eye — five to eight findings, phrased about capabilities
- [ ] README: seeded-history rationale, and the no-score / no-attendance guarantee

### From the cut order (4 items) — only under time pressure

1. [ ] Coverage inference narrows to explicit thanks-lists only
2. [ ] Coverage dropped from findings, which then run on holdings alone
3. [ ] Identity resolution reduces to exact handle matching
5. [ ] Seeded history shrinks from six months to three — you decide, B re-renders

### From `Deferred — Tier 2` (3 items) — only if ahead

- [ ] Proactive stale-fact section in the register, with the full verification loop
- [ ] Plaintext-credential exposure detection
- [ ] Transfers of holding as first-class events

---

## What you owe, and to whom

| To | What | When |
| --- | --- | --- |
| B and C | G1 and G2 result: base URL accepted, conformance failure count | Day 1, first thing |
| C | Hand-written fixture dump, structurally complete | End of day 1 |
| B | The five detection queries and their output shape — the Assessor consumes them | Day 3 |
| C | Golden dump, once a backfill produces good output | Day 4 |

## What you are waiting on

| From | What | Blocks |
| --- | --- | --- |
| C | The normaliser, so seeded messages enter the same path as live traffic | Backfill |
| B | Seed transcript with a green coverage report | Backfill, golden dump |
| B | Assessor output shape | Findings upsert |

---

## Announce before you change these

- **`packages/core/src/schemas/envelope.ts`** — a shape change means the worker and the deployed agent
  disagree until both redeploy, agent first. B is always affected.
- **Any column rename or drop** — C's UI and B's hydration both read your schema.
- **Any new migration** — you are the sole generator, so nobody will conflict, but B and C must pull and
  re-run before their next session.

## Your never-cut responsibility

**One-person risk detection** is yours and is on the never-cut list. If it is at risk, cut from the cut
order above first. **Provenance on every claim** is jointly yours and C's — you store the source message
and the supersession chain; C renders it.
