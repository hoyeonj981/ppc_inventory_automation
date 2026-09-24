import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendInventoryRow } from "../src/sheets/append";

vi.mock("../src/sheets/append", () => ({ appendInventoryRow: vi.fn() }));
const report = "과재고 발생 보고\n발견 크루명: 민들레\n발견일시/위치: 9월 24일 /A11-11-203\n법적소비기한 경과 여부: N\nSKU명: 롯데 찰옥수수 140ml\n전산재고 0, 실재고 1 / 과재고 1개 피박스 이동 완료";
const channel = "C_TEST";
const timestamp = "1790211600.000001";
const link = "https://test.slack.com/archives/C_TEST/p1790211600000001";
const stub = () => env.MESSAGE_IMPORTS.getByName(crypto.randomUUID());

describe("persistent message imports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(appendInventoryRow).mockImplementation(async (_record, _name, _url, _signal, beforeAppend) => { await beforeAppend?.(); });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input as string);
      if (url.pathname === "/api/reactions.get") return Response.json({ ok: true, type: "message", channel,
        message: { ts: timestamp, user: "U_AUTHOR", text: report } });
      if (url.pathname === "/api/chat.getPermalink") return Response.json({ ok: true, permalink: link });
      if (url.pathname === "/api/users.info") return Response.json({ ok: true, user: { profile: { display_name: "작성자" } } });
      throw new Error("Unexpected Slack request");
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("accepts the worker's RPC call through the configured namespace", async () => {
    expect(await stub().importMessage(channel, timestamp)).toEqual({ status: "saved" });
    expect(appendInventoryRow).toHaveBeenCalledTimes(1);
  });

  it("saves the parsed historical message with its original link and source", async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      expect(await instance.importMessage(channel, timestamp)).toEqual({ status: "saved" });
      expect(await state.storage.get("status")).toBe("saved");
    });
    expect(appendInventoryRow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      barcode: "", quantity: 1, expirationDate: "", location: "A11-11-203", source: "message", skuName: "롯데 찰옥수수 140ml",
      foundAt: new Date(Number(timestamp) * 1000).toISOString(), foundBy: "U_AUTHOR",
    }), "민들레", link, expect.any(AbortSignal), expect.any(Function));
  });

  it("prevents two concurrent imports and repeated reactions from appending twice", async () => {
    const object = stub();
    await runInDurableObject(object, async (instance) => {
      const results = await Promise.all([instance.importMessage(channel, timestamp), instance.importMessage(channel, timestamp)]);
      expect(results.some((result) => result.status === "saved")).toBe(true);
      expect(results.some((result) => result.status === "unconfirmed" || result.status === "duplicate")).toBe(true);
    });
    await runInDurableObject(object, async (instance) => {
      expect(await instance.importMessage(channel, timestamp)).toEqual({ status: "duplicate" });
    });
    expect(appendInventoryRow).toHaveBeenCalledTimes(1);
  });

  it("keeps uncertain writes blocked across subsequent requests", async () => {
    vi.mocked(appendInventoryRow).mockImplementation(async (_record, _name, _url, _signal, beforeAppend) => {
      await beforeAppend?.();
      throw new Error("Append outcome unknown");
    });
    await runInDurableObject(stub(), async (instance, state) => {
      expect(await instance.importMessage(channel, timestamp)).toEqual({ status: "unconfirmed" });
      expect(await state.storage.get("status")).toBe("unconfirmed");
      expect(await instance.importMessage(channel, timestamp)).toEqual({ status: "unconfirmed" });
    });
    expect(appendInventoryRow).toHaveBeenCalledTimes(1);
  });

  it("never appends after an interrupted previous attempt", async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      await state.storage.put("status", "processing");
      expect(await instance.importMessage(channel, timestamp)).toEqual({ status: "unconfirmed" });
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(appendInventoryRow).not.toHaveBeenCalled();
  });

  it("allows retry after auth or header failure before a row append is attempted", async () => {
    vi.mocked(appendInventoryRow).mockRejectedValueOnce(new Error("Google token request failed"));
    await runInDurableObject(stub(), async (instance, state) => {
      expect(await instance.importMessage(channel, timestamp)).toEqual({ status: "failed" });
      expect(await state.storage.get("status")).toBeUndefined();
      expect(await instance.importMessage(channel, timestamp)).toEqual({ status: "saved" });
    });
  });

  it("ignores app/bot reports that use the existing save flow", async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ ok: true, type: "message", channel,
      message: { ts: timestamp, bot_id: "B_APP", text: report } }));
    await runInDurableObject(stub(), async (instance, state) => {
      expect(await instance.importMessage(channel, timestamp)).toEqual({ status: "ignored" });
      expect(await state.storage.get("status")).toBeUndefined();
    });
    expect(appendInventoryRow).not.toHaveBeenCalled();
  });

  it("allows retry after correcting ambiguous report text", async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ ok: true, type: "message", channel,
      message: { ts: timestamp, user: "U_AUTHOR", text: report.replace("과재고 1개", "과재고 여러 개") } }));
    await runInDurableObject(stub(), async (instance, state) => {
      expect(await instance.importMessage(channel, timestamp)).toMatchObject({ status: "invalid", detail: expect.stringContaining("수량") });
      expect(await state.storage.get("status")).toBeUndefined();
      expect(await instance.importMessage(channel, timestamp)).toEqual({ status: "saved" });
    });
    expect(appendInventoryRow).toHaveBeenCalledTimes(1);
  });

  it("allows retry when Slack cannot read the message, without ever writing a row", async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ ok: false, error: "missing_scope" }));
    await runInDurableObject(stub(), async (instance, state) => {
      expect(await instance.importMessage(channel, timestamp)).toEqual({ status: "failed" });
      expect(await state.storage.get("status")).toBeUndefined();
    });
    expect(appendInventoryRow).not.toHaveBeenCalled();
  });
});
