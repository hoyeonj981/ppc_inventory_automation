import { withEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendInventoryRow } from "../src/sheets/append";
import { saveInventorySubmission } from "../src/slack/save-inventory";
import { getReportPermalink, postInventoryReport } from "../src/slack/report";
import type { InventoryRecord } from "../src/core/inventory";

vi.mock("../src/sheets/append", () => ({ appendInventoryRow: vi.fn() }));
vi.mock("../src/slack/report", () => ({ postInventoryReport: vi.fn(), getReportPermalink: vi.fn() }));
const reportUrl = "https://test.slack.com/archives/C_CURRENT/p1800000000000001";
const record: InventoryRecord = {
  barcode: "001234", quantity: 3, expirationDate: "2027-03-01", location: "A0102",
  foundBy: "U_SUBMITTER", foundAt: "2027-01-15T08:00:00.000Z", type: "overstock",
};
let infoLog: ReturnType<typeof vi.spyOn>;
let errorLog: ReturnType<typeof vi.spyOn>;
let warnLog: ReturnType<typeof vi.spyOn>;
async function save() {
  await withEnv({ SLACK_BOT_TOKEN: "xoxb-test" }, () => saveInventorySubmission(record, "호연", "inventory:test", "C_CURRENT"));
}

describe("background inventory storage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(postInventoryReport).mockResolvedValue("1800000000.000001");
    vi.mocked(getReportPermalink).mockResolvedValue(reportUrl);
    vi.mocked(appendInventoryRow).mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
    infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("saves once, logs success and updates the acknowledgement view", async () => {
    await save();
    expect(postInventoryReport).toHaveBeenCalledExactlyOnceWith(record, "호연", "C_CURRENT", expect.any(AbortSignal));
    expect(getReportPermalink).toHaveBeenCalledExactlyOnceWith("C_CURRENT", "1800000000.000001", expect.any(AbortSignal));
    expect(vi.mocked(postInventoryReport).mock.calls[0][3]).toBe(vi.mocked(appendInventoryRow).mock.calls[0][3]);
    expect(appendInventoryRow).toHaveBeenCalledExactlyOnceWith(record, "호연", reportUrl, expect.any(AbortSignal));
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

  it("does not append or retry when posting the report is unconfirmed", async () => {
    vi.mocked(postInventoryReport).mockRejectedValue(new Error("Slack report outcome unknown"));
    await save();
    expect(postInventoryReport).toHaveBeenCalledTimes(1);
    expect(getReportPermalink).not.toHaveBeenCalled();
    expect(appendInventoryRow).not.toHaveBeenCalled();
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.view.title.text).toBe("저장 확인 필요");
    expect(JSON.stringify(body)).toContain("시트에는 저장하지 않았습니다");
    expect(errorLog).toHaveBeenCalledWith("inventory.save_unconfirmed", expect.objectContaining({ status: "report_unconfirmed" }));
  });

  it("distinguishes a posted report with an unavailable permalink and does not append", async () => {
    vi.mocked(getReportPermalink).mockRejectedValue(new Error("Slack report permalink lookup failed"));
    await save();
    expect(postInventoryReport).toHaveBeenCalledTimes(1);
    expect(appendInventoryRow).not.toHaveBeenCalled();
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(JSON.stringify(body)).toContain("채널 보고는 게시되었지만 메시지 링크를 가져오지 못해");
    expect(errorLog).toHaveBeenCalledWith("inventory.save_unconfirmed", expect.objectContaining({ status: "link_unconfirmed" }));
  });

  it("reserves time for result updates within the waitUntil lifetime", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await save();
    expect(timeout).toHaveBeenCalledWith(22000);
    expect(timeout).toHaveBeenCalledWith(2000);
  });

  it("warns users to check the sheet instead of blindly resubmitting after failure", async () => {
    vi.mocked(appendInventoryRow).mockRejectedValue(new Error("Google Sheets append outcome unknown"));
    await save();
    expect(infoLog).not.toHaveBeenCalledWith("inventory.saved", expect.anything());
    expect(errorLog).toHaveBeenCalledWith("inventory.save_unconfirmed", {
      submissionId: "inventory:test", status: "unconfirmed", reason: "Google Sheets append outcome unknown",
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
