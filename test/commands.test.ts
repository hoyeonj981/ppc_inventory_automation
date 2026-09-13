import { createHmac } from "node:crypto";
import { env, withEnv } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const secret = "test-signing-secret";
const now = 1_800_000_000;
const body =
  "command=%2Finventory&text=%EC%9E%AC%EA%B3%A0+%ED%99%95%EC%9D%B8&trigger_id=test-trigger";

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
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens the inventory modal and acknowledges the command", async () => {
    const response = await send(signedRequest());
    expect(response.status).toBe(200);
    expect(response.text).toBe("");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://slack.com/api/views.open");
    expect(options?.method).toBe("POST");
    expect(options?.headers).toMatchObject({ Authorization: "Bearer xoxb-test" });
    const requestBody = JSON.parse(options?.body as string);
    expect(requestBody.trigger_id).toBe("test-trigger");
    expect(requestBody.view.callback_id).toBe("inventory_submit");
    expect(requestBody.view.blocks.filter((block: { type: string }) => block.type === "input")
      .map((block: { block_id: string }) => block.block_id))
      .toEqual(["type", "barcode", "quantity", "expiration_date", "location"]);
  });

  it("accepts a command with no arguments", async () => {
    expect(
      (await send(signedRequest("command=%2Finventory&text=&trigger_id=test-trigger"))).status,
    ).toBe(200);
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

  it.each(["text=test", "command=", "command=inventory", "command=%2F"])(
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

  it("rejects inventory commands without a trigger ID", async () => {
    expect((await send(signedRequest("command=%2Finventory"))).status).toBe(400);
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
