/**
 * Prompt invariants.
 *
 * The observation constraint is the product's privacy guarantee written as prompt text:
 * Baton may say nobody else has been *seen* doing something, never that nobody else
 * *can*. It is stated out loud in the README and the video, so like the no-scoring
 * guarantee in the schema it is tested rather than inspected.
 *
 * These assertions are cheap and they catch the one mistake that is otherwise invisible
 * — a seventh prompt, or a rewritten sixth, that forgets the constraint. Nothing fails
 * when that happens. The output simply starts making claims about people.
 */

import { describe, expect, it } from "vitest";
import {
  ASSESSOR_SYSTEM_PROMPT,
  BRIEFER_SYSTEM_PROMPT,
  CARTOGRAPHER_SYSTEM_PROMPT,
  CURATOR_SYSTEM_PROMPT,
  JSON_OUTPUT_CONTRACT,
  OBSERVATION_CONSTRAINT,
  PROMPT_VERSIONS,
  RESPONDENT_SYSTEM_PROMPT,
  RESTRAINT_SYSTEM_PROMPT,
} from "../src/prompts/index.js";

const PROMPTS = {
  curator: CURATOR_SYSTEM_PROMPT,
  cartographer: CARTOGRAPHER_SYSTEM_PROMPT,
  assessor: ASSESSOR_SYSTEM_PROMPT,
  restraint: RESTRAINT_SYSTEM_PROMPT,
  briefer: BRIEFER_SYSTEM_PROMPT,
  respondent: RESPONDENT_SYSTEM_PROMPT,
} as const;

describe("every prompt", () => {
  it("has one for each of the six agents, matching the version table", () => {
    expect(Object.keys(PROMPTS).sort()).toEqual(Object.keys(PROMPT_VERSIONS).sort());
  });

  it.each(Object.entries(PROMPTS))("carries the observation constraint: %s", (_name, prompt) => {
    expect(prompt).toContain(OBSERVATION_CONSTRAINT);
  });

  it.each(Object.entries(PROMPTS))("carries the JSON output contract: %s", (_name, prompt) => {
    // Every agent's response is parsed and validated on our side of the SDK boundary,
    // so every prompt has to ask for JSON.
    expect(prompt).toContain(JSON_OUTPUT_CONTRACT);
  });

  it.each(Object.entries(PROMPTS))(
    "is substantial rather than a placeholder: %s",
    (_name, prompt) => {
      expect(prompt.length).toBeGreaterThan(400);
    },
  );
});

describe("the observation constraint itself", () => {
  it("forbids claiming a person is unable to do something", () => {
    expect(OBSERVATION_CONSTRAINT).toMatch(/never state or imply that a person is unable/i);
  });

  it("forbids comparing volunteers", () => {
    expect(OBSERVATION_CONSTRAINT).toMatch(/never compare volunteers/i);
  });

  it("forbids characterising reliability, effort or availability", () => {
    expect(OBSERVATION_CONSTRAINT).toMatch(/reliability, effort, or availability/i);
  });
});

describe("the curator prompt specifically", () => {
  it("forbids cross-message inference, which is what keeps per-message caching sound", () => {
    // Not a style rule. The cache is keyed on content_hash + prompt_version, and batches
    // are formed from misses only, so a classification that depended on its batch-mates
    // would be cached under a key that does not describe it.
    expect(CURATOR_SYSTEM_PROMPT).toMatch(/do not use another\s+message in this batch/i);
  });

  it("rejects conditionals, hypotheticals and jokes", () => {
    expect(CURATOR_SYSTEM_PROMPT).toMatch(/conditionals and hypotheticals/i);
    expect(CURATOR_SYSTEM_PROMPT).toMatch(/jokes, sarcasm/i);
  });

  it("treats noise as a first-class outcome rather than a failure", () => {
    expect(CURATOR_SYSTEM_PROMPT).toMatch(/most messages are noise/i);
  });

  it("forbids copying a credential into a claim", () => {
    expect(CURATOR_SYSTEM_PROMPT).toMatch(/never copy a password, key, token or account number/i);
  });
});

describe("the assessor prompt specifically", () => {
  it("tells the model not to redo the arithmetic SQL already did", () => {
    expect(ASSESSOR_SYSTEM_PROMPT).toMatch(/do not recount/i);
  });

  it("separates severity from confidence", () => {
    expect(ASSESSOR_SYSTEM_PROMPT).toMatch(/not about how sure/i);
  });

  it("requires titles about a capability rather than a person", () => {
    expect(ASSESSOR_SYSTEM_PROMPT).toMatch(/never about a person/i);
  });
});

describe("the restraint prompt specifically", () => {
  it("requires the withholding reason to avoid characterising a person", () => {
    expect(RESTRAINT_SYSTEM_PROMPT).toMatch(/must never be about a person/i);
  });

  it("warns against withholding merely uncomfortable things", () => {
    // Restraint is not timidity. Withholding everything difficult would make Baton
    // useless in a different way from saying everything.
    expect(RESTRAINT_SYSTEM_PROMPT).toMatch(/restraint is not timidity/i);
  });
});

describe("the briefer prompt specifically", () => {
  it("fixes the three sections in order", () => {
    const order = ["only_they_held", "they_had_promised", "nobody_else_seen"];
    const positions = order.map((section) => BRIEFER_SYSTEM_PROMPT.indexOf(section));

    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("handles the empty case with a plain sentence rather than empty sections", () => {
    expect(BRIEFER_SYSTEM_PROMPT).toMatch(/nothing appears to have left with them/i);
  });
});

describe("the respondent prompt specifically", () => {
  it("names all four outcomes", () => {
    for (const outcome of ["answer", "stale_answer", "ambiguous_holder", "unknown"]) {
      expect(RESPONDENT_SYSTEM_PROMPT).toContain(outcome);
    }
  });

  it("forbids softening a stale answer", () => {
    expect(RESPONDENT_SYSTEM_PROMPT).toMatch(/should still be fine/i);
  });

  it("forbids quoting a credential even to the person who shared it", () => {
    expect(RESPONDENT_SYSTEM_PROMPT).toMatch(/never quote a password/i);
  });
});
