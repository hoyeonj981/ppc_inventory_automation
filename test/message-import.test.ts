import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendInventoryRow } from "../src/sheets/append";
import { importMessage } from "../src/slack/message-import";

vi.mock("../src/sheets/append", () => ({ appendInventoryRow: vi.fn() }));
const report = "과재고 발생 보고\n발견 크루명: 민들레\n발견일시/위치: 9월 24일 /A11-11-203\n법적소비기한 경과 여부: N\nSKU명: 롯데 찰옥수수 140ml\n전산재고 0, 실재고 1 / 과재고 1개 피박스 이동 완료";
const channel = "C_TEST";
const timestamp = "1790211600.000001";
const link = "https://test.slack.com/archives/C_TEST/p1790211600000001";
const run = () => importMessage(channel, timestamp, "U_BOT");
const lookup = (message: Record<string, unknown>) => async () => Response.json({ ok: true, type: "message", channel,
  message: { ts: timestamp, user: "U_AUTHOR", text: report, ...message } });
const calls = (path: string) => vi.mocked(fetch).mock.calls.filter(([input]) => new URL(input as string).pathname === path);

describe("message imports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(appendInventoryRow).mockImplementation(async (_record, _name, _url, _signal, beforeAppend) => { await beforeAppend?.(); });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input as string);
      if (url.pathname === "/api/reactions.get") return lookup({})();
      if (url.pathname === "/api/chat.getPermalink") return Response.json({ ok: true, permalink: link });
      if (url.pathname === "/api/users.info") return Response.json({ ok: true, user: { profile: { display_name: "작성자" } } });
      if (url.pathname === "/api/reactions.add") return Response.json({ ok: true });
      throw new Error("Unexpected Slack request");
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("saves the parsed message with its original link and marks it with the bot's ✅", async () => {
    expect(await run()).toEqual({ status: "saved" });
    expect(appendInventoryRow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      barcode: "", quantity: 1, expirationDate: "", location: "A11-11-203", source: "message", skuName: "롯데 찰옥수수 140ml",
      foundAt: new Date(Number(timestamp) * 1000).toISOString(), foundBy: "U_AUTHOR",
    }), "민들레", link, expect.any(AbortSignal), expect.any(Function));
    expect(new URL(calls("/api/reactions.get")[0][0] as string).searchParams.get("full")).toBe("true");
    const [[, init]] = calls("/api/reactions.add");
    expect(JSON.parse(init?.body as string)).toEqual({ channel, timestamp, name: "white_check_mark" });
  });

  it("skips a message the bot already marked as saved", async () => {
    vi.mocked(fetch).mockImplementationOnce(lookup({ reactions: [{ name: "white_check_mark", users: ["U_OTHER", "U_BOT"] }] }));
    expect(await run()).toEqual({ status: "duplicate" });
    expect(appendInventoryRow).not.toHaveBeenCalled();
  });

  it("does not treat a ✅ from a person as the saved mark", async () => {
    vi.mocked(fetch).mockImplementationOnce(lookup({ reactions: [{ name: "white_check_mark", users: ["U_OTHER"] }] }));
    expect(await run()).toEqual({ status: "saved" });
    expect(appendInventoryRow).toHaveBeenCalledTimes(1);
  });

  it("still reports success when the saved mark cannot be added", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(input as string);
      if (url.pathname === "/api/reactions.get") return lookup({})();
      if (url.pathname === "/api/chat.getPermalink") return Response.json({ ok: true, permalink: link });
      return Response.json({ ok: false, error: "missing_scope" });
    });
    expect(await run()).toEqual({ status: "saved" });
  });

  it("reports an uncertain append without marking the message", async () => {
    vi.mocked(appendInventoryRow).mockImplementation(async (_record, _name, _url, _signal, beforeAppend) => {
      await beforeAppend?.();
      throw new Error("Append outcome unknown");
    });
    expect(await run()).toEqual({ status: "unconfirmed" });
    expect(calls("/api/reactions.add")).toHaveLength(0);
  });

  it("reports failure when auth or header checks fail before the append", async () => {
    vi.mocked(appendInventoryRow).mockRejectedValueOnce(new Error("Google token request failed"));
    expect(await run()).toEqual({ status: "failed" });
  });

  it("ignores app/bot reports that use the existing save flow", async () => {
    vi.mocked(fetch).mockImplementationOnce(lookup({ user: undefined, bot_id: "B_APP" }));
    expect(await run()).toEqual({ status: "ignored" });
    expect(appendInventoryRow).not.toHaveBeenCalled();
  });

  it("explains ambiguous report text", async () => {
    vi.mocked(fetch).mockImplementationOnce(lookup({ text: report.replace("과재고 1개", "과재고 여러 개") }));
    expect(await run()).toMatchObject({ status: "invalid", detail: expect.stringContaining("수량") });
    expect(appendInventoryRow).not.toHaveBeenCalled();
  });

  it("fails without writing when Slack cannot read the message", async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ ok: false, error: "missing_scope" }));
    expect(await run()).toEqual({ status: "failed" });
    expect(appendInventoryRow).not.toHaveBeenCalled();
  });
});
