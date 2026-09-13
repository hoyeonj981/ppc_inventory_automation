import { createHmac } from "node:crypto";
import { env, withEnv } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { parseInventoryValues } from "../src/slack/inventory";
import { saveInventorySubmission } from "../src/slack/save-inventory";

vi.mock("../src/slack/save-inventory", () => ({ saveInventorySubmission: vi.fn() }));

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
  return await withEnv({ SLACK_SIGNING_SECRET: secret, SLACK_BOT_TOKEN: "xoxb-test" }, async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }) as Response;
}

describe("inventory submission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(saveInventorySubmission).mockResolvedValue(undefined);
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, user: { profile: {} } }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("preserves barcode zeros, normalizes location, and records submitter and submission time", () => {
    const result = parseInventoryValues(submission().view.state.values, "U_SUBMITTER", "2027-01-15T08:00:00.000Z");
    expect(result.record).toEqual({
      barcode: "0012345678901", quantity: 3, expirationDate: "2027-03-01",
      location: "A0102", foundBy: "U_SUBMITTER", foundAt: "2027-01-15T08:00:00.000Z",
      type: "overstock",
    });
  });

  it.each(["overstock", "shortage"])("shows pending values for %s and schedules storage", async (type) => {
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
    expect(result.view.blocks[1].elements?.[0].text).toContain("저장 중");
    expect(saveInventorySubmission).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ barcode: "0012345678901", foundBy: "U_SUBMITTER", type }),
      "U_SUBMITTER", expect.stringMatching(/^inventory:/),
    );
  });

  it.each(["0", "-1", "1.5", "1e3", "", "9007199254740992"])("keeps the modal open for invalid quantity %s", async (value) => {
    const payload = submission();
    payload.view.state.values.quantity.value.value = value;
    const response = await send(requestFor(payload));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ response_action: "errors", errors: { quantity: expect.any(String) } });
    expect(fetch).not.toHaveBeenCalled();
    expect(saveInventorySubmission).not.toHaveBeenCalled();
  });

  it.each([
    [{ display_name: " 호연 ", real_name: "장호연" }, "호연"],
    [{ display_name: " ", real_name: " 장호연 " }, "장호연"],
    [{ display_name: null, real_name: "장호연" }, "장호연"],
    [{}, "U_SUBMITTER"],
    [{ display_name: 123, real_name: null }, "U_SUBMITTER"],
  ])("uses the submitting user's profile name with fallbacks: %j", async (profile, name) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ok: true, user: { profile } }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const response = await send(requestFor(submission()));
    expect(response.status).toBe(200);
    const result = await response.json() as { response_action: string; view: { blocks: { text: { text: string } }[] } };
    expect(result.response_action).toBe("update");
    expect(result.view.blocks[0].text.text).toContain(`발견자: ${name}`);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://slack.com/api/users.info?user=U_SUBMITTER",
      expect.objectContaining({ headers: { Authorization: "Bearer xoxb-test" }, signal: expect.any(AbortSignal) }),
    );
    expect(timeout).toHaveBeenCalledWith(1000);
  });

  it.each([
    [200, { ok: false, error: "missing_scope" }],
    [429, { ok: false, error: "ratelimited" }],
    [503, { ok: true, user: { profile: { display_name: "무시할 이름" } } }],
    [200, null],
  ])("still confirms with Slack ID when profile lookup fails: %s %j", async (status, body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body, { status }));
    const response = await send(requestFor(submission()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ response_action: "update", view: {
      blocks: expect.arrayContaining([expect.objectContaining({ text: expect.objectContaining({ text: expect.stringContaining("발견자: U_SUBMITTER") }) })]),
    } });
  });

  it.each([new Error("Network failure"), new DOMException("Timed out", "TimeoutError")])("still confirms when profile lookup rejects: %s", async (error) => {
    vi.mocked(fetch).mockRejectedValue(error);
    const response = await send(requestFor(submission()));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("발견자: U_SUBMITTER");
  });

  it("still confirms when the profile response is not JSON", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("not JSON"));
    const response = await send(requestFor(submission()));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("발견자: U_SUBMITTER");
  });

  it("still confirms without a bot token and does not call Slack", async () => {
    const response = await withEnv({ SLACK_SIGNING_SECRET: secret, SLACK_BOT_TOKEN: "" }, async () => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(requestFor(submission()), env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    }) as Response;
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("발견자: U_SUBMITTER");
    expect(fetch).not.toHaveBeenCalled();
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
    expect(fetch).not.toHaveBeenCalled();
    expect(saveInventorySubmission).not.toHaveBeenCalled();
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
    expect(saveInventorySubmission).not.toHaveBeenCalled();
  });

  it("rejects GET requests", async () => {
    const response = await send(new Request("https://example.com/slack/interactions"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("acknowledges without waiting for Google storage and shares the result view ID", async () => {
    let complete!: () => void;
    vi.mocked(saveInventorySubmission).mockReturnValue(new Promise<void>((resolve) => { complete = resolve; }));
    await withEnv({ SLACK_SIGNING_SECRET: secret, SLACK_BOT_TOKEN: "xoxb-test" }, async () => {
      const ctx = createExecutionContext();
      try {
        const response = await worker.fetch(requestFor(submission()), env, ctx);
        expect(response.status).toBe(200);
        const result = await response.json() as { view: { external_id: string } };
        expect(saveInventorySubmission).toHaveBeenCalledWith(expect.any(Object), "U_SUBMITTER", result.view.external_id);
      } finally {
        complete();
        await waitOnExecutionContext(ctx);
      }
    });
  });
});
