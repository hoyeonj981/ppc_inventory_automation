import { createHmac } from "node:crypto";
import { withEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { parseInventoryValues } from "../src/slack/inventory";

const secret = "test-signing-secret";
const now = 1_800_000_000;

function submission() {
  return {
    type: "view_submission",
    user: { id: "U_SUBMITTER" },
    view: {
      callback_id: "inventory_submit",
      state: { values: {
        barcode: { value: { value: "0012345678901" } },
        quantity: { value: { value: "3" } },
        expiration_date: { value: { selected_date: "2027-03-01" } },
        location: { value: { value: " A-01-02 " } },
        type: { value: { selected_option: { value: "overstock" } } },
      } },
    },
  };
}

function requestFor(payload: unknown) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const signature = createHmac("sha256", secret).update(`v0:${now}:${body}`).digest("hex");
  return new Request("https://example.com/slack/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(now),
      "x-slack-signature": `v0=${signature}`,
    },
    body,
  });
}

async function send(request: Request) {
  return await withEnv({ SLACK_SIGNING_SECRET: secret }, () => worker.fetch(request)) as Response;
}

describe("inventory submission", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now * 1000));
  afterEach(() => vi.restoreAllMocks());

  it("preserves barcode zeros, normalizes location, and records submitter and submission time", () => {
    const result = parseInventoryValues(submission().view.state.values, "U_SUBMITTER", "2027-01-15T08:00:00.000Z");
    expect(result.record).toEqual({
      barcode: "0012345678901", quantity: 3, expirationDate: "2027-03-01",
      location: "A0102", foundBy: "U_SUBMITTER", foundAt: "2027-01-15T08:00:00.000Z",
      type: "overstock",
    });
  });

  it.each(["overstock", "shortage"])("shows submitted values for %s without claiming to save them", async (type) => {
    const payload = submission();
    payload.view.state.values.type.value.selected_option.value = type;
    const response = await send(requestFor(payload));
    expect(response.status).toBe(200);
    const result = await response.json() as { response_action: string; view: { blocks: { text?: { text: string }; elements?: { text: string }[] }[] } };
    expect(result.response_action).toBe("update");
    const text = result.view.blocks[0].text?.text;
    expect(text).toContain("0012345678901");
    expect(text).toContain("A0102");
    expect(text).toContain("U_SUBMITTER");
    expect(text).toContain(new Date(now * 1000).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }));
    expect(text).toContain(type === "overstock" ? "과재고" : "부족재고");
    expect(result.view.blocks[1].elements?.[0].text).toContain("저장되지 않았습니다");
  });

  it.each(["0", "-1", "1.5", "1e3", "", "9007199254740992"])("keeps the modal open for invalid quantity %s", async (value) => {
    const payload = submission();
    payload.view.state.values.quantity.value.value = value;
    const response = await send(requestFor(payload));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ response_action: "errors", errors: { quantity: expect.any(String) } });
  });

  it("returns block-specific errors for all invalid fields", async () => {
    const payload = submission();
    payload.view.state.values.barcode.value.value = " ";
    payload.view.state.values.expiration_date.value.selected_date = "2027-02-30";
    payload.view.state.values.location.value.value = "---";
    payload.view.state.values.type.value.selected_option.value = "other";
    const response = await send(requestFor(payload));
    expect(await response.json()).toMatchObject({ response_action: "errors", errors: {
      barcode: expect.any(String), expiration_date: expect.any(String),
      location: expect.any(String), type: expect.any(String),
    } });
  });

  it("handles missing input state as field errors", async () => {
    const payload = submission();
    const response = await send(requestFor({ ...payload, view: { callback_id: "inventory_submit" } }));
    expect(await response.json()).toMatchObject({ response_action: "errors", errors: {
      barcode: expect.any(String), quantity: expect.any(String), expiration_date: expect.any(String),
      location: expect.any(String), type: expect.any(String),
    } });
  });

  it("ignores forged discovery fields and uses the submitting Slack user", async () => {
    const payload = submission();
    Object.assign(payload.view.state.values, { found_by: { value: { value: "U_OTHER" } }, found_at: { value: { value: "2000-01-01" } } });
    const response = await send(requestFor(payload));
    const text = JSON.stringify(await response.json());
    expect(text).toContain("U_SUBMITTER");
    expect(text).not.toContain("U_OTHER");
    expect(text).not.toContain("2000-01-01");
  });

  it("rejects an unsigned submission before parsing", async () => {
    const request = requestFor(submission());
    request.headers.delete("x-slack-signature");
    const parse = vi.spyOn(request, "formData");
    expect((await send(request)).status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
  });

  it("rejects a submission without a Slack user ID", async () => {
    const payload = submission();
    payload.user.id = "";
    expect((await send(requestFor(payload))).status).toBe(400);
  });

  it.each([null, [], 123])("rejects a non-object payload: %s", async (payload) => {
    expect((await send(requestFor(payload))).status).toBe(400);
  });

  it("acknowledges unrelated callbacks without processing inventory", async () => {
    const payload = submission();
    payload.view.callback_id = "other_modal";
    const response = await send(requestFor(payload));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("rejects GET requests", async () => {
    const response = await send(new Request("https://example.com/slack/interactions"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
