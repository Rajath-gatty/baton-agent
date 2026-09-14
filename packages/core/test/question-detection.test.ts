/**
 * Question detection.
 *
 * The valuable half of this file is the negatives. Two signals make a message a question for
 * Baton — an @-mention, or a reply to one of its messages — and everything else must not,
 * including the things that look most like questions. A bot that answers anything ending in
 * a question mark joins every conversation it is not part of, spends model calls on chatter,
 * and teaches the group to ignore its messages. That last cost cannot be undone by a later
 * code change, which is why the restraint is tested harder than the detection.
 */

import { describe, expect, it } from "vitest";
import { detectQuestionToBot, mentionsBot, type TelegramMessage } from "../src/index.js";

const BOT_ID = 777;
const BOT_USERNAME = "batonbot";
const OPTIONS = { botUserId: BOT_ID, botUsername: BOT_USERNAME };

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 10,
    from: { id: 5001, first_name: "Priya" },
    date: 1_780_000_000,
    chat: { id: -1001234567890, type: "supergroup" },
    text: "who has the store room key?",
    ...overrides,
  };
}

describe("question detection", () => {
  describe("the two signals", () => {
    it("detects an @-mention", () => {
      const detection = detectQuestionToBot(
        message({ text: "@batonbot who has the store room key?" }),
        OPTIONS,
      );

      expect(detection.isQuestion).toBe(true);
      expect(detection.signal).toBe("mention");
      expect(detection.repliedToBotMessageId).toBeNull();
    });

    it("detects a mention anywhere in the message, not only at the start", () => {
      expect(
        detectQuestionToBot(
          message({ text: "quick one for @batonbot — who has the key?" }),
          OPTIONS,
        ).isQuestion,
      ).toBe(true);
    });

    it("detects a mention in a photo caption", () => {
      const detection = detectQuestionToBot(
        message({ text: undefined, caption: "@batonbot is this the right form?", photo: [{}] }),
        OPTIONS,
      );
      expect(detection.isQuestion).toBe(true);
    });

    it("detects a reply to the bot", () => {
      const detection = detectQuestionToBot(
        message({
          text: "and who has the spare?",
          reply_to_message: { message_id: 9, from: { id: BOT_ID, is_bot: true } },
        }),
        OPTIONS,
      );

      expect(detection.isQuestion).toBe(true);
      expect(detection.signal).toBe("reply_to_bot");
      // The caller needs this to tell an answer to Baton's own question from a new one.
      expect(detection.repliedToBotMessageId).toBe(9);
    });

    it("prefers the reply signal when both are present", () => {
      const detection = detectQuestionToBot(
        message({
          text: "@batonbot and the spare?",
          reply_to_message: { message_id: 9, from: { id: BOT_ID } },
        }),
        OPTIONS,
      );
      // Either would do, but the reply carries the extra information, so it wins.
      expect(detection.signal).toBe("reply_to_bot");
      expect(detection.repliedToBotMessageId).toBe(9);
    });
  });

  describe("what is deliberately not a signal", () => {
    it("ignores a plain question to the group", () => {
      expect(
        detectQuestionToBot(message({ text: "who has the store room key?" }), OPTIONS),
      ).toEqual({ isQuestion: false, signal: "none", repliedToBotMessageId: null });
    });

    it("ignores a question word with no address", () => {
      expect(
        detectQuestionToBot(message({ text: "anyone free saturday?" }), OPTIONS).isQuestion,
      ).toBe(false);
    });

    it("ignores the bot's name in prose", () => {
      // Talking about Baton, not to it. Without the @ it is not addressed to anyone in
      // Telegram's own model of a group.
      expect(
        detectQuestionToBot(message({ text: "baton reckons Meera has it" }), OPTIONS).isQuestion,
      ).toBe(false);
    });

    it("ignores a reply to another person", () => {
      expect(
        detectQuestionToBot(
          message({ reply_to_message: { message_id: 9, from: { id: 5002 } } }),
          OPTIONS,
        ).isQuestion,
      ).toBe(false);
    });

    it("ignores a reply whose sender Telegram did not report", () => {
      // Refusing is the safe direction: assuming it was the bot would make every reply in
      // an anonymous-admin group a question.
      expect(
        detectQuestionToBot(message({ reply_to_message: { message_id: 9 } }), OPTIONS).isQuestion,
      ).toBe(false);
    });

    it("ignores a mention of a different bot whose name starts the same way", () => {
      // The word boundary matters: otherwise Baton answers questions addressed to
      // @batonbot_test in the same group.
      expect(
        detectQuestionToBot(message({ text: "@batonbot_test who has the key?" }), OPTIONS)
          .isQuestion,
      ).toBe(false);
    });

    it("ignores everything when the bot's identity is unresolved", () => {
      const detection = detectQuestionToBot(
        message({
          text: "@batonbot who has it?",
          reply_to_message: { message_id: 9, from: { id: BOT_ID } },
        }),
        { botUserId: null, botUsername: null },
      );
      // Not a silent degradation to guessing: with no identity there is no way to know who
      // is being addressed, and answering anyway would be answering at random.
      expect(detection.isQuestion).toBe(false);
    });
  });

  describe("mentionsBot", () => {
    it("is case-insensitive, because Telegram usernames are", () => {
      expect(mentionsBot("@BatonBot help", BOT_USERNAME)).toBe(true);
      expect(mentionsBot("@batonbot help", "BatonBot")).toBe(true);
    });

    it("tolerates a configured username written with the @ already on it", () => {
      expect(mentionsBot("@batonbot help", "@batonbot")).toBe(true);
    });

    it("matches when punctuation follows the handle", () => {
      expect(mentionsBot("@batonbot, who has the key?", BOT_USERNAME)).toBe(true);
      expect(mentionsBot("(@batonbot)", BOT_USERNAME)).toBe(true);
    });

    it("returns false for empty and absent input", () => {
      expect(mentionsBot(null, BOT_USERNAME)).toBe(false);
      expect(mentionsBot("   ", BOT_USERNAME)).toBe(false);
      expect(mentionsBot("@batonbot", null)).toBe(false);
      expect(mentionsBot("@batonbot", "")).toBe(false);
    });

    it("does not build a broken regex from an odd username", () => {
      // A username is external input. Telegram restricts it today; that guarantee is theirs
      // to change, and the cost of assuming is a regular expression built from a stranger's
      // string.
      expect(() => mentionsBot("@a.b help", "a.b")).not.toThrow();
      expect(mentionsBot("@axb help", "a.b")).toBe(false);
    });
  });
});
