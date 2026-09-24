import { env } from "cloudflare:workers";
import { verifySlackRequest } from "./verify";
import type { MessageImportResult } from "./message-import";

async function importReaction(team: string, channel: string, timestamp: string, user: string): Promise<void> {
  let result: MessageImportResult;
  try {
    const importer = env.MESSAGE_IMPORTS.getByName(`${team}:${channel}:${timestamp}`);
    result = await importer.importMessage(channel, timestamp);
  } catch {
    console.error("inventory.message_import_unconfirmed", { channelId: channel, messageTs: timestamp });
    result = { status: "unconfirmed" };
  }
  const text = {
    saved: "🦉 메시지를 Google Sheets에 저장했습니다. 입력 경로: 메시지 변환",
    duplicate: "🦉 이미 저장한 메시지입니다. 중복으로 저장하지 않았습니다.",
    unconfirmed: "🦉 처리 중이거나 저장 여부를 확인하지 못했습니다. 중복 방지를 위해 다시 저장하지 않습니다. 시트와 관리자 로그를 확인해 주세요.",
    invalid: `🦉 저장하지 못했습니다. ${result.detail ?? "본문을 확인해 주세요."} 메시지를 수정한 뒤 부엉이 반응을 제거하고 다시 추가해 주세요.`,
    ignored: "🦉 사람이 작성한 재고 보고만 변환합니다. /r·/report로 게시한 보고는 이미 앱에서 저장을 처리합니다.",
    failed: "🦉 메시지 조회 또는 시트 저장 준비에 실패해 행을 추가하지 않았습니다. 관리자에게 앱 권한과 시트 설정 확인을 요청한 뒤 부엉이 반응을 제거하고 다시 추가해 주세요.",
  }[result.status];
  try {
    const response = await fetch("https://slack.com/api/chat.postEphemeral", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel, user, text, mrkdwn: false }),
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.json() as { ok?: boolean };
    if (response.ok && body?.ok === true) return;
  } catch {
    // Notification failure must not retry a sheet write.
  }
  console.warn("inventory.message_notice_failed", { channelId: channel, messageTs: timestamp, status: result.status });
}

export async function handleSlackEvent(request: Request, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  if (!(await verifySlackRequest(request))) return new Response("Unauthorized", { status: 401 });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return new Response("Unsupported Media Type", { status: 415 });
  }
  let payload;
  try { payload = await request.json(); } catch { return new Response("Invalid payload", { status: 400 }); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return new Response("Invalid payload", { status: 400 });
  const body = payload as {
    type?: string; challenge?: string; team_id?: string;
    event?: { type?: string; reaction?: string; user?: string; item?: { type?: string; channel?: string; ts?: string } };
  };
  if (body.type === "url_verification") {
    return typeof body.challenge === "string" && body.challenge
      ? Response.json({ challenge: body.challenge }) : new Response("Missing challenge", { status: 400 });
  }
  const event = body.event;
  if (body.type !== "event_callback" || event?.type !== "reaction_added" || event.reaction !== "owl" || event.item?.type !== "message") {
    return new Response(null, { status: 200 });
  }
  const { channel, ts } = event.item;
  if (typeof body.team_id !== "string" || !body.team_id || typeof channel !== "string" || !channel ||
      typeof ts !== "string" || !/^\d+\.\d+$/.test(ts) || !Number.isFinite(new Date(Number(ts) * 1000).getTime()) ||
      typeof event.user !== "string" || !event.user) return new Response("Invalid event", { status: 400 });
  ctx.waitUntil(importReaction(body.team_id, channel, ts, event.user));
  return new Response(null, { status: 200 });
}
