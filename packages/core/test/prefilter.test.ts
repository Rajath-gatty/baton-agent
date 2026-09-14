/**
 * The pre-filter, scored on recall.
 *
 * Recall is the metric that matters and precision only costs money, so the
 * assertion that counts is the floor on must-keep messages. Keep-rate is reported
 * and loosely bounded — enough to fail a degenerate filter that keeps everything,
 * not tight enough to tempt anyone into trading recall for it.
 *
 * **Honest limitation:** this corpus is hand-labelled, so a passing recall score
 * proves the rules match this author's expectations, not that they match a real
 * group's chatter. Its real value is as a regression guard — tightening a rule later
 * drops the score and fails the build. Final calibration belongs against the
 * rendered transcript, once one exists.
 */

import { describe, expect, it } from "vitest";
import { prefilter, type PrefilterReason } from "../src/prefilter.js";
// Deliberately the single existing constant, not a second one declared beside the
// rules. If these ever disagree, verdicts and re-evaluation disagree with them.
import { PREFILTER_VERSION } from "../src/prompts/index.js";

/**
 * `keep: true` means discarding this message loses knowledge — these are the cases
 * recall is measured over. `keep: false` means it may be discarded; keeping it is a
 * cost, never a correctness failure, so those only feed the keep-rate report.
 */
interface Labelled {
  text: string;
  keep: boolean;
  note: string;
}

const CORPUS: readonly Labelled[] = [
  // ── Durable facts. Every one of these must survive. ──────────────────────────
  {
    text: "Sunrise Clinic lets us settle at month end",
    keep: true,
    note: "the settlement arrangement, the canonical durable fact",
  },
  { text: "the van is Anil's", keep: true, note: "personal resource, no figure or date" },
  {
    text: "Meera set up the Razorpay donation page",
    keep: true,
    note: "holder of a public presence",
  },
  { text: "I have the shelter keys", keep: true, note: "holding, first person" },
  { text: "Divya is our contact at the vet college", keep: true, note: "relationship holder" },
  {
    text: "the emergency number on the posters is 1800 425 1111",
    keep: true,
    note: "a printed figure",
  },
  {
    text: "we did 47 sterilisations in March",
    keep: true,
    note: "the figure the stale answer turns on",
  },
  {
    text: "clinic wants payment within 7 days now",
    keep: true,
    note: "contradiction of the terms",
  },
  { text: "Priya holds the bank signatory", keep: true, note: "financial control" },
  { text: "the intake form template lives in my drive", keep: true, note: "document holder" },
  {
    text: "haha yes the poster looks great, also the printers said the invoice is settled monthly now",
    keep: true,
    note: "pre-filter recall: a durable fact buried in chatty text",
  },
  {
    text: "just so everyone knows, the clinic changed hands last week and the new vet is happy to keep our arrangement going",
    keep: true,
    note: "long, substantive, no obvious keyword",
  },
  {
    text: "password for the shelter wifi is hunter2trustno1",
    keep: true,
    note: "credential exposure",
  },
  { text: "donation page is at https://rzp.io/l/pawsclaws", keep: true, note: "url" },

  // ── Commitments ─────────────────────────────────────────────────────────────
  { text: "I'll call the printers tomorrow", keep: true, note: "dated promise" },
  { text: "I'll sort out the printers at some point", keep: true, note: "undated intention" },
  { text: "can you pick up the food order on Tuesday?", keep: true, note: "asked commitment" },

  // ── Participation evidence ──────────────────────────────────────────────────
  {
    text: "Thanks Anil and Meera for yesterday, we got fourteen done",
    keep: true,
    note: "thanks-list naming people",
  },
  { text: "big thanks to Divya for driving again", keep: true, note: "thanks naming one person" },

  // ── Lifecycle and hearsay ───────────────────────────────────────────────────
  { text: "Divya told me the clinic is closing on Sundays", keep: true, note: "hearsay" },
  { text: "Ananya is joining us from next month", keep: true, note: "lifecycle in prose" },

  // ── Noise. May be discarded; a keep here is only a cost. ────────────────────
  { text: "haha same", keep: false, note: "agreement fragment" },
  { text: "ok", keep: false, note: "acknowledgement" },
  { text: "thanks", keep: false, note: "bare thanks, no names" },
  { text: "good morning", keep: false, note: "greeting that contains a temporal word" },
  { text: "morning", keep: false, note: "bare greeting" },
  { text: "😂😂", keep: false, note: "emoji only" },
  { text: "+1", keep: false, note: "reaction" },
  { text: "lol", keep: false, note: "reaction" },
  { text: "noted", keep: false, note: "reaction" },
  { text: "sounds good", keep: false, note: "reaction" },
  { text: "on it", keep: false, note: "reaction that looks like a commitment" },
  { text: "no problem", keep: false, note: "reaction" },
  { text: "oops sorry", keep: false, note: "short apology" },
  { text: "where is everyone", keep: false, note: "logistics chatter, nothing durable" },
  { text: "who else is coming", keep: false, note: "logistics chatter" },
];

describe("recall over the labelled corpus", () => {
  const mustKeep = CORPUS.filter((entry) => entry.keep);
  const missed = mustKeep.filter(
    (entry) => prefilter({ text: entry.text }).verdict !== "candidate",
  );

  it("loses nothing that carries knowledge", () => {
    // Reported by note rather than index, so a failure names the behaviour lost
    // rather than a line number.
    expect(missed.map((entry) => `${entry.note}: ${entry.text}`)).toEqual([]);
  });

  it("keeps recall at the floor", () => {
    const recall = (mustKeep.length - missed.length) / mustKeep.length;
    expect(recall).toBeGreaterThanOrEqual(1);
  });

  it("does not simply keep everything", () => {
    // A filter that keeps every message would pass the recall assertions above
    // while costing what the pre-filter exists to save.
    const kept = CORPUS.filter((entry) => prefilter({ text: entry.text }).verdict === "candidate");
    const keepRate = kept.length / CORPUS.length;
    expect(keepRate).toBeLessThan(0.75);

    // And it must actually discard most of the noise it was shown.
    const noise = CORPUS.filter((entry) => !entry.keep);
    const noiseKept = noise.filter(
      (entry) => prefilter({ text: entry.text }).verdict === "candidate",
    );
    expect(noiseKept.length / noise.length).toBeLessThan(0.3);
  });
});

describe("which rule fires", () => {
  const cases: readonly [string, PrefilterReason][] = [
    ["we did 47 sterilisations", "figure"],
    ["let's meet next Tuesday", "temporal"],
    ["I'll call them", "commitment_language"],
    ["I have the keys", "holding_language"],
    ["ask @priya_pc about it", "mention"],
    ["see https://example.org", "url"],
    ["the van is Anil's", "proper_noun"],
    ["haha same", "reaction"],
    ["good morning", "reaction"],
    ["where is everyone", "no_signal"],
  ];

  for (const [text, reason] of cases) {
    it(`${JSON.stringify(text)} → ${reason}`, () => {
      expect(prefilter({ text }).reason).toBe(reason);
    });
  }

  it("checks whole-message reactions before any keep signal", () => {
    // "good morning" contains a temporal word. Order is what stops it being kept.
    expect(prefilter({ text: "good morning" }).verdict).toBe("discarded");
    expect(prefilter({ text: "good morning, the clinic changed its terms" }).verdict).toBe(
      "candidate",
    );
  });

  it("keeps a credential ahead of every other consideration", () => {
    expect(prefilter({ text: "pin 4417" }).reason).toBe("credential");
  });

  it("wants names before it treats gratitude as participation evidence", () => {
    expect(prefilter({ text: "thanks" }).verdict).toBe("discarded");
    expect(prefilter({ text: "thanks everyone for turning out today" }).verdict).toBe("candidate");
  });
});

describe("text that cannot be classified", () => {
  it("discards a message with no text", () => {
    expect(prefilter({ text: null })).toEqual({
      verdict: "discarded",
      version: PREFILTER_VERSION,
      reason: "no_text",
    });
  });

  it("discards media with no caption without judging its content", () => {
    // The message is still stored and flagged unprocessed, so the gap is visible.
    expect(prefilter({ text: null, isUnprocessed: true }).reason).toBe("no_text");
  });

  it("discards whitespace", () => {
    expect(prefilter({ text: "   " }).reason).toBe("no_text");
  });
});

describe("the version stamp", () => {
  it("is recorded on every verdict, kept and discarded alike", () => {
    // What makes re-evaluation of prior discards possible instead of that knowledge
    // being lost permanently.
    expect(prefilter({ text: "I have the keys" }).version).toBe(PREFILTER_VERSION);
    expect(prefilter({ text: "ok" }).version).toBe(PREFILTER_VERSION);
  });
});
