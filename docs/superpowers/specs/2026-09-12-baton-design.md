# Baton — Design

**Date:** 2026-09-12
**Status:** Awaiting user review, then implementation planning
**Context:** Agents for Humans hackathon, Good Neighbor track. Built with the Strands Agents SDK.
**Purpose:** This document is both the design spec and the product requirements document. There is
deliberately no second PRD; a second document would become a competing source of truth within hours.

## Concept

For a volunteer group, the group chat is the only record there is. Baton remembers all of it, so no one
person has to.

The same description at the two other lengths you will be asked for:

- **Repo About field:** Baton remembers everything a volunteer group knows, so no one person has to.
- **Submission blurb:** For a volunteer group, the group chat is the only record there is. Baton
  remembers all of it — answering the questions that come up every month, noticing what only one person
  knows, and writing the handover when someone leaves.

It answers no questions in its own interface. It decides, message by message, which sentences are
durable operational facts and which are chatter, and maintains a standing register of exposure: what
exactly one person holds, what has no owner at all, and what was promised and quietly dropped. When
Telegram announces that someone has joined or left, it writes the handover document unprompted.

## Positioning

Baton is a continuity risk register. It is **not** a knowledge base, and this is binding on every
surface, the README, and the video.

Two constraints follow:

1. **There is no question box anywhere in the admin UI.** The coordinator reads what Baton decided;
   they do not interrogate it. A text field inviting a question reframes the entire product as
   retrieval, and retrieval is a saturated category with well-funded incumbents.
2. **Baton's distinguishing outputs are judgments, not lookups.** A decision not to raise something,
   a refusal to store a suggestion as a decision, an answer delivered with the warning that it is
   five months old, and an admission that nobody can tell you something — these are the outputs no
   comparable tool produces. They lead everywhere.

Baton does answer operational questions, but it does so **in the group chat**, where they are already
being asked, and it is framed as labour removed from one overloaded person rather than as a capability.

## Problem

A volunteer organisation keeps everything it knows in its group chat. The clinic that treats on
credit, the emergency number printed on two hundred posters, who holds the van keys, whose personal
card quietly pays for the donation page. None of it is written down anywhere else.

When a volunteer burns out and drifts away — and in this sector they do — it leaves with them. Four
things go wrong that software does not currently address:

1. An asset silently loses its owner. Nobody notices until it is needed.
2. One person becomes the sole route to a critical relationship, and the organisation cannot see it,
   because from the inside it looks like someone being helpful.
3. A promise made in passing is never tracked, and dies without anyone deciding to drop it.
4. The same operational questions are answered by the same overloaded person, forever.

## Audience and scale

The immediate user is whoever is currently holding the organisation together — the coordinator who has
become the default owner of everything undocumented.

The category is much larger: any group that runs on volunteers, holds real assets, and has no HR
function, no IT department, and no handover process. Animal rescues, mutual-aid groups, residents'
associations, congregations, parent committees, sports clubs, tenant unions, community libraries.

No product serves them because the work is judgment, not storage. Deciding that a sentence in a chat
is a durable operational fact, that a fact has probably gone stale, and that one person quietly being
the only route to something is a *risk* — those required a human until now. That is what makes this an
agent problem rather than a database problem.

## Setting

The Paws & Claws Collective, a volunteer-run animal rescue of roughly twenty people with one Telegram
group. One coordinator, Priya. The organisation is invented; the infrastructure it runs on is real.

The rescue setting is chosen because its dependencies are unambiguous and the consequences of losing
them are immediate: a clinic that extends credit, an emergency number on printed posters, a van that
is actually someone's own car, a foster-carer list in a personal spreadsheet, a payment link that
donations flow through. Volunteer churn is high and unceremonious, and post-event conversation is
natural, which gives the coverage inference real material.

Currency is INR. All user-facing copy reads clearly to an international audience.

## Track fit

Good Neighbor. The track asks for agents that help a group of people and lighten the load on those
already holding that group together, and that make a community "more organized, more connected, or
more resilient." Baton is an organisational resilience tool for volunteers who are stretched thin.

The track description lists "turning a library's or school's scattered info into something anyone can
just ask" as an example. Baton's group-answering behaviour satisfies that example, which secures theme
fit at Stage One — but because it is a printed example it will be crowded, so it must never open the
pitch. The pitch leads with continuity and resilience.

## Non-goals

No donation or expense accounting. No event notifications, interest polls, or event signup. No
geolocated attendance. No volunteer accounts. No email intake. No event reconstruction or planning. No
image or voice processing. No multi-organisation support. No WhatsApp.

Language choice, deployment topology, storage technology, and the testing strategy are deliberately
excluded from this document and belong to the implementation plan.

## The three behaviours

These are the product. A judge must learn exactly three things, and everything else is supporting
detail that exists without being pitched.

**One — it answers the questions the coordinator answers fifty times a year.** In the group, with
provenance and age attached. When it does not know, or the answer has rotted, it says so and asks.

**Two — it flags what only one person holds.** One finding type, four subtypes, one card design.

**Three — when someone leaves, it writes the handover.** Unprompted, triggered by Telegram.

Plus one flourish, which is not a fourth concept because it is the inverse of the second: **it also
shows what it deliberately did not raise.**

## Uncertainty and human approval

Baton acts autonomously inside a fixed envelope. The envelope is defined by two axes: how confident it
is, and how much it costs if it is wrong.

| | High confidence | Low confidence |
| --- | --- | --- |
| **High consequence** | Act, and record what was done | **Stop and ask for explicit approval** |
| **Low consequence** | Act silently | Record as unverified; do not ask |

The bottom-right cell matters as much as the top-right. An agent that escalates everything it is unsure
about becomes noise and gets muted, so low-consequence uncertainty is recorded as unverified rather
than raised. Asking is rationed precisely so that being asked means something.

**What requires approval.** Recording or changing a high-consequence fact on weak evidence: who holds
financial control, who holds credentials, who is the named contact for a critical relationship, any
transfer of these, and the retirement of a fact that open findings depend on.

**How it asks.** Explicitly, in the chat, in one message that names four things: what it is about to
do, what it is unsure about, the evidence it has, and what happens if the answer is no. *"I'm about to
record that the bank signatory has changed from Meera to Anil, based on one message on 3 September that
could also be read as Anil offering. If that's wrong, say no and I'll leave the current record alone."*

**Where it asks.** Non-sensitive approvals go to the group. Anything touching financial control,
credentials, or an individual's holdings goes to the coordinator privately, never in front of twenty
people.

**How often it asks.** The rationing is numeric rather than a matter of taste: at most two questions
open at any moment, and at most three new ones in any rolling twenty-four hours. Asks queue in priority
order — approval, then clarification, then verification — so a budget spent checking a stale figure can
never crowd out an approval about who controls the money. A queued ask is not discarded, and its claim
stays excluded from findings and briefs while it waits, so the cap produces the same visible gap an
unanswered question does rather than an invented fact. Without a number here, "rationed" degrades into
whatever the register happens to generate on a busy week, and a bot that asks a twenty-person group six
questions in an afternoon gets muted, which costs every later question too.

**While waiting.** The change is held pending. It is not stored as truth, not used in any finding, and
not included in any brief. The admin UI's waiting-on line shows it.

**If nobody answers.** It stays pending indefinitely. It is never silently adopted after a timeout, and
it is never discarded. The underlying claim remains unverified and stays excluded from findings, which
means silence produces a visible gap rather than an invented fact.

**Who may answer.** Verification and clarification questions accept an answer from anyone in the group —
they are questions of fact, and the group is the authority on its own facts. **Approvals do not.** Only
the coordinator can approve a high-consequence write. A group member replying "yes" to an approval
request leaves it unresolved, and Baton routes the decision to the coordinator instead. Without this
rule, any volunteer could authorise a change to who controls the organisation's money.

**If the reply is ambiguous.** Baton asks once more, then routes the decision to the coordinator and
stops asking the group.

This is the human-in-the-loop boundary, and it should be visible in the video: an agent that knows the
limits of its own confidence reads as more trustworthy than one that is always sure.

## Architecture

Six Strands agents, each owning exactly one judgment, composed into a pipeline. Everything else is
deterministic code.

**Curator.** Input: one candidate message. Output: a classification — durable fact, commitment,
participation evidence, lifecycle event, or noise — and, where applicable, one or more extracted
records with a confidence score. Permitted and expected to return noise. This is the gate the whole
product depends on.

"Sunrise Clinic lets us settle at month end" is a durable fact. "I'll call the printers tomorrow" is a
commitment. "Thanks Anil and Meera for yesterday, we got fourteen done" is participation evidence. "If
we ever get a second van we could cover the east side" is noise — a conditional about a van that does
not exist, containing an asset, a capability and a place, and meaning nothing. That last case is why
this cannot be keyword matching. An extractor that feels obliged to find something in every message
produces a register full of jokes, so returning noise is a first-class outcome rather than a failure.

**Cartographer.** Input: extracted facts and the existing holdings map. Output: asset-to-holder
attributions, resolved identities, and updated coverage sets. Resolves aliases, handles, nicknames and
first names to one person, and records holdings as history rather than overwriting.

"Priya", "@priya_pc", "Pri" and "the coordinator" are one person. Sometimes the same string is two
people, and when it is, that ambiguity is the *output* rather than a coin flip — it becomes a question
rather than a guess. Holdings are recorded as history, so a transfer closes one row and opens another
and it remains possible to see who held the van keys in March.

**Assessor.** Input: the holdings map, coverage sets, and open commitments. Output: findings, each
with a subtype, a severity, an evidence set, and a confidence. Aggregates by capability area and
suppresses findings below an evidence threshold.

This is where counting stops and judgment starts. That the donation page has exactly one holder, and so
does the poster template, is arithmetic. That the first is serious and the second is not, that three
findings about foster placement are one problem about foster capacity, and that a finding resting on a
single throwaway message should not be raised at all — that is the work.

**Restraint.** Input: every finding the Assessor proposes, and every message the agent is about to
produce. Output: surface, or withhold with a recorded reason. Withheld items become quiet decisions
rather than silent drops. Restraint is an agent, but it is invoked from a hook on the produce path
rather than being called politely by the other agents, so the veto is structural and cannot be
bypassed. It gates at the point the text is produced, not at the point it is transmitted, because
transmission happens outside the agent — anything that reaches the sender has already passed Restraint.

There are exactly three produce paths and it attaches to all of them: findings from the Assessor, brief
lines from the Briefer, and answers from the Respondent. Findings are the cheapest to gate and the least
read; the brief and the answer are the two surfaces a human actually reads aloud. A Restraint wired only
into the finding path would leave those two ungated, which is precisely the failure the structural veto
exists to prevent.

**Briefer.** Input: a lifecycle event and the state of the register. Output: a three-section brief,
role-scoped by observed activity rather than by a declared org chart. The three sections are fixed:

1. **What only they held** — assets, relationships and credentials that now have no owner at all, or
   one remaining holder.
2. **What they had promised** — open commitments in their name, and undated intentions someone should
   now consciously decide about rather than inherit by accident.
3. **What nobody else has been seen doing** — capabilities where they were the only observed
   participant.

An arrival brief runs the same generator against the same three sections, scoped to what currently has
no owner or a single holder, and framed as where a new person is most needed. Same code, same shape,
different opening line. If a departing volunteer held nothing, the brief says so plainly rather than
rendering three empty sections.

**Respondent.** Input: a question addressed to Baton in the group, by mention or by replying to it.
Output: an answer carrying provenance and age, a statement that the fact is unknown, or a clarifying
question. Also handles the ambiguous-holder case, routing sensitive questions to the coordinator
privately rather than to the group. Requiring the question to be addressed is deliberate: a bot that
answers every sentence ending in a question mark in a twenty-person chat is a nuisance, and being
addressed is both a cleaner signal and cheaper than classifying every message.

Its most valuable outputs are the ones that are not answers — *that figure is five months old and
worth confirming*, *two people are recorded as holding this and I cannot tell which*, and plainly
*nobody has told me that*. A tool that only speaks when it is certain is a tool nobody can calibrate.

**Why six agents rather than one.** Each owns exactly one judgment, which keeps every prompt small and
every output schema flat — and flat schemas are what a cheap model can be trusted with. When something
comes out wrong, there is exactly one prompt to fix. It also makes the quality of the writing a purchasable
thing: the Curator carries most of the token volume, while the Assessor, Restraint and Briefer produce
the prose a reader actually judges, so those three can be pointed at a stronger model independently.

Deterministic code, not agents: the Telegram adapter, the message pre-filter, all storage, the admin
UI, session authentication, and scheduling.

The pre-filter deserves a note despite not being an agent, because it is what makes a year of history
affordable. Six months of a twenty-person group is roughly four and a half thousand messages, of which
about one in five merits a model's attention. It is tuned for recall rather than precision: wrongly
keeping "haha same" costs a fraction of a cent, while wrongly discarding "Sunrise Clinic lets us settle
at month end" loses that knowledge before anything was stored. Its verdicts are therefore versioned, so
improving the filter re-examines everything it previously rejected instead of leaving it lost.

### Strands usage map

The SDK's own abstractions must visibly do the work. Hand-rolled equivalents are not acceptable
substitutes, and this table belongs in the README so the thoroughness is legible rather than inferred.

| Strands capability | Where it is used |
| --- | --- |
| Multi-agent composition | The six-agent pipeline, each agent independently invocable |
| Structured output schemas | Curator classifications, finding subtypes and severities, brief sections |
| Session state and snapshots | Interrupt state persisted across invocations, so an approval asked today can be answered tomorrow |
| Hooks and interventions | The Restraint veto on every finding and every message the agent produces |
| Interrupts | The ask-instead-of-guess path for unknown facts and ambiguous holders, and the human-approval gate on uncertain high-consequence writes |
| Traces and metrics | Per-run reasoning and tool calls, surfaced in the agent activity panel |
| Tools | Read-only lookups against the worker's data API: fact search, evidence retrieval, holdings, identity resolution |

## Data model

Logical entities. Physical storage is an implementation-plan decision.

| Entity | Contents |
| --- | --- |
| `Person` | Display name, handle, aliases and nickname fragments for resolution, group membership status |
| `Message` | Sender, timestamp, text, reply-to, source flags (forwarded, edited, withdrawn, unprocessed) |
| `Fact` | Claim, asset reference, confidence, source message, stated-by, stated-at, last-confirmed-at, status (active, superseded, retired, unverified, pending approval), sensitivity, supersession chain |
| `Holding` | Asset, holder, asset kind, acquired-at, released-at, status (active, pending approval) — history, never overwritten |
| `Commitment` | Substance, owner or unowned, promised-at, deadline or undated, completion evidence, status |
| `CoverageSet` | Capability, the set of people ever observed doing it, evidence references |
| `Finding` | Type, subtype, severity, confidence, evidence references, status (open, resolved, dismissed), dismissal reason |
| `QuietDecision` | What was withheld, the reason, the run that produced it |
| `Brief` | Trigger event, subject person, the three sections, generated-at, read status, assignments |
| `Question` | Kind (verification, clarification, approval), the pending change it concerns, asked text, target (group or coordinator), asked-at (null while queued), answer, status (queued, asked, resolved, obsolete) |
| `Run` | Messages read, facts extracted, candidates skipped, findings produced, trace reference |

Six asset kinds: accounts and logins, physical items, financial control, relationships, documents, and
public presence.

## Functionalities

| ID | Functionality |
| --- | --- |
| F1 | Telegram bot receives group messages and normalises them to one internal shape |
| F2 | Seeded 6-month transcript enters through the same normaliser as live traffic, and covers every behaviour path in the seed coverage table |
| F3 | Telegram lifecycle events (joined, left) trigger brief generation autonomously |
| F4 | Forwarded messages attributed to the forwarder and flagged; edits arrive as corrections and re-run curation on that message; withdrawal of provenance is supported as a coordinator action, since Telegram does not report deletions to bots |
| F5 | Voice notes and images logged as unprocessed rather than silently dropped |
| F6 | Deterministic pre-filter reduces messages to candidates before the judgment layer |
| F7 | Curator classifies each candidate and extracts multiple records from one message where present |
| F8 | Merge on restatement, supersede on contradiction with history retained, retire on negation |
| F9 | Hearsay stored at low confidence and marked unverified, never as established |
| F10 | Relative dates resolved to absolute against the message timestamp |
| F11 | Conditionals, hypotheticals and jokes rejected as facts |
| F12 | Identity resolution across handles, display names, nicknames and first names |
| F13 | Holdings map maintained across the six asset kinds, as history |
| F14 | Coverage sets built from participation evidence, with no per-event attendance record |
| F15 | One-person risk findings in four subtypes: sole holder, no owner, not ours, loose end. A capability with a single observed participant presents as sole holder; an owned and an unowned loose end share one subtype and differ only in phrasing |
| F16 | Severity model over consequence, reversibility and urgency; confidence carried separately |
| F17 | Aggregation by capability area; suppression below an evidence threshold |
| F18 | Restraint withholds on all three produce paths — findings, brief lines, and answers — recording the reason as a quiet decision |
| F19 | Dismissal persists permanently, including "we already have a backup," with a visible dismissed list |
| F20 | Respondent answers operational questions in the group with provenance and age, when the question is addressed to Baton by mention or reply |
| F21 | Unknown or ambiguous cases become questions — to the group, or privately to the coordinator when sensitive |
| F22 | One-time introduction message on joining the group, stating what is and is not recorded |
| F23 | Three-section continuity brief generated on departure and on arrival |
| F24 | Brief offered to the departing volunteer as well as the coordinator — as copyable text the coordinator can pass on, and by direct message only where that person has previously opened a chat with the bot |
| F25 | Brief copyable as text; individual lines assignable as a record with no notification sent; past briefs retained |
| F26 | Admin UI: Continuity dashboard, Who holds what, Briefs |
| F27 | Fact detail panel reachable from any claim on any surface, quoting the source message verbatim |
| F28 | Agent activity panel exposing messages read, facts extracted, candidates skipped, and the run trace |
| F29 | Shared passcode exchanged for a signed session cookie |
| F30 | Secrets never stored as facts — only who holds them; credential-shaped strings redacted wherever a source message is quoted |
| F31 | Consequence classification on every write, so the approval gate can be applied |
| F32 | Human-approval gate: uncertain high-consequence writes are held pending and asked explicitly in chat, naming the action, the uncertainty, the evidence, and the effect of refusal |
| F33 | Pending changes are excluded from findings and briefs, never adopted on timeout, and never discarded |
| F34 | Approvals are answerable only by the coordinator; verification and clarification questions accept any group member's answer |
| F35 | Baton's own messages are excluded at intake, so it can never learn a fact from its own output |
| F36 | Ask budget: at most two open questions and three new ones per rolling 24 hours, queued in priority order — approval, clarification, verification — with nothing discarded |

## Admin UI

Three navigable places and two drill-down panels. One URL, one human user, desktop only.

**Continuity** is the dashboard and the landing screen. Top to bottom: header with last-run status and
navigation; the state of the organisation in one sentence; a since-you-last-looked diff; a slim line
for questions awaiting an answer — asked and queued alike, since both mean Baton is holding something
back; a new-brief banner when one is unread; the ranked register of five to eight finding cards; and the
quiet-decisions strip, expanded by default with a link to the full list.

Each finding card carries a title naming a capability rather than a person, a subtype badge, a one-line
statement of why it matters, a clickable evidence count, its confidence, the holder as a small
attribute, and three actions: resolve, we already have a backup, dismiss. The register footer links to
dismissed findings, so the coordinator can always distinguish hiding from forgetting.

**Who holds what** is a plain inventory grouped by asset kind, each row showing the claim, the holder,
how many people cover it, confidence, when it was last confirmed, and status. This is the "who has
what" spreadsheet chore, maintained automatically.

**Briefs** holds the current brief and every past one.

**Fact detail** opens as a panel over any screen, from any claim anywhere in the product. It shows the
claim and status, holder history, the source message quoted verbatim with sender and date, the
supersession chain, and Baton's stated reasoning for storing it. Actions: correct, retire, mark
verified. Reachability from everywhere is what makes the register trustworthy.

**Agent activity** is a slide-over from the header.

Empty states read as good news, not as errors. Vanity metrics live in the activity panel, never on the
dashboard, where they would compete with the findings.

Absent by design: no question box, no charts, no volunteer pages, no settings, no mobile layout.

A design constraint that governs the dashboard: a judge who pauses the video on this one screen should
understand the product without narration. The state line, the register and the quiet-decisions strip
must therefore fit the first viewport.

## Runtime flows

**Backfill.** The seeded transcript is normalised, pre-filtered, and passed through the Curator in
batches. Facts, holdings, commitments and coverage sets are built. The Assessor produces an initial
register. This establishes the history that makes every later claim about the past possible.

**Live message.** A message arrives. The pre-filter decides whether it is a candidate. The Curator
classifies it. Facts merge, supersede or retire. If a commitment closes, it closes. The register
updates incrementally.

**Question asked.** Baton is addressed by mention or reply. The Respondent resolves the question
against the fact store. A known fact is answered with provenance and age. A stale fact is answered with
a warning. An unknown becomes a question to the group, subject to the ask budget. An ambiguous holder
becomes a private question to the coordinator. Restraint gates the answer before it leaves the agent,
on the same produce path it gates findings and brief lines on.

**Lifecycle event.** Telegram reports a departure or arrival. The Briefer generates the brief from the
register. Restraint reviews it. It appears in the admin UI and is offered to the person concerned.

**Periodic sweep.** The Assessor re-derives findings, Restraint filters them, and quiet decisions are
recorded with their reasoning. The since-you-last-looked diff is computed from this.

## Safety and privacy properties

Baton never records a secret as a fact, only who holds one. Source messages are stored verbatim, since
they already exist in Telegram and provenance depends on them — but credential-shaped strings are
redacted at render time wherever a message is quoted, so a password pasted into the group never appears
in the fact detail panel or a brief. It never reports about an individual to the group. It never messages
a volunteer other than answering a question asked in the group, asking for an approval, or delivering a
handover to its subject. Facts are never auto-deleted; an unanswered verification lowers confidence only.

No uncertain high-consequence change is written without explicit human approval, and no pending change
is adopted by timeout. Silence therefore produces a visible gap rather than an invented fact. Approvals
are answerable only by the coordinator, so no volunteer can authorise a change to who controls the
organisation's money.

Baton's own messages are excluded at intake. Without this it would extract facts from its own answers,
and a stale figure it repeated once would return as a freshly confirmed fact — a corruption loop with no
visible symptom.

Findings are phrased about capabilities, never about people. No page in the product has a volunteer as
its subject. There are no comparisons between volunteers, no per-person reliability score, no
per-event attendance ledger, and no monitoring of inactivity. Restraint reasoning is item-level or
organisation-level, never a judgment about a person.

The observation constraint is binding: Baton may state that no other volunteer has been *seen* doing
something. It may never state that no one else *can*.

The admin UI holds a small organisation's operational data and is protected by a shared passcode
exchanged for a signed session cookie. The Telegram bot token is held in a secret store and never
committed.

## Demo plan

Seed data is generated, not collected: a six-month Telegram transcript for a twenty-person rescue,
written to read as genuinely human, with the planted cases woven in rather than appended. This is
substantial work and is scheduled as such, because every claim the product makes rests on it.

Six months rather than twelve. Twelve was never load-bearing — the oldest claim the demo needs to make
is that a figure has rotted, and five months does that as convincingly as eleven while halving the
Curator's volume, which is the dominant cost and the slowest step in every backfill iteration. Depth of
coverage matters far more than span: a six-month transcript that exercises every behaviour path is worth
more than a twelve-month one that exercises the five planted cases and nothing else.

### What the transcript must contain

The planted cases carry the video, but they exercise perhaps a fifth of the product. Every behaviour
that reads a message needs material to read, and a behaviour with no material in the transcript cannot
be demonstrated and has almost certainly never been tested. The transcript therefore carries a coverage
obligation, discharged by the seed script rather than by the author's memory: generation emits a coverage
report keyed to this table and fails if any row is unmatched.

| Path | Material required |
| --- | --- |
| Durable fact | A settlement arrangement, a number printed on something, an account whose holder is named |
| Commitment | One dated promise and one undated intention |
| Participation evidence | Post-event thanks naming several people, more than once |
| Lifecycle | One departure and one arrival inside the seeded window, before the live one |
| Noise | Jokes, agreement fragments, logistics chatter, and a conditional about something that does not exist |
| Pre-filter recall | A durable fact buried inside an otherwise chatty message, so a precision-tuned filter would lose it |
| Multiple records per message | One message carrying both a fact and a commitment |
| Restatement | The same fact stated again months later, in different words |
| Contradiction | A fact replaced by a later one — the clinic's terms change |
| Negation | An arrangement explicitly ended |
| Hearsay | Someone relaying what a third party said |
| Relative dates | "next Tuesday", "end of the month", "last week" |
| Identity | Every alias kind: handle, display name, nickname, first name, role reference |
| Ambiguity | One first name that resolves to two different people |
| Six asset kinds | At least one each: login, physical item, financial control, relationship, document, public presence |
| Transfer of holding | One asset changing hands cleanly, so holdings history carries a closed row |
| Personal resource | An asset that is actually someone's own property — the van |
| Commitment closure | A promise later evidenced as done |
| Capability coverage | One capability with several observed participants, one with exactly one |
| Aggregation | Three separate exposures inside a single capability area |
| Suppression | A candidate finding resting on one throwaway mention |
| Answerable question | An operational figure the coordinator is visibly asked more than once |
| Unknown | A question the transcript deliberately never answers |
| Credential exposure | A credential-shaped string pasted into the group |
| Media | A voice note and an image |
| Provenance edge cases | One forwarded message and one later edited |

Four planted cases form the spine of the demo, plus a fifth shown briefly:

1. **The orphan.** A volunteer leaves the group on camera. The brief appears unprompted, and the
   donation page has no owner — the person who set it up is the one who just left.
2. **The restraint.** A four-day-old promise is deliberately not raised, and the reasoning is on
   screen: undated, nothing blocked on it, and promises like this resolve within a week here.
3. **The stale answer.** Someone asks the sterilisation rate. Baton answers, and attaches that the
   figure is five months old and worth confirming.
4. **The provenance click.** A line in the brief is clicked, and the actual message from five months
   ago that produced it appears, with its sender and date.
5. **The approval.** Baton is about to record that financial control has changed hands on the strength
   of one ambiguous message. It stops, states what it is about to do and what it is unsure about, and
   asks before writing. Shown briefly, paired with the restraint case, since both are about the agent
   knowing its own limits.

### What the demo must prove

| Claim | Demonstrated by |
| --- | --- |
| Assets silently lose their owners | The orphan case, end to end |
| One person becomes the sole route to something critical | A sole-holder finding with its evidence count |
| Blanket reminder rules are wrong | The restraint case, with reasoning visible |
| Stored knowledge rots | The stale answer, with its date on screen |
| Every figure is accountable | The provenance click |
| It removes real repetitive work | The group answering a question the coordinator would have |
| It knows the limits of its own confidence | The approval case, asking before writing |

### Video contract

Under five minutes. The first fifteen seconds show a volunteer leaving a Telegram group and a handover
document writing itself — no dashboard tour, no architecture, no narration of features. The problem,
the audience and why it matters are stated within the first minute. The five planted cases follow in
order, against real infrastructure. The group-answering behaviour appears second, never first. One
line states the boundary out loud: it tracks what the organisation knows, not what its people do.

## Cut order under time pressure

Degrade in this order, and stop as soon as the schedule is recovered:

1. Coverage inference narrows to explicit thanks-lists only
2. Coverage input is dropped from findings, which then run on holdings alone
3. Identity resolution reduces to exact handle matching
4. The ask-instead-of-guess path becomes a logged question with a canned answer
5. Seeded history shrinks from six months to three, keeping every coverage row and compressing the
   span, with the stale figure rescaled so it still sits near the start of the window

Never cut, because they are the project: the Restraint behaviour and its visible reasoning, the
human-approval gate on uncertain high-consequence writes, one-person risk detection, provenance on every
claim, and the brief firing from a lifecycle event rather than a button.

## Deferred — Tier 2, only if ahead of schedule

Proactive stale-fact section in the register and the full verification loop. Plaintext-credential
exposure detection. Conflicting-holder resolution as a workflow. Transfers of holding as first-class
events.

## Submission deliverables

- Public repository with an MIT `LICENSE` file and a matching license field, detectable in the About
  section
- README covering setup, the judge passcode, the architecture, and the Strands usage map
- Architecture diagram
- Public video under five minutes, per the video contract
- Deployed live URL
- AWS Builder ID recorded on the submission
- Good Neighbor selected as the track

## Decisions taken

**Telegram over Discord and WhatsApp.** WhatsApp is what these organisations actually use but has no
viable API path. Discord has clean APIs but signals gaming and developer communities, and a judge
watching a rescue scenario in Discord registers the mismatch. Telegram is credible for community
groups and free to set up. The substitution is stated out loud in the video rather than hidden.

**Seeded history is by design, not a shortcut.** Telegram bots cannot read messages sent before they
joined a group, so historical backfill through the API is impossible. Since the product's claims are
claims about the past, seeded history is structurally necessary and is described that way in the README.

**Geolocated attendance was considered and rejected.** It is roughly two to three hours of work, but it
cannot be demonstrated — it needs real people at a real venue — so a video would have to spoof
coordinates, and a distance comparison adds no agent surface. Its underlying intent, knowing who does
what without anyone filling in a form, is served instead by coverage inference from conversation.

**Per-person reliability scoring was removed after being designed in.** Scoring volunteers is
surveillance however warmly framed, and it damages both the product and its reception. Restraint is
now justified by the commitment's own properties and by organisation-level norms, which is a more
defensible claim anyway, since a handful of observations could never support a judgment about a person.

**The question box was banned from the admin UI but kept in the group.** Answering repeat questions is
the most repetitive task in any volunteer group and satisfies the hackathon's requirement to take
repetitive work off a human. Placing it in the group chat keeps that value while preventing the admin
UI from reading as a retrieval product.

**Approval is asked in chat, not only in the admin UI.** The coordinator is a volunteer who checks a
dashboard weekly, not hourly, so a pending decision sitting in a web app would stall indefinitely. Chat
is where they already are. Two setup consequences, both documented as README prerequisites. A Telegram
bot cannot open a private conversation with someone who has never messaged it first, so the coordinator
must start a chat with the bot, and sensitive approvals fall back to a coordinator-addressed message in
the group if that has not happened — which is also why a departing volunteer's brief is offered as
copyable text rather than assumed deliverable. And the bot must be a group administrator with privacy
mode disabled, or it receives neither the membership events the brief fires from nor the messages it
reads.

**Event reconstruction was scoped out.** It was the strongest candidate for a fourth finding type, but
it requires the richest seeded history of anything considered and produces long-form output that is
hard to show in a five-minute video. It is recorded as future work.
