import { handleSlackCommand } from "./slack/commands";
import { handleSlackInteraction } from "./slack/interactions";
import { handleSlackEvent } from "./slack/events";

export { MessageImport } from "./slack/message-import";

export default {
  async fetch(request: Request, _env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "ppc-inventory-automation",
      });
    }

    if (url.pathname === "/slack/commands") {
      return handleSlackCommand(request);
    }

    if (url.pathname === "/slack/interactions") {
      return handleSlackInteraction(request, ctx);
    }

    if (url.pathname === "/slack/events") {
      return handleSlackEvent(request, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
