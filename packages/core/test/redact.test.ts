import { describe, expect, it } from "vitest";
import { containsCredential, redactCredentials, REDACTION_PLACEHOLDER } from "../src/redact.js";

describe("redactCredentials", () => {
  describe("removes credential-shaped strings", () => {
    const cases: ReadonlyArray<readonly [name: string, input: string]> = [
      ["a Telegram bot token", "the bot is 8123456789:AAF-3xKq7bTzWvR2mNpQlY8sHjD4gU6vXcE"],
      ["an OpenAI-style key", "use sk-proj-a1b2c3d4e5f6g7h8i9j0k1l2 for the API"],
      ["an AWS access key id", "id AKIAIOSFODNN7EXAMPLE is the one"],
      ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ1234567890abcd"],
      [
        "a connection string with inline credentials",
        "postgres://baton:hunter2@db.internal:5432/x",
      ],
      ["a labelled password", "the donation page password is hunter2"],
      ["a labelled OTP", "OTP: 448122"],
      ["a card-shaped number", "card 4111 1111 1111 1111 on file"],
    ];

    for (const [name, input] of cases) {
      it(name, () => {
        const out = redactCredentials(input);
        expect(out).toContain(REDACTION_PLACEHOLDER);
        expect(containsCredential(input)).toBe(true);
      });
    }

    it("keeps the label so the reader knows what was removed", () => {
      expect(redactCredentials("password is hunter2")).toBe(`password is ${REDACTION_PLACEHOLDER}`);
    });
  });

  describe("leaves operational facts intact", () => {
    // These are the messages the product exists to remember. Redacting any of
    // them would be a worse failure than missing a credential, because it would
    // be silent and permanent on every surface that quotes the message.
    const survivors: readonly string[] = [
      "Sunrise Clinic lets us settle at month end",
      "Call 98765 43210 for the emergency line, it's on the posters",
      "Emergency number is +91 98765 43210",
      "We got 14 done yesterday, thanks Anil and Meera",
      "The van keys are with Ravi",
      "Sterilisation rate was 62% last I checked",
      "Transport costs came to ₹4,500 for the month",
      "Meeting on 2026-09-13 at 14:30",
      "https://donate.pawsandclaws.example/campaign",
    ];

    for (const text of survivors) {
      it(JSON.stringify(text), () => {
        expect(redactCredentials(text)).toBe(text);
        expect(containsCredential(text)).toBe(false);
      });
    }
  });

  it("is idempotent, so a re-rendered message does not accumulate placeholders", () => {
    const once = redactCredentials("password is hunter2");
    expect(redactCredentials(once)).toBe(once);
  });

  it("handles empty input", () => {
    expect(redactCredentials("")).toBe("");
  });
});
