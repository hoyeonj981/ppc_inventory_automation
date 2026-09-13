import { withEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendInventoryRow } from "../src/sheets/append";
import { getGoogleAccessToken } from "../src/sheets/auth";
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ updates: { updatedRows: 1, updatedCells: 7 } }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("appends seven RAW values to the configured tab without overwriting rows", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await append();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = vi.mocked(fetch).mock.calls[0];
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
    expect(timeout).toHaveBeenCalledWith(10000);
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
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats a timeout as unknown and does not retry an ambiguous write", async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    await expect(append()).rejects.toThrow("append outcome unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { updates: { updatedRows: 0, updatedCells: 0 } }, { updates: { updatedRows: 1, updatedCells: 6 } }])("does not claim success for unexpected response %j", async (body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    await expect(append()).rejects.toThrow("append outcome unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry after a non-JSON success response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("not JSON"));
    await expect(append()).rejects.toThrow("append outcome unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
