import { INVENTORY_CALLBACK_ID, inventoryConfirmation, parseInventoryValues } from "./inventory";
import { verifySlackRequest } from "./verify";

export async function handleSlackInteraction(request: Request): Promise<Response> {
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

  const result = parseInventoryValues(payload.view.state?.values, payload.user.id, receivedAt);
  if (result.errors) {
    return Response.json({ response_action: "errors", errors: result.errors });
  }

  return Response.json({ response_action: "update", view: inventoryConfirmation(result.record) });
}
