export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "ppc-inventory-automation",
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
