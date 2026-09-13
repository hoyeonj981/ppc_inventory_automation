import { withEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendInventoryRow } from "../src/sheets/append";
import { saveInventorySubmission } from "../src/slack/save-inventory";
import type { InventoryRecord } from "../src/slack/inventory";

vi.mock("../src/sheets/append", () => ({ appendInventoryRow: vi.fn() }));
const record: InventoryRecord = {
  barcode: "001234", quantity: 3, expirationDate: "2027-03-01", location: "A0102",
  foundBy: "U_SUBMITTER", foundAt: "2027-01-15T08:00:00.000Z", type: "overstock",
};
let infoLog: ReturnType<typeof vi.spyOn>;
let errorLog: ReturnType<typeof vi.spyOn>;
let warnLog: ReturnType<typeof vi.spyOn>;
async function save() {
  await withEnv({ SLACK_BOT_TOKEN: "xoxb-test" }, () => saveInventorySubmission(record, "호연", "inventory:test"));
}

describe("background inventory storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(appendInventoryRow).mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
    infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("saves once, logs success and updates the acknowledgement view", async () => {
    await save();
    expect(appendInventoryRow).toHaveBeenCalledExactlyOnceWith(record, "호연");
    expect(infoLog).toHaveBeenCalledWith("inventory.saved", { submissionId: "inventory:test" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://slack.com/api/views.update");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer xoxb-test" });
    const body = JSON.parse(init?.body as string);
    expect(body.external_id).toBe("inventory:test");
    expect(body.view.external_id).toBe("inventory:test");
    expect(body.view.title.text).toBe("저장 완료");
    expect(body.view.submit).toBeUndefined();
    expect(body.view.blocks[0].text.text).toContain("발견자: 호연");
    expect(JSON.stringify(body)).toContain("Google Sheets에 저장했습니다");
  });

  it("warns users to check the sheet instead of blindly resubmitting after failure", async () => {
    vi.mocked(appendInventoryRow).mockRejectedValue(new Error("Google Sheets append outcome unknown"));
    await save();
    expect(infoLog).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith("inventory.save_unconfirmed", {
      submissionId: "inventory:test", reason: "Google Sheets append outcome unknown",
    });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.view.title.text).toBe("저장 확인 필요");
    expect(JSON.stringify(body)).toContain("중복 입력");
    expect(appendInventoryRow).toHaveBeenCalledTimes(1);
  });

  it("retries the result update if the acknowledgement view is not yet available", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: false, error: "not_found" }));
    await save();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(appendInventoryRow).toHaveBeenCalledTimes(1);
    expect(warnLog).not.toHaveBeenCalled();
  });

  it("bounds UI retries when the user has closed the modal", async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ ok: false, error: "view_not_found" }));
    await save();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(appendInventoryRow).toHaveBeenCalledTimes(1);
    expect(warnLog).toHaveBeenCalledWith("inventory.status_update_failed", { submissionId: "inventory:test", status: "saved" });
  });

  it("keeps the successful storage outcome if Slack fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Slack unavailable"));
    await expect(save()).resolves.toBeUndefined();
    expect(appendInventoryRow).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalledWith("inventory.status_update_failed", { submissionId: "inventory:test", status: "saved" });
  });
});
