import { handleSlackCommand } from "./slack/commands";
import { handleSlackInteraction } from "./slack/interactions";

export default {
  async fetch(request: Request): Promise<Response> {
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
      return handleSlackInteraction(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
