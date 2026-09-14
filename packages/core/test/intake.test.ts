/**
 * The normaliser, both ways in.
 *
 * The load-bearing test in this file is "both adapters agree": everything
 * downstream runs on `NormalisedMessage` alone and cannot tell a seeded message
 * from a live one, so a divergence between the two adapters is a bug that only
 * shows up as a seeded behaviour path quietly not working.
 */

import { describe, expect, it } from "vitest";
import {
  expandRenderedMessage,
  fromRenderedMessage,
  mediaKindOf,
  normaliseUpdate,
  type SeedRenderedMessage,
  type TelegramMessage,
  type TelegramUpdate,
} from "../src/intake/index.js";
import { contentHash } from "../src/normalise.js";

const CHAT_ID = -1001234567890;
const BOT_ID = 8871830879;

const options = { chatId: CHAT_ID, botUserId: BOT_ID };

/** A plain group message from a volunteer. */
/**
 * Builds a Telegram message, where an override of `undefined` means **the key is
 * absent** rather than present and undefined.
 *
 * The distinction matters because `exactOptionalPropertyTypes` is on and because it
 * is what Telegram actually does: a photo message has no `text` key at all, and a
 * channel post has no `from`. A fixture that set the key to `undefined` would be
 * testing a shape the API never sends.
 */
function message(
  overrides: { [K in keyof TelegramMessage]?: TelegramMessage[K] | undefined } = {},
): TelegramMessage {
  const built: Record<string, unknown> = {
    message_id: 4021,
    from: { id: 588068795, first_name: "Priya", last_name: "Raghavan", username: "priya_pc" },
    date: 1_776_000_000,
    chat: { id: CHAT_ID, type: "supergroup", title: "Paws & Claws" },
    text: "Sunrise Clinic lets us settle at month end",
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete built[key];
    } else {
      built[key] = value;
    }
  }

  return built as unknown as TelegramMessage;
}

function update(overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return { update_id: 1, message: message(), ...overrides };
}

describe("what intake refuses", () => {
  it("drops Baton's own messages", () => {
    // Without this it learns facts from its own answers, and a stale figure it
    // repeated returns as freshly confirmed — a corruption loop with no symptom.
    const outcome = normaliseUpdate(
      update({ message: message({ from: { id: BOT_ID, is_bot: true, first_name: "Baton" } }) }),
      options,
    );
    expect(outcome).toEqual({ kind: "ignored", reason: "own_message" });
  });

  it("ignores messages from a chat that is not the configured one", () => {
    const outcome = normaliseUpdate(
      update({ message: message({ chat: { id: -1009999999999, type: "supergroup" } }) }),
      options,
    );
    expect(outcome).toEqual({ kind: "ignored", reason: "foreign_chat" });
  });

  it("ignores a message with no sender", () => {
    const outcome = normaliseUpdate(update({ message: message({ from: undefined }) }), options);
    expect(outcome).toEqual({ kind: "ignored", reason: "no_sender" });
  });

  it("reports an unfamiliar update kind rather than throwing", () => {
    // Telegram adds update types. A worker that threw here would stop polling.
    expect(normaliseUpdate({ update_id: 9 }, options)).toEqual({
      kind: "ignored",
      reason: "unsupported_update",
    });
  });

  it("cannot recognise its own messages before getMe has returned", () => {
    // Documents why the intake loop resolves the bot id before polling, not after.
    const outcome = normaliseUpdate(
      update({ message: message({ from: { id: BOT_ID, is_bot: true, first_name: "Baton" } }) }),
      { chatId: CHAT_ID, botUserId: null },
    );
    expect(outcome.kind).toBe("message");
  });
});

describe("normalising a Telegram message", () => {
  it("carries the fields messages needs", () => {
    const outcome = normaliseUpdate(update(), options);
    expect(outcome.kind).toBe("message");
    if (outcome.kind !== "message") return;

    expect(outcome.message).toMatchObject({
      source: "telegram",
      chatId: CHAT_ID,
      telegramMessageId: 4021,
      senderTelegramUserId: 588068795,
      senderDisplayName: "Priya Raghavan",
      text: "Sunrise Clinic lets us settle at month end",
      replyToTelegramMessageId: null,
      isForwarded: false,
      forwardedFrom: null,
      isEdited: false,
      editedAt: null,
      isUnprocessed: false,
      mediaKind: null,
    });
    // Telegram sends unix seconds; 1_776_000_000 is 2026-04-12T13:20:00Z.
    expect(outcome.message.sentAt.toISOString()).toBe("2026-04-12T13:20:00.000Z");
    expect(outcome.message.contentHash).toBe(
      contentHash("Sunrise Clinic lets us settle at month end"),
    );
  });

  it("prefers the real name over the handle, because that is what a brief reads like", () => {
    const outcome = normaliseUpdate(
      update({ message: message({ from: { id: 1, username: "priya_pc" } }) }),
      options,
    );
    if (outcome.kind !== "message") throw new Error("expected a message");
    expect(outcome.message.senderDisplayName).toBe("priya_pc");
  });

  it("resolves the reply pointer", () => {
    const outcome = normaliseUpdate(
      update({ message: message({ reply_to_message: { message_id: 4000 } }) }),
      options,
    );
    if (outcome.kind !== "message") throw new Error("expected a message");
    expect(outcome.message.replyToTelegramMessageId).toBe(4000);
  });

  it("tags an edit as an edit, on the same message id", () => {
    // An edit is an upsert onto the row the original created, not a new message.
    const outcome = normaliseUpdate(
      {
        update_id: 2,
        edited_message: message({ edit_date: 1_776_003_600, text: "corrected text" }),
      },
      options,
    );
    expect(outcome.kind).toBe("edited_message");
    if (outcome.kind !== "edited_message") return;
    expect(outcome.message.telegramMessageId).toBe(4021);
    expect(outcome.message.isEdited).toBe(true);
    // edit_date is one hour after date.
    expect(outcome.message.editedAt?.toISOString()).toBe("2026-04-12T14:20:00.000Z");
  });
});

describe("forwarded messages", () => {
  it("attributes to the forwarder and names the origin", () => {
    // The original author is not ours to claim; the message is the forwarder's.
    const outcome = normaliseUpdate(
      update({
        message: message({
          forward_origin: { type: "user", sender_user: { id: 77, first_name: "Ravi" } },
        }),
      }),
      options,
    );
    if (outcome.kind !== "message") throw new Error("expected a message");
    expect(outcome.message.senderTelegramUserId).toBe(588068795);
    expect(outcome.message.isForwarded).toBe(true);
    expect(outcome.message.forwardedFrom).toBe("Ravi");
  });

  it("reads a hidden forward origin", () => {
    const outcome = normaliseUpdate(
      update({
        message: message({ forward_origin: { type: "hidden_user", sender_user_name: "Someone" } }),
      }),
      options,
    );
    if (outcome.kind !== "message") throw new Error("expected a message");
    expect(outcome.message.forwardedFrom).toBe("Someone");
  });

  it("still reads the legacy forward fields", () => {
    // A deployed bot may be talking to either Bot API generation.
    const outcome = normaliseUpdate(
      update({ message: message({ forward_from: { id: 77, first_name: "Ravi" } }) }),
      options,
    );
    if (outcome.kind !== "message") throw new Error("expected a message");
    expect(outcome.message.isForwarded).toBe(true);
    expect(outcome.message.forwardedFrom).toBe("Ravi");
  });
});

describe("media", () => {
  it("flags a voice note as unprocessed, so the gap is visible", () => {
    const outcome = normaliseUpdate(
      update({ message: message({ text: undefined, voice: {} }) }),
      options,
    );
    if (outcome.kind !== "message") throw new Error("expected a message");
    expect(outcome.message.mediaKind).toBe("voice");
    expect(outcome.message.isUnprocessed).toBe(true);
    expect(outcome.message.text).toBeNull();
  });

  it("curates a photo that carries a caption", () => {
    // The flag marks a gap in what can be read, not the presence of a file.
    const outcome = normaliseUpdate(
      update({
        message: message({ text: undefined, photo: [{}], caption: "the new intake form" }),
      }),
      options,
    );
    if (outcome.kind !== "message") throw new Error("expected a message");
    expect(outcome.message.mediaKind).toBe("photo");
    expect(outcome.message.isUnprocessed).toBe(false);
    expect(outcome.message.text).toBe("the new intake form");
  });

  it("maps each media kind to a value the schema accepts", () => {
    expect(mediaKindOf(message({ photo: [{}] }))).toBe("photo");
    expect(mediaKindOf(message({ voice: {} }))).toBe("voice");
    expect(mediaKindOf(message({ audio: {} }))).toBe("audio");
    expect(mediaKindOf(message({ video: {} }))).toBe("video");
    expect(mediaKindOf(message({ video_note: {} }))).toBe("video");
    expect(mediaKindOf(message({ animation: {} }))).toBe("video");
    expect(mediaKindOf(message({ document: {} }))).toBe("document");
    expect(mediaKindOf(message({ sticker: {} }))).toBe("sticker");
    expect(mediaKindOf(message({ poll: {} }))).toBe("other");
    expect(mediaKindOf(message())).toBeNull();
  });
});

describe("membership updates", () => {
  function memberUpdate(oldStatus: string, newStatus: string): TelegramUpdate {
    return {
      update_id: 3,
      chat_member: {
        chat: { id: CHAT_ID },
        from: { id: 1, first_name: "Priya" },
        date: 1_776_000_000,
        old_chat_member: {
          user: { id: 42, first_name: "Divya", last_name: "Nair" },
          status: oldStatus,
        },
        new_chat_member: {
          user: { id: 42, first_name: "Divya", last_name: "Nair" },
          status: newStatus,
        },
      },
    };
  }

  it("reads a departure", () => {
    const outcome = normaliseUpdate(memberUpdate("member", "left"), options);
    expect(outcome).toEqual({
      kind: "chat_member",
      event: {
        chatId: CHAT_ID,
        at: new Date(1_776_000_000_000),
        telegramUserId: 42,
        displayName: "Divya Nair",
        transition: "left",
        status: "left",
      },
    });
  });

  it("reads an arrival", () => {
    const outcome = normaliseUpdate(memberUpdate("left", "member"), options);
    if (outcome.kind !== "chat_member") throw new Error("expected chat_member");
    expect(outcome.event.transition).toBe("joined");
  });

  it("reports a promotion as no membership change", () => {
    const outcome = normaliseUpdate(memberUpdate("member", "administrator"), options);
    if (outcome.kind !== "chat_member") throw new Error("expected chat_member");
    expect(outcome.event.transition).toBe("unchanged");
  });

  it("treats a restricted-but-present member as present", () => {
    const base = memberUpdate("member", "restricted");
    if (base.chat_member !== undefined) base.chat_member.new_chat_member.is_member = true;
    const outcome = normaliseUpdate(base, options);
    if (outcome.kind !== "chat_member") throw new Error("expected chat_member");
    expect(outcome.event.transition).toBe("unchanged");
  });

  it("ignores membership changes in another chat", () => {
    const base = memberUpdate("member", "left");
    if (base.chat_member !== undefined) base.chat_member.chat.id = -100999;
    expect(normaliseUpdate(base, options)).toEqual({ kind: "ignored", reason: "foreign_chat" });
  });

  it("reports the bot's own membership regardless of chat", () => {
    // Being added to an unexpected group must be visible: it is the symptom of a
    // misconfigured TELEGRAM_CHAT_ID, and the introduction is idempotent per chat.
    const outcome = normaliseUpdate(
      {
        update_id: 4,
        my_chat_member: {
          chat: { id: -100999 },
          from: { id: 1, first_name: "Priya" },
          date: 1_776_000_000,
          old_chat_member: { user: { id: BOT_ID, first_name: "Baton" }, status: "left" },
          new_chat_member: { user: { id: BOT_ID, first_name: "Baton" }, status: "administrator" },
        },
      },
      options,
    );
    expect(outcome).toEqual({
      kind: "my_chat_member",
      event: {
        chatId: -100999,
        at: new Date(1_776_000_000_000),
        status: "administrator",
        isNowMember: true,
      },
    });
  });
});

describe("the seed adapter", () => {
  function rendered(overrides: Partial<SeedRenderedMessage> = {}): SeedRenderedMessage {
    return {
      telegramMessageId: -100042,
      sentAt: "2026-04-08T14:30:00+05:30",
      senderPlanId: "p02",
      senderDisplayName: "Meera Sundaram",
      text: "I set up the Razorpay donation page",
      replyToTelegramMessageId: null,
      isForwarded: false,
      forwardedFrom: null,
      isEdited: false,
      editedText: null,
      mediaKind: null,
      ...overrides,
    };
  }

  it("stamps the configured chat id, which the artifact does not carry", () => {
    const normalised = fromRenderedMessage(rendered(), { chatId: CHAT_ID });
    expect(normalised.chatId).toBe(CHAT_ID);
    expect(normalised.source).toBe("seed");
  });

  it("leaves the seventeen unbound people with a null Telegram id", () => {
    const normalised = fromRenderedMessage(rendered(), { chatId: CHAT_ID });
    expect(normalised.senderTelegramUserId).toBeNull();
  });

  it("binds the demo accounts that were resolved at seed time", () => {
    const normalised = fromRenderedMessage(rendered(), {
      chatId: CHAT_ID,
      telegramUserIdFor: (planId) => (planId === "p02" ? 489705226 : null),
    });
    expect(normalised.senderTelegramUserId).toBe(489705226);
  });

  it("reads the offset in the artifact's timestamp rather than assuming UTC", () => {
    const normalised = fromRenderedMessage(rendered(), { chatId: CHAT_ID });
    expect(normalised.sentAt.toISOString()).toBe("2026-04-08T09:00:00.000Z");
  });

  it("flags seeded media as unprocessed", () => {
    const normalised = fromRenderedMessage(rendered({ text: null, mediaKind: "voice" }), {
      chatId: CHAT_ID,
    });
    expect(normalised.isUnprocessed).toBe(true);
    expect(normalised.mediaKind).toBe("voice");
  });

  it("does not invent an edit timestamp the artifact never recorded", () => {
    const normalised = fromRenderedMessage(
      rendered({ isEdited: true, editedText: "corrected" }),
      { chatId: CHAT_ID },
      "edited",
    );
    expect(normalised.isEdited).toBe(true);
    expect(normalised.editedAt).toBeNull();
  });
});

describe("expanding an edited seed record", () => {
  const editedRecord: SeedRenderedMessage = {
    telegramMessageId: -100099,
    sentAt: "2026-05-02T11:00:00+05:30",
    senderPlanId: "p05",
    senderDisplayName: "Anil Kumar",
    text: "the clinic settles at month end",
    replyToTelegramMessageId: null,
    isForwarded: false,
    forwardedFrom: null,
    isEdited: true,
    editedText: "the clinic settles within 7 days",
    mediaKind: null,
  };

  it("produces one event for an ordinary message", () => {
    const events = expandRenderedMessage(
      { ...editedRecord, isEdited: false, editedText: null },
      { chatId: CHAT_ID },
    );
    expect(events).toHaveLength(1);
  });

  it("produces the original then the edit, as live Telegram would deliver them", () => {
    // Feeding only the final text would skip the supersession the seeded provenance
    // case exists to exercise.
    const events = expandRenderedMessage(editedRecord, { chatId: CHAT_ID });
    expect(events).toHaveLength(2);
    expect(events[0]?.text).toBe("the clinic settles at month end");
    expect(events[0]?.isEdited).toBe(false);
    expect(events[1]?.text).toBe("the clinic settles within 7 days");
    expect(events[1]?.isEdited).toBe(true);
  });

  it("keeps both events on one row identity, so the edit upserts", () => {
    const events = expandRenderedMessage(editedRecord, { chatId: CHAT_ID });
    expect(events[0]?.telegramMessageId).toBe(events[1]?.telegramMessageId);
  });

  it("gives the two texts different content hashes, so the edit misses the cache", () => {
    const events = expandRenderedMessage(editedRecord, { chatId: CHAT_ID });
    expect(events[0]?.contentHash).not.toBe(events[1]?.contentHash);
  });
});

describe("both adapters agree", () => {
  /**
   * The test that keeps seeded history and live traffic from drifting. Everything
   * downstream runs on this shape alone, so any field the two adapters disagree on
   * is a field where a seeded behaviour path silently does not work.
   *
   * `source`, `senderTelegramUserId` and `editedAt` are excluded and compared
   * separately: those are genuine differences between the two worlds rather than
   * drift — a seeded message is marked `seed`, most seeded people have no account,
   * and the artifact records that a message was edited but not when.
   */
  it("produces an identical shape for the same message", () => {
    const sentAt = "2026-04-08T14:30:00+05:30";
    const epochSeconds = Math.floor(new Date(sentAt).getTime() / 1000);
    const text = "I set up the Razorpay donation page";

    const live = normaliseUpdate(
      {
        update_id: 1,
        message: {
          message_id: -100042,
          from: { id: 489705226, first_name: "Meera", last_name: "Sundaram" },
          date: epochSeconds,
          chat: { id: CHAT_ID, type: "supergroup" },
          text,
          reply_to_message: { message_id: -100041 },
        },
      },
      options,
    );
    if (live.kind !== "message") throw new Error("expected a message");

    const seeded = fromRenderedMessage(
      {
        telegramMessageId: -100042,
        sentAt,
        senderPlanId: "p02",
        senderDisplayName: "Meera Sundaram",
        text,
        replyToTelegramMessageId: -100041,
        isForwarded: false,
        forwardedFrom: null,
        isEdited: false,
        editedText: null,
        mediaKind: null,
      },
      { chatId: CHAT_ID, telegramUserIdFor: () => 489705226 },
    );

    const { source: liveSource, ...liveRest } = live.message;
    const { source: seedSource, ...seedRest } = seeded;

    expect(seedRest).toEqual(liveRest);
    expect(liveSource).toBe("telegram");
    expect(seedSource).toBe("seed");
  });
});
