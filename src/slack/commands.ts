import { verifySlackRequest } from "./verify";
import { openInventoryModal } from "./inventory";

export async function handleSlackCommand(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  if (!(await verifySlackRequest(request))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  const form = await request.formData();
  const command = form.get("command");
  if (
    typeof command !== "string" ||
    !command.startsWith("/") ||
    command.length < 2
  ) {
    return new Response("Invalid command", { status: 400 });
  }

  if (command !== "/inventory") {
    return Response.json({ response_type: "ephemeral", text: "지원하지 않는 명령어입니다." });
  }

  const triggerId = form.get("trigger_id");
  if (typeof triggerId !== "string" || !triggerId.trim()) {
    return new Response("Missing trigger ID", { status: 400 });
  }
  const channelId = form.get("channel_id");
  if (typeof channelId !== "string" || !channelId.trim()) {
    return new Response("Missing channel ID", { status: 400 });
  }
  if (!(await openInventoryModal(triggerId, channelId))) {
    return Response.json({
      response_type: "ephemeral",
      text: "입력 화면을 열 수 없습니다. 잠시 후 다시 시도해 주세요.",
    });
  }

  return new Response(null, { status: 200 });
}
