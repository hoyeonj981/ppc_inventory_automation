import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("returns its health status", async () => {
    const response = await exports.default.fetch("https://example.com/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "ppc-inventory-automation",
    });
  });

  it("returns 404 for unknown routes", async () => {
    const response = await exports.default.fetch("https://example.com/unknown");

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not Found");
  });
});
