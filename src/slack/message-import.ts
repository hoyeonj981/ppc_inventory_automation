import { env } from "cloudflare:workers";
import { appendInventoryRow } from "../sheets/append";
import { parseInventoryMessage } from "../core/message-inventory";
import { getReportPermalink } from "./report";
import { getSlackUserName } from "./users";

export type MessageImportResult = {
  status:
    | "saved"
    | "duplicate"
    | "unconfirmed"
    | "invalid"
    | "ignored"
    | "failed";
  detail?: string;
};

// The bot's own reaction on the original message marks it as saved. Removing it allows a re-import.
export const SAVED_REACTION = "white_check_mark";

async function markSaved(
  channel: string,
  timestamp: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const response = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, timestamp, name: SAVED_REACTION }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    });
    const result = (await response.json()) as { ok?: boolean; error?: string };
    if (
      response.ok &&
      (result?.ok === true || result?.error === "already_reacted")
    )
      return;
  } catch {
    // The row is already saved; a missing mark only risks a duplicate on a later reaction.
  }
  console.warn("inventory.message_mark_failed", {
    channelId: channel,
    messageTs: timestamp,
  });
}

export async function importMessage(
  channel: string,
  timestamp: string,
  botUserId: string,
): Promise<MessageImportResult> {
  const signal = AbortSignal.timeout(22000);
  let writeStarted = false;
  try {
    const url = new URL("https://slack.com/api/reactions.get");
    url.searchParams.set("channel", channel);
    url.searchParams.set("timestamp", timestamp);
    url.searchParams.set("full", "true");
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    });
    const result = (await response.json()) as {
      ok?: boolean;
      type?: string;
      channel?: string;
      message?: {
        ts?: string;
        text?: string;
        user?: string;
        bot_id?: string;
        subtype?: string;
        reactions?: { name?: string; users?: string[] }[];
      };
    };
    const message = result?.message;
    if (
      !response.ok ||
      result?.ok !== true ||
      result.type !== "message" ||
      result.channel !== channel ||
      message?.ts !== timestamp ||
      typeof message.text !== "string"
    )
      throw new Error("Message lookup failed");
    if (message.bot_id || message.subtype === "bot_message")
      return { status: "ignored" };
    if (
      message.reactions?.some(
        (reaction) =>
          reaction.name === SAVED_REACTION &&
          reaction.users?.includes(botUserId),
      )
    ) {
      return { status: "duplicate" };
    }
    if (typeof message.user !== "string" || !message.user)
      throw new Error("Message author missing");
    let parsed;
    try {
      parsed = parseInventoryMessage(message.text, message.user, timestamp);
    } catch (error) {
      return {
        status: "invalid",
        detail:
          error instanceof Error ? error.message : "본문을 확인해 주세요.",
      };
    }
    const mention = parsed.foundByName?.match(/^<@([UW][A-Z0-9]+)>$/);
    const foundByName = mention
      ? await getSlackUserName(mention[1])
      : parsed.foundByName || (await getSlackUserName(message.user));
    const reportUrl = await getReportPermalink(channel, timestamp, signal);
    await appendInventoryRow(
      parsed.record,
      foundByName,
      reportUrl,
      signal,
      async () => {
        writeStarted = true;
      },
    );
    await markSaved(channel, timestamp, signal);
    console.info("inventory.message_saved", {
      channelId: channel,
      messageTs: timestamp,
    });
    return { status: "saved" };
  } catch {
    console.error("inventory.message_import_failed", {
      channelId: channel,
      messageTs: timestamp,
      writeStarted,
    });
    return { status: writeStarted ? "unconfirmed" : "failed" };
  }
}
