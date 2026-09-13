/**
 * Deterministic alias matching.
 *
 * The Cartographer is mostly not a model. Fuzzy string matching against
 * `person_aliases` resolves the overwhelming majority of mentions at zero model
 * cost, and the model is invoked **only** on the residue: a mention that matches
 * more than one person, or none.
 *
 * The important property here is what happens when matching is uncertain. This
 * resolver never picks a winner among several candidates — it reports the
 * candidates and lets the ambiguity travel onward, because an alias resolving to
 * two people is the signal that produces a clarification question. A resolver that
 * broke ties by score would convert that signal into a silent guess, and a wrong
 * guess about who holds financial control is invisible once written.
 */

import type { AliasEntry } from "@baton/core";

/**
 * Case-folds, strips the leading `@` of a handle, removes punctuation and collapses
 * whitespace. "Priya!", "@priya", "  PRIYA " all normalise to "priya".
 *
 * `\p{M}` — combining marks — is kept alongside letters and numbers, and that is not
 * incidental. Devanagari vowel signs and the virama are marks rather than letters, so
 * a class of `\p{L}\p{N}` alone turns "प्रिया" into "परय": a different string, matching
 * nothing, for a roster where names are written in more than one script.
 */
export function normaliseAlias(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein distance, capped — anything past the cap is "too far" and stops early. */
export function editDistanceWithin(a: string, b: string, cap: number): number | null {
  if (Math.abs(a.length - b.length) > cap) return null;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    let rowBest = i;

    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      const best = Math.min(substitution, insertion, deletion);
      current[j] = best;
      if (best < rowBest) rowBest = best;
    }

    // Every path through this row already exceeds the cap, so no completion can come
    // back under it.
    if (rowBest > cap) return null;
    previous = current;
  }

  const distance = previous[b.length];
  return distance !== undefined && distance <= cap ? distance : null;
}

export type MatchMethod = "exact" | "typo" | "first-name" | "none";

export interface AliasMatch {
  /** The mention as written, preserved for the schema and for provenance. */
  mention: string;
  /** Everyone the mention could be. Zero, one, or several — all are meaningful. */
  candidatePersonIds: string[];
  method: MatchMethod;
}

/**
 * An index over the alias table.
 *
 * Built once per request and reused across every mention in the batch, because a
 * batch of ten messages can easily carry thirty mentions and rebuilding the index
 * per mention is the difference between microseconds and milliseconds at no benefit.
 */
export class AliasIndex {
  private readonly byNormalised = new Map<string, Set<string>>();
  private readonly normalisedForms: string[] = [];

  constructor(aliases: readonly AliasEntry[]) {
    for (const entry of aliases) {
      const key = normaliseAlias(entry.alias);
      if (key === "") continue;

      const existing = this.byNormalised.get(key);
      if (existing === undefined) {
        this.byNormalised.set(key, new Set([entry.personId]));
        this.normalisedForms.push(key);
      } else {
        existing.add(entry.personId);
      }
    }
  }

  /**
   * Resolves one mention to the set of people it could be.
   *
   * Three passes, tried in order and never blended: an exact normalised match, a
   * single-character typo, then a first-name match against a multi-word alias. They
   * are ordered by confidence and the first that hits anything wins, so a mention
   * that exactly matches one person is never widened by a fuzzy match on another.
   */
  resolve(mention: string): AliasMatch {
    const needle = normaliseAlias(mention);
    if (needle === "") {
      return { mention, candidatePersonIds: [], method: "none" };
    }

    const exact = this.byNormalised.get(needle);
    if (exact !== undefined) {
      return { mention, candidatePersonIds: [...exact], method: "exact" };
    }

    // A single-character typo. Short strings are excluded: at three characters or
    // fewer, one edit away covers most of the roster and matches nothing usefully.
    if (needle.length > 3) {
      const typoMatches = new Set<string>();
      for (const form of this.normalisedForms) {
        if (editDistanceWithin(needle, form, 1) !== null) {
          for (const personId of this.byNormalised.get(form) ?? []) {
            typoMatches.add(personId);
          }
        }
      }
      if (typoMatches.size > 0) {
        return { mention, candidatePersonIds: [...typoMatches], method: "typo" };
      }
    }

    // A bare first name against a fuller recorded name: "Priya" where the alias
    // table holds "Priya Chandran". Deliberately collects every match rather than
    // the closest, because two Priyas is exactly the case that must escalate.
    const firstNameMatches = new Set<string>();
    for (const form of this.normalisedForms) {
      const parts = form.split(" ");
      if (parts.length > 1 && parts[0] === needle) {
        for (const personId of this.byNormalised.get(form) ?? []) {
          firstNameMatches.add(personId);
        }
      }
    }
    if (firstNameMatches.size > 0) {
      return { mention, candidatePersonIds: [...firstNameMatches], method: "first-name" };
    }

    return { mention, candidatePersonIds: [], method: "none" };
  }
}

/**
 * Whether a match needs the model.
 *
 * Exactly one candidate is resolved in code. Anything else — several candidates, or
 * none — is the ambiguous minority the model exists for, and a mention matching
 * nobody may well be someone outside the group, which only the model can say.
 */
export function needsEscalation(match: AliasMatch): boolean {
  return match.candidatePersonIds.length !== 1;
}
