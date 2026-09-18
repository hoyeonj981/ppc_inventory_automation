import { env } from "cloudflare:workers";
import type { InventoryRecord } from "./inventory";

export async function postInventoryReport(
  record: InventoryRecord,
  foundByName: string,
  channelId: string,
  signal: AbortSignal,
): Promise<string> {
  const text = [
    `${record.type === "overstock" ? "과재고" : "부족재고"} 발견`,
    `바코드: ${record.barcode} · 수량: ${record.quantity}개`,
    `로케이션: ${record.location} · 소비기한: ${record.expirationDate}`,
    `발견자: ${foundByName}`,
    `발견시각: ${new Date(record.foundAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })} (한국시간)`,
  ].join("\n");
  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: channelId, text, mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false,
        blocks: [
          { type: "section", text: { type: "plain_text", text } },
          ...(record.photoFileId ? [{ type: "image", slack_file: { id: record.photoFileId }, alt_text: "재고 발견 사진" }] : []),
        ],
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    });
    const result = await response.json() as { ok?: boolean; channel?: string; ts?: string };
    if (response.ok && result?.ok === true && result.channel === channelId &&
        typeof result.ts === "string" && /^\d+\.\d+$/.test(result.ts)) return result.ts;
  } catch {
    // A timeout may occur after Slack has posted the report. Never retry the write here.
  }
  throw new Error("Slack report outcome unknown; check channel before retrying");
}

export async function getReportPermalink(channelId: string, messageTs: string, signal: AbortSignal): Promise<string> {
  const url = new URL("https://slack.com/api/chat.getPermalink");
  url.searchParams.set("channel", channelId);
  url.searchParams.set("message_ts", messageTs);
  try {
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    });
    const result = await response.json() as { ok?: boolean; permalink?: string };
    if (response.ok && result?.ok === true && typeof result.permalink === "string") {
      const permalink = new URL(result.permalink);
      if (permalink.protocol === "https:" && permalink.hostname.endsWith(".slack.com")) return permalink.href;
    }
  } catch {
    // Never include Slack response bodies or credentials in errors.
  }
  throw new Error("Slack report permalink lookup failed");
}
