import { withEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendInventoryRow } from "../src/sheets/append";
import { getGoogleAccessToken } from "../src/sheets/auth";
import { INVENTORY_SHEET_HEADERS } from "../src/sheets/inventory";
import type { InventoryRecord } from "../src/slack/inventory";

vi.mock("../src/sheets/auth", () => ({ getGoogleAccessToken: vi.fn() }));
const record: InventoryRecord = {
  barcode: "001234", quantity: 3, expirationDate: "2027-03-01", location: "A0102",
  foundBy: "U_SUBMITTER", foundAt: "2027-01-15T08:00:00.000Z", type: "overstock",
};
async function append(sheetId = "test-sheet", tabName = "재고 '발견'") {
  await withEnv({ GOOGLE_INVENTORY_SHEET_ID: sheetId, GOOGLE_INVENTORY_SHEET_TAB_NAME: tabName }, () => appendInventoryRow(record, "호연"));
}

describe("Google Sheets append", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoogleAccessToken).mockResolvedValue("test-token");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ updates: { updatedRows: 1, updatedCells: 7 } }))
      .mockResolvedValueOnce(Response.json({ values: [INVENTORY_SHEET_HEADERS] }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("appends seven RAW values to the configured tab without overwriting rows", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await append();
    expect(fetch).toHaveBeenCalledTimes(2);
    const [headerInput, headerInit] = vi.mocked(fetch).mock.calls[0];
    const headerUrl = new URL(headerInput as string);
    expect(decodeURIComponent(headerUrl.pathname)).toBe("/v4/spreadsheets/test-sheet/values/'재고 ''발견'''!A1:G1");
    expect(headerUrl.searchParams.get("majorDimension")).toBe("ROWS");
    expect(headerUrl.searchParams.get("valueRenderOption")).toBe("FORMULA");
    expect(headerInit?.headers).toEqual({ Authorization: "Bearer test-token" });
    const [input, init] = vi.mocked(fetch).mock.calls[1];
    const url = new URL(input as string);
    expect(url.origin).toBe("https://sheets.googleapis.com");
    expect(decodeURIComponent(url.pathname)).toBe("/v4/spreadsheets/test-sheet/values/'재고 ''발견'''!A:G:append");
    expect(url.searchParams.get("valueInputOption")).toBe("RAW");
    expect(url.searchParams.get("insertDataOption")).toBe("INSERT_ROWS");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer test-token", "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({ majorDimension: "ROWS", values: [[
      "001234", 3, "2027-03-01", "A0102", "호연", "2027-01-15T08:00:00.000Z", "과재고",
    ]] });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(15000);
    expect(headerInit?.signal).toBe(init?.signal);
  });

  it.each([["", "재고"], ["test-sheet", " "]])("rejects missing target settings before authentication", async (id, tab) => {
    await expect(append(id, tab)).rejects.toThrow("Missing Google inventory sheet configuration");
    expect(getGoogleAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not append when authentication fails", async () => {
    vi.mocked(getGoogleAccessToken).mockRejectedValue(new Error("Google token request failed (HTTP 403)"));
    await expect(append()).rejects.toThrow("Google token request failed (HTTP 403)");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([403, 404, 429, 500])("reports HTTP %s without retrying or exposing the error body", async (status) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "sensitive-body" }, { status }));
    await expect(append()).rejects.toThrow(`Google Sheets append failed (HTTP ${status}); check sheet before retrying`);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats a timeout as unknown and does not retry an ambiguous write", async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    await expect(append()).rejects.toThrow("append outcome unknown");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { updates: { updatedRows: 0, updatedCells: 0 } }, { updates: { updatedRows: 1, updatedCells: 6 } }])("does not claim success for unexpected response %j", async (body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    await expect(append()).rejects.toThrow("append outcome unknown");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry after a non-JSON success response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("not JSON"));
    await expect(append()).rejects.toThrow("append outcome unknown");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { values: [] }, { values: [[]] }, { values: [["", "", "", "", "", "", ""]] }])("creates an empty header row before appending: %j", async (headerBody) => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(Response.json(headerBody))
      .mockResolvedValueOnce(Response.json({ updatedRows: 1, updatedCells: 7 }))
      .mockResolvedValueOnce(Response.json({ updates: { updatedRows: 1, updatedCells: 7 } }));
    await append();
    expect(fetch).toHaveBeenCalledTimes(3);
    const [input, init] = vi.mocked(fetch).mock.calls[1];
    const url = new URL(input as string);
    expect(decodeURIComponent(url.pathname).endsWith("'재고 ''발견'''!A1:G1")).toBe(true);
    expect(url.searchParams.get("valueInputOption")).toBe("RAW");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({ majorDimension: "ROWS", values: [[
      "바코드", "수량", "소비기한", "발견로케이션", "발견자", "발견시각", "유형",
    ]] });
    expect(vi.mocked(fetch).mock.calls.map(([, options]) => options?.method ?? "GET")).toEqual(["GET", "PUT", "POST"]);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.signal === init?.signal)).toBe(true);
  });

  it.each([["사용자 지정 헤더"], ["", "수량"], [0], [false], [" "], ['=""']])("preserves any existing first-row value: %j", async (...row) => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(Response.json({ values: [row] }))
      .mockResolvedValueOnce(Response.json({ updates: { updatedRows: 1, updatedCells: 7 } }));
    await append();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([, options]) => options?.method ?? "GET")).toEqual(["GET", "POST"]);
  });

  it("creates headers only on the first submission and appends both records", async () => {
    let headers: string[] = [];
    vi.mocked(fetch).mockReset().mockImplementation(async (_input, init) => {
      if (init?.method === "PUT") {
        headers = JSON.parse(init.body as string).values[0];
        return Response.json({ updatedRows: 1, updatedCells: 7 });
      }
      if (init?.method === "POST") return Response.json({ updates: { updatedRows: 1, updatedCells: 7 } });
      return Response.json({ values: headers.length ? [headers] : [] });
    });
    await append();
    await append();
    expect(headers).toEqual(INVENTORY_SHEET_HEADERS);
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "PUT", "POST", "GET", "POST"]);
  });

  it.each([403, 404, 500])("does not write when header lookup returns HTTP %s", async (status) => {
    vi.mocked(fetch).mockReset().mockResolvedValueOnce(Response.json({ error: "sensitive-body" }, { status }));
    await expect(append()).rejects.toThrow(`Google Sheets header lookup failed (HTTP ${status})`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not write after header lookup timeout", async () => {
    vi.mocked(fetch).mockReset().mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
    await expect(append()).rejects.toThrow("Google Sheets header lookup failed or timed out");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([null, { values: null }, { values: "invalid" }, { values: ["invalid"] }, { values: [[], []] }])("does not write on malformed header response: %j", async (body) => {
    vi.mocked(fetch).mockReset().mockResolvedValueOnce(Response.json(body));
    await expect(append()).rejects.toThrow("Invalid Google Sheets header response");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not append when header creation fails", async () => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ error: "sensitive-body" }, { status: 403 }));
    await expect(append()).rejects.toThrow("Google Sheets header creation failed (HTTP 403)");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not append when header creation times out", async () => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(Response.json({}))
      .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
    await expect(append()).rejects.toThrow("Google Sheets header creation failed or timed out; inventory row not appended");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { updatedRows: 1, updatedCells: 6 }])("does not append without a confirmed header write: %j", async (body) => {
    vi.mocked(fetch).mockReset()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json(body));
    await expect(append()).rejects.toThrow("Google Sheets header creation not confirmed; inventory row not appended");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
