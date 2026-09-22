import { withEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getReportPermalink, postInventoryReport } from "../src/slack/report";
import type { InventoryRecord } from "../src/slack/inventory";

const record: InventoryRecord = {
  barcode: "001234", quantity: 3, expirationDate: "2027-03-01", location: "A-01-02",
  foundBy: "U_SELECTED", foundAt: "2027-01-15T08:00:00.000Z", type: "overstock",
};
const signal = () => AbortSignal.timeout(22000);
const reportUrl = "https://test.slack.com/archives/C_CURRENT/p1800000000000001";

describe("Slack inventory report", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])("posts a summary with optional Slack photo, attached: %s", async (hasPhoto) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, channel: "C_CURRENT", ts: "1800000000.000001" }));
    const input = { ...record, ...(hasPhoto ? { photoFileId: "F123PHOTO" } : {}) };
    const ts = await withEnv({ SLACK_BOT_TOKEN: "xoxb-test" }, () => postInventoryReport(input, "호연 <!channel>", "C_CURRENT", signal()));
    expect(ts).toBe("1800000000.000001");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer xoxb-test" });
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ channel: "C_CURRENT", mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false });
    expect(body.text).toContain("과재고 발견");
    expect(body.text).toContain("001234");
    expect(body.text).toContain("A-01-02");
    expect(body.blocks[0].text).toEqual({ type: "plain_text", text: body.text });
    expect(body.blocks).toHaveLength(hasPhoto ? 2 : 1);
    if (hasPhoto) expect(body.blocks[1]).toEqual({ type: "image", slack_file: { id: "F123PHOTO" }, alt_text: "재고 발견 사진" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [200, { ok: false, error: "missing_scope" }], [429, { ok: false, error: "ratelimited" }],
    [200, { ok: true }], [200, null],
    [200, { ok: true, channel: "C_OTHER", ts: "1800000000.000001" }],
  ])("does not retry an unconfirmed report: HTTP %s, %j", async (status, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status }));
    await expect(postInventoryReport(record, "호연", "C_CURRENT", signal())).rejects.toThrow("Slack report outcome unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not leak network errors or repeat a possibly completed post", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("sensitive token"));
    await expect(postInventoryReport(record, "호연", "C_CURRENT", signal())).rejects.toThrow("Slack report outcome unknown (HTTP unknown, error: request_failed); check channel before retrying");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["missing_scope", "not_in_channel", "invalid_blocks", "invalid_auth", "ratelimited"])("preserves the Slack error code %s for diagnosis", async (error) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: false, error, details: "sensitive-body" }));
    await expect(postInventoryReport(record, "호연", "C_CURRENT", signal())).rejects.toThrow(
      `Slack report outcome unknown (HTTP 200, error: ${error}); check channel before retrying`,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not log arbitrary response content as an error code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: false, error: "sensitive body with credentials" }, { status: 502 }));
    await expect(postInventoryReport(record, "호연", "C_CURRENT", signal())).rejects.toThrow(
      "Slack report outcome unknown (HTTP 502, error: invalid_response); check channel before retrying",
    );
  });

  it("distinguishes request timeouts without retrying the report", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("sensitive timeout details", "TimeoutError"));
    await expect(postInventoryReport(record, "호연", "C_CURRENT", signal())).rejects.toThrow(
      "Slack report outcome unknown (HTTP unknown, error: timeout_or_abort); check channel before retrying",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retrieves the posted message permalink with the bot token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, permalink: reportUrl }));
    await withEnv({ SLACK_BOT_TOKEN: "xoxb-test" }, async () => {
      expect(await getReportPermalink("C_CURRENT", "1800000000.000001", signal())).toBe(reportUrl);
    });
    const [input, init] = vi.mocked(fetch).mock.calls[0];
    const url = new URL(input as string);
    expect(url.pathname).toBe("/api/chat.getPermalink");
    expect(url.searchParams.get("channel")).toBe("C_CURRENT");
    expect(url.searchParams.get("message_ts")).toBe("1800000000.000001");
    expect(init?.headers).toEqual({ Authorization: "Bearer xoxb-test" });
  });

  it.each([null, {}, { ok: false }, { ok: true, permalink: "javascript:alert(1)" }, { ok: true, permalink: "https://example.com/photo" }])("rejects an invalid permalink response: %j", async (body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    await expect(getReportPermalink("C_CURRENT", "1800000000.000001", signal())).rejects.toThrow("Slack report permalink lookup failed");
  });
});
