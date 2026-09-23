import { INVENTORY_CALLBACK_ID, inventoryConfirmation, parseInventoryValues } from "./inventory";
import { verifySlackRequest } from "./verify";
import { getSlackUserName } from "./users";
import { saveInventorySubmission } from "./save-inventory";
import { getChannelMemberIds } from "./members";

export async function handleSlackInteraction(request: Request, ctx: ExecutionContext): Promise<Response> {
  const receivedAt = new Date(Date.now()).toISOString();
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (!(await verifySlackRequest(request))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  const form = await request.formData();
  const rawPayload = form.get("payload");
  if (typeof rawPayload !== "string") return new Response("Invalid payload", { status: 400 });

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return new Response("Invalid payload", { status: 400 });
  }
  if (payload?.type !== "view_submission" || payload?.view?.callback_id !== INVENTORY_CALLBACK_ID) {
    return new Response(null, { status: 200 });
  }
  if (typeof payload.user?.id !== "string" || !payload.user.id.trim()) {
    return new Response("Missing user ID", { status: 400 });
  }

  const result = parseInventoryValues(payload.view.state?.values, receivedAt);
  if (result.errors) {
    return Response.json({ response_action: "errors", errors: result.errors });
  }

  const channelId = payload.view.private_metadata;
  if (typeof channelId !== "string" || !channelId.trim()) {
    return Response.json({ response_action: "errors", errors: { found_by: "채널 정보를 확인할 수 없습니다. 채널에서 /report를 다시 실행해 주세요." } });
  }
  try {
    const memberIds = await getChannelMemberIds(channelId, AbortSignal.timeout(1000));
    if (!memberIds.has(result.record.foundBy)) {
      return Response.json({ response_action: "errors", errors: { found_by: "현재 채널의 멤버를 선택해 주세요." } });
    }
  } catch {
    console.warn("Failed to verify discovery channel membership");
    return Response.json({ response_action: "errors", errors: { found_by: "채널 멤버를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요." } });
  }

  const foundByName = await getSlackUserName(result.record.foundBy);
  const submissionId = `inventory:${crypto.randomUUID()}`;
  ctx.waitUntil(saveInventorySubmission(result.record, foundByName, submissionId, channelId));
  return Response.json({
    response_action: "update",
    view: { ...inventoryConfirmation(result.record, foundByName), external_id: submissionId },
  });
}
