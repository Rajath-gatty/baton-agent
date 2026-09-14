/**
 * The value signature — how a restatement is told from a contradiction.
 *
 * `facts.match_key` groups every claim about the same aspect of the same asset.
 * Within that group something has to decide whether a new message *restates* what
 * is already held, which bumps `last_confirmed_at` and appends evidence, or
 * *contradicts* it, which inserts a new row and sets `supersedes_fact_id`. This
 * module is that decision, and it is the one genuinely fuzzy rule in the system.
 *
 * It is deliberately isolated in its own file with its own test table so it can be
 * tuned against real seeded material once a model has actually run, without
 * touching the fact-writing logic that depends on it.
 *
 * **Two rules, by claim aspect:**
 *
 *   - A claim with a holder is signed by the *holder's identity*. "Meera set up the
 *     donation page", restated later as "the Razorpay page is Meera's", signs
 *     identically. The same claim naming Anil does not, and that is a transfer.
 *   - A claim without a holder is signed by its *salient figures* — currency
 *     amounts, percentages, dates and plain numbers. "Sunrise Clinic lets us settle
 *     at month end" carries no figure, so a reworded restatement signs identically
 *     and merges. "Sunrise Clinic now wants payment within 7 days" carries one, so
 *     it supersedes.
 *
 * **The bias is deliberate, because the two failure modes are not symmetric.**
 * A false contradiction inserts a row and marks the older one superseded: visible,
 * provenance intact, recoverable. A false restatement bumps `last_confirmed_at` on
 * a claim whose content actually changed, so the register presents stale
 * information as freshly confirmed — invisible, and precisely the corruption the
 * staleness warning exists to surface. Extraction therefore leans toward finding a
 * figure rather than missing one.
 */

import { normaliseAlias } from "./normalise.js";

/** Digit groups with optional thousands separators and decimals. */
const NUMBER = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;

const MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

/** Strips separators so "1,200" and "1200" and "1200.00" all sign the same. */
function canonicalNumber(raw: string): string {
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) ? String(value) : raw;
}

/**
 * Pulls the figures out of a claim.
 *
 * Ordered most specific first, and each match is blanked out of the working copy
 * once taken, so the "1200" inside "₹1,200" is not also counted as a bare number —
 * which would make the signature depend on extraction order.
 *
 * Returned sorted and de-duplicated, so the same figures stated in a different
 * sentence order sign identically. Word order is prose; the figures are the claim.
 */
export function salientTokens(claim: string): string[] {
  let rest = claim.toLowerCase();
  const tokens: string[] = [];

  const take = (pattern: RegExp, render: (match: RegExpExecArray) => string | null): void => {
    rest = rest.replace(pattern, (...args) => {
      // String.replace hands the match groups positionally; rebuild an exec-shaped
      // array so `render` can read groups by index.
      const groups = args.slice(0, -2) as string[];
      const rendered = render(groups as unknown as RegExpExecArray);
      if (rendered !== null) tokens.push(rendered);
      // Blank the span so a later, broader pattern cannot re-read it.
      return " ";
    });
  };

  // Currency: ₹1,200 / rs. 1200 / inr 1200 / 1200 rupees.
  take(new RegExp(String.raw`(?:₹|\brs\.?\s*|\binr\s*)(${NUMBER})`, "g"), (m) =>
    m[1] === undefined ? null : `inr:${canonicalNumber(m[1])}`,
  );
  take(new RegExp(String.raw`(${NUMBER})\s*(?:rupees|rs\b)`, "g"), (m) =>
    m[1] === undefined ? null : `inr:${canonicalNumber(m[1])}`,
  );

  // Percentages.
  take(new RegExp(String.raw`(${NUMBER})\s*(?:%|per\s?cent)`, "g"), (m) =>
    m[1] === undefined ? null : `pct:${canonicalNumber(m[1])}`,
  );

  // ISO dates.
  take(/(\d{4})-(\d{2})-(\d{2})/g, (m) => `date:${m[1]}-${m[2]}-${m[3]}`);

  // Numeric dates: 08/04/2026 or 8-4-26. Day-first, which is the convention in the
  // group this is built for.
  take(/\b(\d{1,2})[/](\d{1,2})[/](\d{2,4})\b/g, (m) => {
    const day = (m[1] ?? "").padStart(2, "0");
    const month = (m[2] ?? "").padStart(2, "0");
    return `date:${month}-${day}`;
  });

  // Month-name dates, both orders: "8 April" and "April 8".
  const monthNames = Object.keys(MONTHS).join("|");
  take(new RegExp(String.raw`\b(\d{1,2})\s+(${monthNames})\b`, "g"), (m) => {
    const month = MONTHS[m[2] ?? ""];
    return month === undefined ? null : `date:${month}-${(m[1] ?? "").padStart(2, "0")}`;
  });
  take(new RegExp(String.raw`\b(${monthNames})\s+(\d{1,2})\b`, "g"), (m) => {
    const month = MONTHS[m[1] ?? ""];
    return month === undefined ? null : `date:${month}-${(m[2] ?? "").padStart(2, "0")}`;
  });

  // Whatever numbers are left, including the sterilisation count that the stale
  // answer case turns on.
  take(new RegExp(NUMBER, "g"), (m) => (m[0] === undefined ? null : `n:${canonicalNumber(m[0])}`));

  return [...new Set(tokens)].sort();
}

export interface ValueSignatureInput {
  /**
   * The resolved holder — a person id, or an external name where the holder is
   * outside the group. Null for a claim that is not about who holds something.
   */
  holder: string | null;
  claim: string;
}

/**
 * Signs a claim's *value*, so two claims sharing a `match_key` can be compared.
 *
 * Equal signatures merge; unequal signatures supersede. An empty figure set is a
 * legitimate signature and the common case for arrangement claims — it is what
 * lets "we settle at month end" be restated in any words at all and still merge.
 */
export function valueSignature({ holder, claim }: ValueSignatureInput): string {
  if (holder !== null && holder.trim() !== "") {
    // A person id is already canonical; an external name is free text and needs
    // the same folding an alias gets, or "The Clinic" and "the clinic" transfer
    // the asset back and forth on every mention.
    return `holder:${normaliseAlias(holder) || holder.trim().toLowerCase()}`;
  }
  return `attr:${salientTokens(claim).join(",")}`;
}
