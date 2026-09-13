/**
 * The placements: an explicit, authored message for every coverage row and every
 * planted case — which message carries it, on which date, from whom.
 *
 * These texts are verbatim and the renderer never paraphrases them. That is the whole
 * reason the plan is a separate phase: a model asked to make the hearsay message read
 * more naturally can silently destroy the only hearsay material in six months, and the
 * transcript would still look fine. Filler chatter is where a model's texture belongs,
 * and filler carries no coverage obligation.
 *
 * The planted cases are **woven through** rather than appended. The donation-page
 * message that produces the orphan finding is also the message the provenance click
 * lands on, and it sits in April where it has to be for the brief line to be five
 * months old on camera.
 *
 * Dates are load-bearing in three places:
 *   - the sterilisation figure is stated in **April**, so it is five months stale when
 *     the video is recorded;
 *   - the restraint promise is made on **9 September**, four days before recording;
 *   - the seeded departure and arrival both sit **inside** the window, so the brief has
 *     fired twice before it fires on camera.
 */

import type { CoverageRow, PlannedMessage, PlantedCase } from "./plan-types.js";

export const WINDOW_START = "2026-03-15";
export const WINDOW_END = "2026-09-12";

/** The seeded lifecycle events, before the live one. */
export const SEEDED_DEPARTURE = { personId: "p08", date: "2026-06-18" } as const;
export const SEEDED_ARRIVAL = { personId: "p20", date: "2026-07-06" } as const;

interface Extra {
  cases?: PlantedCase[];
  flags?: PlannedMessage["flags"];
}

type Draft = Omit<PlannedMessage, "id">;

function m(
  date: string,
  minute: number,
  senderId: string,
  text: string,
  coverage: CoverageRow[],
  note: string,
  extra: Extra = {},
): Draft {
  return {
    date,
    minute,
    senderId,
    text,
    coverage,
    cases: extra.cases ?? [],
    flags: extra.flags ?? {},
    note,
  };
}

const DRAFTS: Draft[] = [
  // ───────────────────────────────────────────────────────────────────────────────
  // March — the window opens. Durable facts about the standing arrangements.
  // ───────────────────────────────────────────────────────────────────────────────
  m(
    "2026-03-18",
    645,
    "p01",
    "Confirmed with Sunrise Clinic — they'll let us settle at the end of each month instead of paying per visit. Dr Menon signed off on it.",
    ["durable_fact", "six_asset_kinds"],
    "The settlement arrangement. Restated in July, contradicted in August.",
  ),
  m(
    "2026-03-20",
    1140,
    "p05",
    "Reminder for everyone: the van is my own car, not the rescue's. Happy to drive but please don't commit it without asking me first.",
    ["personal_resource", "six_asset_kinds"],
    "Personal resource. Must render as not_ours rather than a one-person risk.",
  ),
  m(
    "2026-03-24",
    1005,
    "p01",
    "The emergency number on the new posters is +91 98450 33221. Two hundred of them are already up around Indiranagar so we cannot change it now.",
    ["durable_fact", "six_asset_kinds"],
    "A number printed on something. Also the redaction negative case: this must survive.",
  ),
  m(
    "2026-03-26",
    780,
    "p10",
    "I keep the foster carer list in my own spreadsheet, it's easier than the shared drive. Ping me if you need a placement and I'll check who's free.",
    ["durable_fact", "six_asset_kinds", "aggregation"],
    "Foster spreadsheet held by one person. First of three exposures in foster placement.",
  ),
  m(
    "2026-03-29",
    1215,
    "p13",
    "If we ever get a second van we could cover the east side properly on camp days.",
    ["noise"],
    "A conditional about something that does not exist. Contains an asset, a capability and a place, and means nothing.",
  ),

  // ───────────────────────────────────────────────────────────────────────────────
  // April — the donation page (orphan + provenance click) and the stale figure.
  // ───────────────────────────────────────────────────────────────────────────────
  m(
    "2026-04-08",
    1125,
    "p02",
    "Set up the Razorpay donation page this evening, it's live now. It's registered under my name and my number, so anything about payouts comes to me.",
    ["durable_fact", "six_asset_kinds"],
    "THE ORPHAN and THE PROVENANCE CLICK. Meera is the account that leaves on camera; five months before recording.",
    { cases: ["orphan", "provenance_click"] },
  ),
  m(
    "2026-04-09",
    600,
    "p01",
    "Brilliant, thank you Meeru. Everyone please share that link and not the old bank details.",
    ["identity_all_alias_kinds", "noise"],
    "Nickname reference. Also an agreement fragment, which is noise.",
  ),
  m(
    "2026-04-13",
    1260,
    "p04",
    "Final count from the March camp: our sterilisation rate is running at 62 animals a month across both clinics.",
    ["durable_fact", "answerable_question"],
    "THE STALE ANSWER. Five months old on recording day. Never restated.",
    { cases: ["stale_answer"] },
  ),
  m(
    "2026-04-15",
    855,
    "p03",
    "Thanks Kavya, Farhan and Vikram for Sunday — we got fourteen adoptions done and the stall was spotless by six.",
    ["participation_evidence", "capability_coverage"],
    "Post-event thanks naming several people. First of two.",
  ),
  m(
    "2026-04-18",
    1020,
    "p06",
    "Can someone bring the adoption agreement template on Sunday? Also I'll call the printers on Tuesday about the reprint.",
    ["multiple_records_per_message", "commitment", "relative_dates", "six_asset_kinds"],
    "One message carrying both a fact reference and a dated commitment, with a relative date.",
  ),
  m(
    "2026-04-23",
    735,
    "p06",
    "Printers sorted — reprint is done and collected, they're in the boot of the van.",
    ["commitment_closure"],
    "The Tuesday promise, later evidenced as done.",
  ),
  m(
    "2026-04-27",
    1305,
    "p07",
    "I'll take the microchipping again at the next camp, I've got the hang of the scanner now.",
    ["capability_coverage"],
    "Microchipping: Farhan is the only person ever named doing it. The capability variant of sole_holder.",
  ),

  // ───────────────────────────────────────────────────────────────────────────────
  // May — identity, hearsay, ambiguity, media, credentials.
  // ───────────────────────────────────────────────────────────────────────────────
  m(
    "2026-05-04",
    915,
    "p12",
    "@priya_pc the coordinator said we should route new intakes through triage first — Priya Raghavan can confirm.",
    ["identity_all_alias_kinds"],
    "Handle, role reference and display name for one person in a single message.",
  ),
  m(
    "2026-05-06",
    1080,
    "p11",
    "What's our sterilisation rate these days? Someone asked at the stall and I had no idea what to say.",
    ["answerable_question"],
    "The operational figure asked the first time.",
  ),
  m(
    "2026-05-11",
    690,
    "p09",
    "Voice note about the Whitefield pickup",
    ["media"],
    "A voice note. Logged with unprocessed rather than dropped.",
    { flags: { media: "voice" } },
  ),
  m(
    "2026-05-13",
    1170,
    "p16",
    "Photo from today's intake",
    ["media"],
    "An image. The other half of the media row.",
    { flags: { media: "photo" } },
  ),
  m(
    "2026-05-19",
    825,
    "p14",
    "Kavya told me the vet said we shouldn't schedule sterilisations within ten days of a vaccination. Passing it on, I haven't checked myself.",
    ["hearsay"],
    "Someone relaying what a third party said. Must be written unverified and stay out of detection.",
  ),
  m(
    "2026-05-21",
    1245,
    "p19",
    "Anyone know the Green Paws contact's number? I want to ask about the sponsorship renewal.",
    ["unknown"],
    "A question the transcript deliberately never answers.",
  ),
  m(
    "2026-05-23",
    960,
    "p18",
    "Forwarded: the BBMP notice about the new licensing rules for rescues, worth a read before the next camp.",
    ["provenance_forwarded_and_edited"],
    "Forwarded message. Attributed to the forwarder and flagged.",
    { flags: { forwarded: true, forwardedFrom: "BBMP Animal Husbandry" } },
  ),
  m(
    "2026-05-27",
    1035,
    "p13",
    "Priya has the microchip scanner I think, she took it after the last camp.",
    ["ambiguity_one_name_two_people"],
    "Two people answer to Priya. Ambiguity is the output, not a coin flip.",
  ),
  m(
    "2026-05-29",
    1290,
    "p02",
    "Instagram login for the page — the password is Paws@Rescue2026! if anyone needs to post while I'm away.",
    ["credential_exposure", "six_asset_kinds"],
    "A credential-shaped string pasted into the group. Stored verbatim, redacted wherever quoted.",
  ),

  // ───────────────────────────────────────────────────────────────────────────────
  // June — the seeded transfer, the seeded departure, pre-filter recall.
  // ───────────────────────────────────────────────────────────────────────────────
  m(
    "2026-06-03",
    750,
    "p17",
    "Long day. Three pickups, one of them a Lab mix from a construction site who was terrified, and my scooter has a flat. Anyway — Green Paws have agreed to sponsor the food for the next two camps, I got that in writing from Deepak.",
    ["prefilter_recall", "durable_fact", "six_asset_kinds"],
    "A durable fact buried inside an otherwise chatty message. A precision-tuned filter would lose it.",
  ),
  m(
    "2026-06-14",
    1155,
    "p01",
    "Huge thanks to Sneha, Aisha, Gopal and Harish for the camp yesterday — 41 animals, longest day we've had, and nobody complained once.",
    ["participation_evidence", "capability_coverage"],
    "Post-event thanks naming several people, the second time. Satisfies 'more than once'.",
  ),
  m(
    "2026-06-16",
    870,
    "p08",
    "Handing the microchip scanner over to Farhan today since I'm stepping back — he's used it more than me anyway.",
    ["transfer_of_holding"],
    "One asset changing hands cleanly, so holdings history carries a closed row.",
  ),
  m(
    "2026-06-18",
    1110,
    "p08",
    "Everyone, I'm moving to Pune next month so I'm stepping away from the rescue. It's been three good years. Please keep me on the list for the adoption day photos.",
    ["lifecycle"],
    "The seeded departure, inside the window and before the live one.",
  ),
  m(
    "2026-06-24",
    645,
    "p10",
    "Placed the three puppies from the Domlur intake with the Kulkarnis. That's the fourth placement I've handled this month, my spreadsheet is getting long.",
    ["aggregation"],
    "Second of three exposures inside foster placement.",
  ),
  m(
    "2026-06-29",
    1320,
    "p11",
    "haha the cat did NOT agree with that assessment",
    ["noise"],
    "A joke. Noise as a first-class outcome.",
  ),

  // ───────────────────────────────────────────────────────────────────────────────
  // July — the arrival, restatement, the edited message, suppression material.
  // ───────────────────────────────────────────────────────────────────────────────
  m(
    "2026-07-06",
    600,
    "p20",
    "Hi all! Ananya here, Sneha mentioned you needed help with transport on weekends. Happy to start wherever's useful.",
    ["lifecycle"],
    "The seeded arrival. The arrival brief has fired before it fires on camera.",
  ),
  m(
    "2026-07-14",
    1065,
    "p15",
    "Might've left the scanner at the clinic, not sure",
    ["suppression"],
    "A candidate finding resting on one throwaway mention. Must be suppressed, not raised.",
  ),
  m(
    "2026-07-18",
    930,
    "p03",
    "Meeting Deepak at Green Paws next Tuesday about the renewal, and I'll have the numbers ready by end of the month.",
    ["relative_dates", "commitment"],
    "'next Tuesday' and 'end of the month', resolved against IST rather than UTC.",
  ),
  m(
    "2026-07-22",
    795,
    "p01",
    "For the new folks — we don't pay Sunrise per visit. They invoice us once a month and we clear it at month end. Has been that way since March.",
    ["restatement"],
    "The same fact stated again months later in different words. Bumps last_confirmed_at; must not insert a row.",
  ),
  m(
    "2026-07-27",
    1185,
    "p18",
    "Posted the adoption day album to Instagram, 2000 views already",
    ["provenance_forwarded_and_edited"],
    "Later edited. The facts the old text produced are superseded rather than mutated.",
    { flags: { editedTo: "Posted the adoption day album to Instagram, 4000 views already" } },
  ),
  m(
    "2026-07-30",
    1230,
    "p12",
    "Sorry to ask again but does anyone have the current sterilisation rate? The Green Paws form needs it.",
    ["answerable_question"],
    "The same operational figure asked a second time. This is what makes the coordinator's repetition visible.",
  ),

  // ───────────────────────────────────────────────────────────────────────────────
  // August — contradiction, negation, third foster exposure.
  // ───────────────────────────────────────────────────────────────────────────────
  m(
    "2026-08-04",
    1080,
    "p10",
    "Two more placements this week, both through carers I know personally rather than the list. I should really write down who's actually active.",
    ["aggregation"],
    "Third of three exposures inside foster placement. Three separate exposures, one problem.",
  ),
  m(
    "2026-08-11",
    885,
    "p01",
    "Heads up, Sunrise have changed their terms — it's fifteen days from invoice now, not month end. Effective from this month's bill.",
    ["contradiction"],
    "A fact replaced by a later one. New row with supersedes_fact_id set, not a mutation.",
  ),
  m(
    "2026-08-19",
    1005,
    "p07",
    "Did the microchipping at the camp last week, 22 done. Nobody else has been trained on the scanner yet.",
    ["capability_coverage", "relative_dates"],
    "Reinforces the single-participant capability without ever characterising anyone. Also carries 'last week'.",
  ),
  m(
    "2026-08-25",
    1140,
    "p03",
    "Green Paws are not renewing the sponsorship. Deepak confirmed it today, so that arrangement is finished as of this month.",
    ["negation"],
    "An arrangement explicitly ended. Retires the fact rather than superseding it.",
  ),
  m(
    "2026-08-28",
    720,
    "p16",
    "ok",
    ["noise"],
    "An agreement fragment. The single most common message shape in any group chat.",
  ),
  m(
    "2026-08-31",
    1275,
    "p19",
    "Van's at the service centre till Thursday so no pickups from my side, sorry",
    ["noise"],
    "Logistics chatter. Mentions an asset and changes nothing about who holds it.",
  ),

  // ───────────────────────────────────────────────────────────────────────────────
  // September — the approval case, then the restraint case four days before recording.
  // ───────────────────────────────────────────────────────────────────────────────
  m(
    "2026-09-03",
    1155,
    "p02",
    "Anil, you should probably be on the bank account instead of me at this point — you're doing all the vendor payments anyway. Shall we sort it out?",
    ["durable_fact"],
    "THE APPROVAL. Deliberately ambiguous: this could also be read as Meera offering rather than a change being made.",
    { cases: ["approval"] },
  ),
  m(
    "2026-09-04",
    615,
    "p03",
    "Makes sense, let's talk at the weekend",
    ["noise"],
    "The reply that makes the approval case genuinely ambiguous rather than merely unconfirmed.",
    { cases: ["approval"] },
  ),
  m(
    "2026-09-09",
    1200,
    "p13",
    "I'll sort out the poster reprint for the next camp, need to check what's left in the store first.",
    ["commitment"],
    "THE RESTRAINT. An undated intention, four days old, with nothing blocked on it. Must not be raised.",
    { cases: ["restraint"] },
  ),
  m(
    "2026-09-11",
    960,
    "p10",
    "Someone should own the foster list properly, it can't keep living in my spreadsheet forever.",
    ["aggregation"],
    "Sets up the foster-capacity finding without naming a person as the problem.",
  ),
];

/** Assigns stable ids in date order. Ids are referenced by the coverage report. */
export function buildPlacements(): PlannedMessage[] {
  return [...DRAFTS]
    .sort((a, b) => (a.date === b.date ? a.minute - b.minute : a.date < b.date ? -1 : 1))
    .map((draft, index) => ({ ...draft, id: `pm${String(index + 1).padStart(3, "0")}` }));
}

/**
 * Rows a text scanner cannot honestly verify by pattern. Reported as *asserted by
 * plan* and traceable to the placements above. Weaker than a match, but better than
 * memory, because the claim is written down and attributable.
 */
export const ASSERTED_BY_PLAN: CoverageRow[] = [
  // That three exposures really sit inside one capability area is a semantic claim
  // about foster placement, not something a regex can establish.
  "aggregation",
  // That one capability has several observed participants and another exactly one is a
  // property of the calendar's participation pools, asserted by `assertCapabilityShape`.
  "capability_coverage",
];
