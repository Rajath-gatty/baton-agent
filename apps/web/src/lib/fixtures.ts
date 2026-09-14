/**
 * SYNTHETIC DEMONSTRATION DATA.
 *
 * Every name, message, amount and timestamp below is invented for demonstration.
 * It portrays a plausible small Indian street-animal rescue — roughly twenty
 * volunteers in Bengaluru, counting in INR, working in Asia/Kolkata, with about
 * six months of history in a single Telegram group that is the only written
 * record the group keeps.
 *
 * This file is the *content* behind the read seam in `data.ts`. When the Drizzle
 * schema lands, this file is deleted and `data.ts` reads rows instead. Nothing
 * in the UI imports from here directly; everything goes through `data.ts`.
 *
 * The set is deliberately awkward where awkwardness breaks layouts: a nullable
 * holder, a personal resource, a three-deep supersession chain, an unverified
 * hearsay fact, a message carrying a credential (so redaction is exercised) and
 * another carrying an Indian mobile number and an INR amount (which redaction
 * must leave intact), a queued question with no asked-at, assets across all six
 * kinds, and quiet decisions whose reasoning is about items and the
 * organisation, never a volunteer.
 */

import type {
  Asset,
  Brief,
  Commitment,
  Diff,
  Fact,
  Finding,
  Holding,
  Person,
  Question,
  QuietDecision,
  Run,
  SourceMessage,
} from "./types";

// ── people ──────────────────────────────────────────────────────────────────
// Present only to resolve holder names and lifecycle events. Never a subject.

export const people: Person[] = [
  { id: "p-anita", displayName: "Anita Verma", status: "member" },
  { id: "p-rahul", displayName: "Rahul Nair", status: "member" },
  { id: "p-priya", displayName: "Priya Menon", status: "left" },
  { id: "p-fatima", displayName: "Fatima Sheikh", status: "member" },
  { id: "p-deepak", displayName: "Deepak Rao", status: "member" },
  { id: "p-sana", displayName: "Sana Qureshi", status: "member" },
  { id: "p-vikram", displayName: "Vikram Iyer", status: "member" },
  { id: "p-meera", displayName: "Meera Joshi", status: "member" },
  { id: "p-arun", displayName: "Arun Pillai", status: "member" },
  { id: "p-lakshmi", displayName: "Lakshmi Reddy", status: "member" },
];

// ── source messages ───────────────────────────────────────────────────────
// Stored verbatim. Redaction happens at render, never here.

export const sourceMessages: SourceMessage[] = [
  {
    id: "m-clinic-1",
    authorName: "Deepak Rao",
    text: "Spoke to Dr Rao at Cessna Lifeline. He'll do our sterilisations at ₹1,200 a dog if we bring them before noon. Emergency line is 98450 32211.",
    sentAt: "2026-03-04T11:22:00+05:30",
  },
  {
    id: "m-clinic-2",
    authorName: "Deepak Rao",
    text: "Update: Dr Rao revised it. ₹1,000 per dog now that we're regulars, but only Tue/Thu mornings.",
    sentAt: "2026-05-19T09:41:00+05:30",
  },
  {
    id: "m-clinic-3",
    authorName: "Deepak Rao",
    text: "Final terms with the clinic: ₹1,000 per dog, Tue/Thu mornings, and they'll hold two slots for emergencies if we call the day before.",
    sentAt: "2026-08-27T18:03:00+05:30",
  },
  {
    id: "m-insta",
    authorName: "Priya Menon",
    text: "I've been running the @streetpaws.blr Instagram since we started. password is StreetP@ws2025 if anyone ever needs it — but honestly just ping me.",
    sentAt: "2026-02-11T20:15:00+05:30",
  },
  {
    id: "m-donations",
    authorName: "Anita Verma",
    text: "Reminder: the donation UPI is streetpaws@okhdfc. We crossed ₹1,45,000 for the monsoon shelter fund this week 🎉",
    sentAt: "2026-07-02T13:30:00+05:30",
  },
  {
    id: "m-van",
    authorName: "Vikram Iyer",
    text: "I can bring my own van for the Whitefield rescue Saturday. It's my personal vehicle so I'll need to be there to drive it.",
    sentAt: "2026-08-30T16:47:00+05:30",
  },
  {
    id: "m-f80g",
    authorName: "Anita Verma",
    text: "The 80G renewal paperwork is with our CA. Deadline is 30 Sept — someone needs to collect the signed forms from his office in Jayanagar.",
    sentAt: "2026-09-01T10:05:00+05:30",
  },
  {
    id: "m-forms",
    authorName: "Fatima Sheikh",
    text: "I'll get the adoption consent forms printed before the weekend drive. Have the design ready.",
    sentAt: "2026-08-22T21:12:00+05:30",
  },
  {
    id: "m-shelter",
    authorName: "Rahul Nair",
    text: "The Hennur landlord said he might raise the shelter rent next quarter, not sure by how much. Heard it second-hand from the watchman.",
    sentAt: "2026-09-05T19:20:00+05:30",
  },
  {
    id: "m-medicines",
    authorName: "Sana Qureshi",
    text: "Placed the monthly medicine order with the wholesaler on Sarjapur Road. ₹8,400 this time, paid from the shelter fund.",
    sentAt: "2026-09-08T12:00:00+05:30",
  },
  {
    id: "m-feeding",
    authorName: "Meera Joshi",
    text: "I've taken over the Koramangala 5th block feeding round from Priya. Same route, same timings.",
    sentAt: "2026-08-16T07:30:00+05:30",
  },
  {
    id: "m-mou",
    authorName: "Arun Pillai",
    text: "We should get the arrangement with BBMP for the ABC drive in writing before the next batch. Right now it's just a verbal understanding with one officer.",
    sentAt: "2026-09-10T15:44:00+05:30",
  },
];

const messageById = new Map(sourceMessages.map((m) => [m.id, m]));

function msg(id: string): SourceMessage {
  const found = messageById.get(id);
  if (!found) throw new Error(`fixture: unknown source message ${id}`);
  return found;
}

// ── facts ─────────────────────────────────────────────────────────────────
// Includes a three-deep supersession chain (clinic terms), one unverified
// hearsay fact, and one held for approval.

export const facts: Fact[] = [
  {
    id: "f-clinic-v3",
    status: "active",
    statement:
      "Cessna Lifeline sterilises the group's dogs at ₹1,000 per dog, Tuesday and Thursday mornings, holding two emergency slots on a day's notice.",
    sourceMessage: msg("m-clinic-3"),
    supersedes: "f-clinic-v2",
    topic: "Clinic — Dr Rao",
    recordedAt: "2026-08-27T18:05:00+05:30",
  },
  {
    id: "f-clinic-v2",
    status: "superseded",
    statement:
      "Cessna Lifeline sterilises the group's dogs at ₹1,000 per dog, Tuesday and Thursday mornings only.",
    sourceMessage: msg("m-clinic-2"),
    supersedes: "f-clinic-v1",
    topic: "Clinic — Dr Rao",
    recordedAt: "2026-05-19T09:43:00+05:30",
  },
  {
    id: "f-clinic-v1",
    status: "superseded",
    statement:
      "Cessna Lifeline sterilises the group's dogs at ₹1,200 per dog if brought before noon.",
    sourceMessage: msg("m-clinic-1"),
    supersedes: null,
    topic: "Clinic — Dr Rao",
    recordedAt: "2026-03-04T11:24:00+05:30",
  },
  {
    id: "f-insta",
    status: "active",
    statement: "The organisation's Instagram is @streetpaws.blr.",
    sourceMessage: msg("m-insta"),
    supersedes: null,
    topic: "Public presence — Instagram",
    recordedAt: "2026-02-11T20:17:00+05:30",
  },
  {
    id: "f-upi",
    status: "active",
    statement: "Donations are collected through the UPI handle streetpaws@okhdfc.",
    sourceMessage: msg("m-donations"),
    supersedes: null,
    topic: "Financial control — donations",
    recordedAt: "2026-07-02T13:32:00+05:30",
  },
  {
    id: "f-80g",
    status: "active",
    statement:
      "The 80G tax-exemption renewal is with the group's CA in Jayanagar; signed forms are due 30 September.",
    sourceMessage: msg("m-f80g"),
    supersedes: null,
    topic: "Document — 80G renewal",
    recordedAt: "2026-09-01T10:07:00+05:30",
  },
  {
    id: "f-rent-hearsay",
    status: "unverified",
    statement:
      "The Hennur shelter rent may rise next quarter (reported second-hand, amount unknown).",
    sourceMessage: msg("m-shelter"),
    supersedes: null,
    topic: "Shelter — Hennur",
    recordedAt: "2026-09-05T19:22:00+05:30",
  },
  {
    id: "f-mou-pending",
    status: "pending_approval",
    statement:
      "The BBMP ABC-drive arrangement should be put in writing before the next batch (currently a verbal understanding with one officer).",
    sourceMessage: msg("m-mou"),
    supersedes: null,
    topic: "Relationship — BBMP",
    recordedAt: "2026-09-10T15:46:00+05:30",
  },
  {
    id: "f-feeding",
    status: "active",
    statement: "The Koramangala 5th-block feeding round runs the established route and timings.",
    sourceMessage: msg("m-feeding"),
    supersedes: null,
    topic: "Route — Koramangala feeding",
    recordedAt: "2026-08-16T07:32:00+05:30",
  },
];

// ── assets ──────────────────────────────────────────────────────────────────
// One of each of the six ASSET_KINDS.

export const assets: Asset[] = [
  {
    id: "a-insta",
    kind: "public_presence",
    sensitivity: "normal",
    label: "Instagram — @streetpaws.blr",
    description: "The group's only public channel; ~9k followers, source of most adoptions.",
    recordedAt: "2026-02-11T20:17:00+05:30",
  },
  {
    id: "a-insta-login",
    kind: "account_login",
    sensitivity: "sensitive",
    label: "Instagram login",
    description: "The credentials that control the @streetpaws.blr account.",
    recordedAt: "2026-02-11T20:17:00+05:30",
  },
  {
    id: "a-van",
    kind: "physical_item",
    sensitivity: "normal",
    label: "Rescue transport — Whitefield drives",
    description: "A vehicle relied on for the Whitefield rescue runs.",
    recordedAt: "2026-08-30T16:49:00+05:30",
  },
  {
    id: "a-upi",
    kind: "financial_control",
    sensitivity: "sensitive",
    label: "Donation UPI — streetpaws@okhdfc",
    description: "Where all public donations land.",
    recordedAt: "2026-07-02T13:32:00+05:30",
  },
  {
    id: "a-bbmp",
    kind: "relationship",
    sensitivity: "normal",
    label: "BBMP — ABC drive contact",
    description: "The municipal contact permitting the animal birth-control drives.",
    recordedAt: "2026-09-10T15:46:00+05:30",
  },
  {
    id: "a-80g",
    kind: "document",
    sensitivity: "normal",
    label: "80G renewal paperwork",
    description: "The tax-exemption certificate the group's donors rely on.",
    recordedAt: "2026-09-01T10:07:00+05:30",
  },
];

// ── holdings ─────────────────────────────────────────────────────────────
// One with holder=null (a loose end); one personal resource (Vikram's own van).

export const holdings: Holding[] = [
  {
    id: "h-insta",
    assetId: "a-insta-login",
    holder: "Priya Menon",
    isPersonalResource: false,
    lastSeenAt: "2026-08-01T20:15:00+05:30",
    note: "Only person seen posting from or logging into the account.",
  },
  {
    id: "h-upi",
    assetId: "a-upi",
    holder: "Anita Verma",
    isPersonalResource: false,
    lastSeenAt: "2026-09-08T12:00:00+05:30",
    note: "Seen reconciling the donation account each week.",
  },
  {
    id: "h-van",
    assetId: "a-van",
    holder: "Vikram Iyer",
    isPersonalResource: true,
    lastSeenAt: "2026-08-30T16:47:00+05:30",
    note: "Personal vehicle lent for rescue runs; the organisation does not own it.",
  },
  {
    id: "h-bbmp",
    assetId: "a-bbmp",
    holder: null,
    isPersonalResource: false,
    lastSeenAt: null,
    note: "No one has been seen to formally hold this relationship; it rests on a verbal understanding.",
  },
  {
    id: "h-80g",
    assetId: "a-80g",
    holder: "Anita Verma",
    isPersonalResource: false,
    lastSeenAt: "2026-09-01T10:05:00+05:30",
    note: "Seen coordinating the renewal with the CA.",
  },
];

// ── findings ─────────────────────────────────────────────────────────────
// 7 open across all four subtypes and mixed severities, plus 2 dismissed.

export const findings: Finding[] = [
  {
    id: "fd-insta",
    subtype: "sole_holder",
    severity: "high",
    status: "open",
    title: "Only one person has been seen to operate the Instagram account",
    whyItMatters:
      "Instagram is the group's only public channel and the source of most adoptions. If access is lost, the reach the group has built is unreachable.",
    evidenceCount: 4,
    confidence: 0.88,
    holderName: "Priya Menon",
    dedupeKey: "sole_holder:a-insta-login",
    firstSeenAt: "2026-02-12T02:00:00+05:30",
    lastSeenAt: "2026-09-13T02:00:00+05:30",
    assessorReasoning:
      "Every post and every login in the record traces to a single volunteer; no second person has been seen exercising the account.",
    dismissalReason: null,
  },
  {
    id: "fd-upi",
    subtype: "sole_holder",
    severity: "high",
    status: "open",
    title: "Donation reconciliation has been seen done by one person only",
    whyItMatters:
      "All public donations land in one UPI account. If reconciliation stalls, the monsoon shelter fund cannot be accounted for to donors.",
    evidenceCount: 6,
    confidence: 0.81,
    holderName: "Anita Verma",
    dedupeKey: "sole_holder:a-upi",
    firstSeenAt: "2026-07-03T02:00:00+05:30",
    lastSeenAt: "2026-09-09T02:00:00+05:30",
    assessorReasoning:
      "Weekly reconciliation messages come from one volunteer across the whole window; no hand-off has been recorded.",
    dismissalReason: null,
  },
  {
    id: "fd-bbmp",
    subtype: "no_owner",
    severity: "medium",
    status: "open",
    title: "The BBMP drive arrangement has no recorded owner",
    whyItMatters:
      "The animal birth-control drives depend on a municipal understanding that no one has been seen to formally hold. A staff change at BBMP could end it with no one positioned to renew it.",
    evidenceCount: 2,
    confidence: 0.7,
    holderName: null,
    dedupeKey: "no_owner:a-bbmp",
    firstSeenAt: "2026-09-11T02:00:00+05:30",
    lastSeenAt: "2026-09-13T02:00:00+05:30",
    assessorReasoning:
      "The arrangement is referenced as verbal and unassigned; no message shows a volunteer taking responsibility for it.",
    dismissalReason: null,
  },
  {
    id: "fd-van",
    subtype: "not_ours",
    severity: "medium",
    status: "open",
    title: "Whitefield transport depends on a vehicle the organisation does not own",
    whyItMatters:
      "The Saturday rescue runs rely on a personal van that comes with its owner. If the owner is unavailable, the run has no transport of its own to fall back on.",
    evidenceCount: 1,
    confidence: 0.76,
    holderName: "Vikram Iyer",
    dedupeKey: "not_ours:a-van",
    firstSeenAt: "2026-08-31T02:00:00+05:30",
    lastSeenAt: "2026-08-31T02:00:00+05:30",
    assessorReasoning:
      "The vehicle is stated to be personal and to require its owner present to drive; the organisation holds no transport of its own for this run.",
    dismissalReason: null,
  },
  {
    id: "fd-80g",
    subtype: "loose_end",
    severity: "high",
    status: "open",
    title: "The 80G signed forms are unfiled with a fixed deadline approaching",
    whyItMatters:
      "The tax-exemption renewal is due 30 September and the signed forms are still to be collected. If the deadline passes, donors lose their exemption and giving is likely to fall.",
    evidenceCount: 1,
    confidence: 0.84,
    holderName: "Anita Verma",
    dedupeKey: "loose_end:f-80g",
    firstSeenAt: "2026-09-02T02:00:00+05:30",
    lastSeenAt: "2026-09-13T02:00:00+05:30",
    assessorReasoning:
      "A committed action with a stated deadline has no message confirming completion, and the deadline is within the month.",
    dismissalReason: null,
  },
  {
    id: "fd-forms",
    subtype: "loose_end",
    severity: "low",
    status: "open",
    title: "Adoption consent forms were to be printed before the drive with no confirmation",
    whyItMatters:
      "A volunteer committed to printing the consent forms before the weekend drive; no message confirms it was done. Without them the drive can still run, but adoptions may be delayed.",
    evidenceCount: 1,
    confidence: 0.58,
    holderName: "Fatima Sheikh",
    dedupeKey: "loose_end:m-forms",
    firstSeenAt: "2026-08-23T02:00:00+05:30",
    lastSeenAt: "2026-09-13T02:00:00+05:30",
    assessorReasoning:
      "A near-term commitment with no confirming follow-up; low severity because the drive is not blocked on it.",
    dismissalReason: null,
  },
  {
    id: "fd-rent",
    subtype: "no_owner",
    severity: "low",
    status: "open",
    title: "A possible shelter-rent rise has no one tracking it",
    whyItMatters:
      "A second-hand report of a rent increase at the Hennur shelter is unassigned and unverified. If it turns real and unwatched, it could strain the shelter fund without warning.",
    evidenceCount: 1,
    confidence: 0.45,
    holderName: null,
    dedupeKey: "no_owner:f-rent-hearsay",
    firstSeenAt: "2026-09-06T02:00:00+05:30",
    lastSeenAt: "2026-09-13T02:00:00+05:30",
    assessorReasoning:
      "Reported second-hand with no amount and no volunteer following up; raised at low severity pending verification.",
    dismissalReason: null,
  },
  {
    id: "fd-medicine-dismissed",
    subtype: "sole_holder",
    severity: "low",
    status: "dismissed",
    title: "Medicine ordering had appeared to rest with one person",
    whyItMatters: "The monthly medicine order is placed with one wholesaler by one volunteer.",
    evidenceCount: 3,
    confidence: 0.52,
    holderName: "Sana Qureshi",
    dedupeKey: "sole_holder:medicine-order",
    firstSeenAt: "2026-06-10T02:00:00+05:30",
    lastSeenAt: "2026-09-09T02:00:00+05:30",
    assessorReasoning: "Ordering messages came from one volunteer across three months.",
    dismissalReason: "we already have a backup",
  },
  {
    id: "fd-feeding-dismissed",
    subtype: "loose_end",
    severity: "low",
    status: "dismissed",
    title: "A feeding-round hand-off had looked incomplete",
    whyItMatters: "The Koramangala feeding round changed hands without a formal record.",
    evidenceCount: 2,
    confidence: 0.4,
    holderName: null,
    dedupeKey: "loose_end:feeding-handoff",
    firstSeenAt: "2026-08-16T02:00:00+05:30",
    lastSeenAt: "2026-08-20T02:00:00+05:30",
    assessorReasoning: "A route hand-off was mentioned without a confirming acknowledgement.",
    dismissalReason: "the hand-off was confirmed in the drive the following week",
  },
];

// ── questions ────────────────────────────────────────────────────────────
// One queued (asked_at=null), one asked.

export const questions: Question[] = [
  {
    id: "q-insta-backup",
    kind: "clarification",
    status: "queued",
    text: "Has anyone besides the current operator posted from or logged into the Instagram account this year?",
    rationale:
      "To confirm whether the account genuinely rests with one person before the finding is settled.",
    factId: "f-insta",
    createdAt: "2026-09-12T09:00:00+05:30",
    askedAt: null,
  },
  {
    id: "q-80g-status",
    kind: "verification",
    status: "asked",
    text: "Have the signed 80G forms been collected from the CA's office yet?",
    rationale:
      "The renewal deadline is 30 September; confirmation would close or escalate the loose end.",
    factId: "f-80g",
    createdAt: "2026-09-11T10:00:00+05:30",
    askedAt: "2026-09-11T10:30:00+05:30",
  },
];

// ── quiet decisions ────────────────────────────────────────────────────────
// Restraint made visible. Reasoning is item-level or org-level, never a person.

export const quietDecisions: QuietDecision[] = [
  {
    id: "qd-van-second",
    summary: "Did not raise a second finding for the van's keys.",
    reasoning:
      "The transport dependency is already captured as one finding about the run; a separate finding about the keys would fragment the same exposure into two rows and read as noise.",
    scope: "item",
    decidedAt: "2026-08-31T02:05:00+05:30",
  },
  {
    id: "qd-medicine",
    summary: "Did not flag the medicine order as a sole-holder exposure.",
    reasoning:
      "A backup arranger for the wholesaler order is on record, so the capability is not single-covered; raising it would overstate the risk.",
    scope: "item",
    decidedAt: "2026-09-09T02:05:00+05:30",
  },
  {
    id: "qd-rent-amount",
    summary: "Did not state a rent figure for the Hennur shelter.",
    reasoning:
      "The register does not assert amounts that reach it second-hand and unconfirmed; putting a number on the sheet would give a rumour the weight of a fact.",
    scope: "org",
    decidedAt: "2026-09-06T02:05:00+05:30",
  },
];

// ── briefs ──────────────────────────────────────────────────────────────────
// Two briefs, one unread, each with the three fixed sections.

export const briefs: Brief[] = [
  {
    id: "b-priya",
    title: "Priya stepped back — 14 Aug",
    trigger: "A volunteer left the group.",
    generatedAt: "2026-08-14T21:00:00+05:30",
    read: false,
    sections: {
      only_they_held: [
        {
          text: "The Instagram account had been operated by only this departing volunteer in the record.",
          factId: "f-insta",
        },
        {
          text: "The Koramangala 5th-block feeding round had run under them until this week.",
          factId: "f-feeding",
        },
      ],
      they_had_promised: [
        {
          text: "No open commitment was left unfulfilled at the point of departure.",
          factId: null,
        },
      ],
      nobody_else_seen: [
        {
          text: "Nobody else has been seen posting from the Instagram account.",
          factId: "f-insta",
        },
      ],
    },
  },
  {
    id: "b-quarter",
    title: "Quarter close — 30 Jun",
    trigger: "The quarterly review point.",
    generatedAt: "2026-06-30T20:00:00+05:30",
    read: true,
    sections: {
      only_they_held: [
        {
          text: "Donation reconciliation had been carried by one volunteer through the quarter.",
          factId: "f-upi",
        },
      ],
      they_had_promised: [
        {
          text: "The clinic terms were to be renegotiated; this later completed.",
          factId: "f-clinic-v3",
        },
      ],
      nobody_else_seen: [
        {
          text: "Nobody else has been seen reconciling the donation account.",
          factId: "f-upi",
        },
      ],
    },
  },
];

// ── commitments ──────────────────────────────────────────────────────────

export const commitments: Commitment[] = [
  {
    id: "c-forms",
    text: "The adoption consent forms would be printed before the weekend drive.",
    byName: "Fatima Sheikh",
    madeAt: "2026-08-22T21:12:00+05:30",
    dueAt: "2026-08-29T00:00:00+05:30",
    fulfilled: false,
    sourceMessageId: "m-forms",
  },
  {
    id: "c-80g",
    text: "The signed 80G forms would be collected from the CA's office.",
    byName: "Anita Verma",
    madeAt: "2026-09-01T10:05:00+05:30",
    dueAt: "2026-09-30T00:00:00+05:30",
    fulfilled: false,
    sourceMessageId: "m-f80g",
  },
];

// ── the since-you-last-looked diff ─────────────────────────────────────────

export const diffs: Diff[] = [
  {
    id: "d-mou",
    kind: "added",
    text: "A new exposure: the BBMP drive arrangement has no recorded owner.",
    factId: "f-mou-pending",
    at: "2026-09-11T02:00:00+05:30",
  },
  {
    id: "d-clinic",
    kind: "changed",
    text: "The clinic terms were superseded — emergency slots are now held on a day's notice.",
    factId: "f-clinic-v3",
    at: "2026-08-27T18:05:00+05:30",
  },
  {
    id: "d-medicine",
    kind: "resolved",
    text: "The medicine-ordering exposure was dismissed — a backup arranger is on record.",
    factId: null,
    at: "2026-09-09T02:00:00+05:30",
  },
  {
    id: "d-rent",
    kind: "withheld",
    text: "A rumoured rent rise was noted but no amount was recorded.",
    factId: "f-rent-hearsay",
    at: "2026-09-06T02:05:00+05:30",
  },
];

// ── runs ─────────────────────────────────────────────────────────────────
// One with a trace array matching core's TraceEntry shape.

export const runs: Run[] = [
  {
    id: "r-2026-09-13",
    startedAt: "2026-09-13T18:00:00+05:30",
    finishedAt: "2026-09-13T18:04:12+05:30",
    messagesConsidered: 37,
    factsRecorded: 2,
    findingsTouched: 3,
    status: "complete",
    trace: [
      {
        node: "curator",
        model: "claude-haiku",
        inputTokens: 4820,
        outputTokens: 610,
        durationMs: 1840,
        reasoning: "37 messages classified; 4 durable, 31 noise, 2 commitments.",
      },
      {
        node: "cartographer",
        model: "claude-sonnet",
        inputTokens: 3110,
        outputTokens: 420,
        durationMs: 2210,
        toolCalls: [{ name: "resolve_holder", argsSummary: "BBMP officer", ok: true }],
        reasoning: "Mapped the BBMP arrangement to a relationship asset with no holder.",
      },
      {
        node: "assessor",
        model: "claude-sonnet",
        inputTokens: 5240,
        outputTokens: 780,
        durationMs: 3050,
        reasoning: "Raised a no-owner finding for the BBMP arrangement.",
      },
      {
        node: "restraint",
        model: "claude-sonnet",
        inputTokens: 2600,
        outputTokens: 240,
        durationMs: 1420,
        reasoning: "Withheld a rent amount reported second-hand; recorded the decision.",
      },
    ],
  },
  {
    id: "r-2026-09-11",
    startedAt: "2026-09-11T18:00:00+05:30",
    finishedAt: "2026-09-11T18:03:41+05:30",
    messagesConsidered: 22,
    factsRecorded: 1,
    findingsTouched: 1,
    status: "complete",
    trace: [
      {
        node: "curator",
        model: "claude-haiku",
        inputTokens: 3010,
        outputTokens: 380,
        durationMs: 1290,
        reasoning: "22 messages classified; 1 durable, 21 noise.",
      },
    ],
  },
];

// ── the one-sentence state of the organisation ─────────────────────────────

export const stateSentence =
  "Seven exposures stand open — three of them where a capability the group relies on has been seen in one pair of hands.";
