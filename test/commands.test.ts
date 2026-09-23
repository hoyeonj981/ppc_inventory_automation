import { createHmac } from "node:crypto";
import { env, withEnv } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const secret = "test-signing-secret";
const now = 1_800_000_000;
const body =
  "command=%2Freport&text=%EC%9E%AC%EA%B3%A0+%ED%99%95%EC%9D%B8&trigger_id=test-trigger&channel_id=C_CURRENT";

function signedRequest(payload = body, timestamp = now) {
  const signature = createHmac("sha256", secret)
    .update(`v0:${timestamp}:${payload}`)
    .digest("hex");

  return new Request("https://example.com/slack/commands", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${signature}`,
    },
    body: payload,
  });
}

async function send(request: Request, signingSecret = secret, botToken = "xoxb-test") {
  return (await withEnv({ SLACK_SIGNING_SECRET: signingSecret, SLACK_BOT_TOKEN: botToken }, async () => {
    const response = await worker.fetch(request, env, createExecutionContext());
    return {
      status: response.status,
      text: await response.text(),
      headers: response.headers,
    };
  })) as { status: number; text: string; headers: Headers };
}

describe("/slack/commands", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input as string);
      if (url.pathname === "/api/conversations.members") return Response.json({ ok: true, members: ["U1", "U2"] });
      if (url.pathname === "/api/users.list") return Response.json({ ok: true, members: [
        { id: "U1", profile: { display_name: "호연" } },
        { id: "U2", profile: { display_name: "민수" } },
      ] });
      return Response.json({ ok: true });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens the inventory modal and acknowledges /report", async () => {
    const response = await send(signedRequest());
    expect(response.status).toBe(200);
    expect(response.text).toBe("");
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, options] = vi.mocked(fetch).mock.calls[2];
    expect(url).toBe("https://slack.com/api/views.open");
    expect(options?.method).toBe("POST");
    expect(options?.headers).toMatchObject({ Authorization: "Bearer xoxb-test" });
    const requestBody = JSON.parse(options?.body as string);
    expect(requestBody.trigger_id).toBe("test-trigger");
    expect(requestBody.view.callback_id).toBe("inventory_submit");
    expect(requestBody.view.private_metadata).toBe("C_CURRENT");
    expect(requestBody.view.blocks.find((block: { block_id: string }) => block.block_id === "found_by").element)
      .toMatchObject({ type: "static_select", options: [
        { text: { type: "plain_text", text: "민수" }, value: "U2" },
        { text: { type: "plain_text", text: "호연" }, value: "U1" },
      ] });
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.signal === signal)).toBe(true);
    expect(requestBody.view.blocks.filter((block: { type: string }) => block.type === "input")
      .map((block: { block_id: string }) => block.block_id))
      .toEqual(["type", "barcode", "quantity", "expiration_date", "location", "found_by", "photo"]);
    expect(requestBody.view.blocks.find((block: { block_id: string }) => block.block_id === "photo"))
      .toMatchObject({ optional: true, element: { type: "file_input", filetypes: ["jpg", "jpeg", "png", "gif"], max_files: 1 } });
  });

  it("accepts a command with no arguments", async () => {
    expect(
      (await send(signedRequest("command=%2Freport&text=&trigger_id=test-trigger&channel_id=C_CURRENT"))).status,
    ).toBe(200);
  });

  it("includes every member in option groups when a channel has more than 100 people", async () => {
    const members = Array.from({ length: 101 }, (_, index) => ({ id: `U${index}`, profile: { display_name: `멤버 ${index}` } }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ ok: true, members: members.map((member) => member.id) }))
      .mockResolvedValueOnce(Response.json({ ok: true, members }));
    const response = await send(signedRequest());
    expect(response.text).toBe("");
    const view = JSON.parse(vi.mocked(fetch).mock.calls[2][1]?.body as string).view;
    const element = view.blocks.find((block: { block_id: string }) => block.block_id === "found_by").element;
    expect(element.options).toBeUndefined();
    expect(element.option_groups.map((group: { options: unknown[] }) => group.options.length)).toEqual([100, 1]);
    expect(new Set(element.option_groups.flatMap((group: { options: { value: string }[] }) => group.options.map((option) => option.value))).size).toBe(101);
  });

  it("reports an empty channel instead of opening an unusable member selector", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: true, members: [] }));
    const response = await send(signedRequest());
    expect(JSON.parse(response.text)).toMatchObject({ response_type: "ephemeral" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a modal API failure after successfully loading the members", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ ok: true, members: ["U1"] }))
      .mockResolvedValueOnce(Response.json({ ok: true, members: [{ id: "U1", profile: { display_name: "호연" } }] }))
      .mockResolvedValueOnce(Response.json({ ok: false, error: "trigger_expired" }));
    const response = await send(signedRequest());
    expect(JSON.parse(response.text)).toMatchObject({ response_type: "ephemeral" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects unsigned requests before parsing the body", async () => {
    const request = signedRequest();
    request.headers.delete("x-slack-signature");
    const parse = vi.spyOn(request, "formData");
    expect((await send(request)).status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a modified body", async () => {
    const original = signedRequest();
    const request = new Request(original.url, {
      method: "POST",
      headers: original.headers,
      body: body.replace("+", "%20"),
    });
    expect((await send(request)).status).toBe(401);
  });

  it.each([-301, 301])(
    "rejects requests with a timestamp offset of %s seconds",
    async (offset) => {
      expect((await send(signedRequest(body, now + offset))).status).toBe(401);
    },
  );

  it("rejects requests when the signing secret is missing", async () => {
    expect((await send(signedRequest(), "")).status).toBe(401);
  });

  it.each(["application/json", "multipart/form-data", ""])(
    "rejects unsupported content type %s",
    async (contentType) => {
      const request = signedRequest();
      request.headers.set("content-type", contentType);
      expect((await send(request)).status).toBe(415);
    },
  );

  it.each(["text=test", "command=", "command=report", "command=%2F"])(
    "rejects an invalid command payload: %s",
    async (payload) => {
      expect((await send(signedRequest(payload))).status).toBe(400);
    },
  );

  it("rejects GET requests and advertises POST", async () => {
    const response = await send(
      new Request("https://example.com/slack/commands"),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects report commands without a trigger ID", async () => {
    expect((await send(signedRequest("command=%2Freport"))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects report commands without a channel ID", async () => {
    expect((await send(signedRequest("command=%2Freport&trigger_id=test-trigger"))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("responds privately to unsupported commands", async () => {
    const response = await send(signedRequest("command=%2Funknown"));
    expect(JSON.parse(response.text)).toMatchObject({ response_type: "ephemeral" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a missing bot token without calling Slack", async () => {
    const response = await send(signedRequest(), secret, "");
    expect(JSON.parse(response.text)).toMatchObject({ response_type: "ephemeral" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([200, 503])("reports an unsuccessful Slack API response with HTTP %s", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: false, error: "invalid_auth" }, { status }));
    const response = await send(signedRequest());
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ response_type: "ephemeral" });
  });

  it("reports a network timeout and uses a bounded API request", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
    const response = await send(signedRequest());
    expect(JSON.parse(response.text)).toMatchObject({ response_type: "ephemeral" });
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
