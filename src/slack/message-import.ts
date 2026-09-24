import { DurableObject, env } from "cloudflare:workers";
import { appendInventoryRow } from "../sheets/append";
import { parseInventoryMessage } from "./message-inventory";
import { getReportPermalink } from "./report";
import { getSlackUserName } from "./users";

export type MessageImportResult = { status: "saved" | "duplicate" | "unconfirmed" | "invalid" | "ignored" | "failed"; detail?: string };

// One persistent object per workspace/channel/message prevents concurrent and retried writes.
export class MessageImport extends DurableObject<Cloudflare.Env> {
  async importMessage(channel: string, timestamp: string): Promise<MessageImportResult> {
    const previous = await this.ctx.blockConcurrencyWhile(async () => {
      const status = await this.ctx.storage.get<string>("status");
      if (!status) await this.ctx.storage.put("status", "processing");
      return status;
    });
    if (previous) return { status: previous === "saved" ? "duplicate" : "unconfirmed" };

    const signal = AbortSignal.timeout(22000);
    let writeStarted = false;
    try {
      const url = new URL("https://slack.com/api/reactions.get");
      url.searchParams.set("channel", channel);
      url.searchParams.set("timestamp", timestamp);
      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      });
      const result = await response.json() as {
        ok?: boolean; type?: string; channel?: string;
        message?: { ts?: string; text?: string; user?: string; bot_id?: string; subtype?: string };
      };
      const message = result?.message;
      if (!response.ok || result?.ok !== true || result.type !== "message" || result.channel !== channel ||
          message?.ts !== timestamp || typeof message.text !== "string") throw new Error("Message lookup failed");
      if (message.bot_id || message.subtype === "bot_message") {
        await this.ctx.storage.delete("status");
        return { status: "ignored" };
      }
      if (typeof message.user !== "string" || !message.user) throw new Error("Message author missing");
      let parsed;
      try {
        parsed = parseInventoryMessage(message.text, message.user, timestamp);
      } catch (error) {
        await this.ctx.storage.delete("status");
        return { status: "invalid", detail: error instanceof Error ? error.message : "본문을 확인해 주세요." };
      }
      const mention = parsed.foundByName?.match(/^<@([UW][A-Z0-9]+)>$/);
      const foundByName = mention ? await getSlackUserName(mention[1])
        : parsed.foundByName || await getSlackUserName(message.user);
      const reportUrl = await getReportPermalink(channel, timestamp, signal);
      await appendInventoryRow(parsed.record, foundByName, reportUrl, signal, async () => {
        // Persist before appending. Auth/header failures can retry; uncertain appends cannot.
        await this.ctx.storage.put("status", "unconfirmed");
        writeStarted = true;
      });
      await this.ctx.storage.put("status", "saved");
      console.info("inventory.message_saved", { channelId: channel, messageTs: timestamp });
      return { status: "saved" };
    } catch {
      if (!writeStarted) await this.ctx.storage.delete("status");
      console.error("inventory.message_import_failed", { channelId: channel, messageTs: timestamp, writeStarted });
      return { status: writeStarted ? "unconfirmed" : "failed" };
    }
  }
}
