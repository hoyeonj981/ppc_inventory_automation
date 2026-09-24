import { createHmac } from "node:crypto";
import { env, withEnv } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const secret = "test-secret";
const importMessage = vi.fn();
const getByName = vi.fn(() => ({ importMessage }));
const event = () => ({ type: "event_callback", team_id: "T_TEST", event_id: "Ev_TEST", event: {
  type: "reaction_added", reaction: "owl", user: "U_REACTOR", item: { type: "message", channel: "C_TEST", ts: "1790211600.000001" },
} });

function signedRequest(payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return new Request("https://example.com/slack/events", { method: "POST", body,
    headers: { "Content-Type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${signature}` },
  });
}

async function send(request: Request) {
  return (await withEnv({ SLACK_SIGNING_SECRET: secret, SLACK_BOT_TOKEN: "xoxb-test",
    MESSAGE_IMPORTS: { getByName } as unknown as Cloudflare.Env["MESSAGE_IMPORTS"],
  }, async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  })) as Response;
}

describe("Slack reaction events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importMessage.mockResolvedValue({ status: "saved" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("imports owl reactions on old messages and notifies only the reacting user", async () => {
    expect((await send(signedRequest(event()))).status).toBe(200);
    expect(getByName).toHaveBeenCalledExactlyOnceWith("T_TEST:C_TEST:1790211600.000001");
    expect(importMessage).toHaveBeenCalledExactlyOnceWith("C_TEST", "1790211600.000001");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postEphemeral");
    expect(JSON.parse(init?.body as string)).toMatchObject({ channel: "C_TEST", user: "U_REACTOR", text: expect.stringContaining("메시지 변환") });
  });

  it("acknowledges before message conversion finishes", async () => {
    let complete!: (result: { status: string }) => void;
    importMessage.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    await withEnv({ SLACK_SIGNING_SECRET: secret, MESSAGE_IMPORTS: { getByName } as unknown as Cloudflare.Env["MESSAGE_IMPORTS"] }, async () => {
      const ctx = createExecutionContext();
      try {
        expect((await worker.fetch(signedRequest(event()), env, ctx)).status).toBe(200);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        complete({ status: "saved" });
        await waitOnExecutionContext(ctx);
      }
    });
  });

  it("answers signed URL verification without importing anything", async () => {
    const response = await send(signedRequest({ type: "url_verification", challenge: "test-challenge" }));
    expect(await response.json()).toEqual({ challenge: "test-challenge" });
    expect(getByName).not.toHaveBeenCalled();
  });

  it.each(["white_check_mark", "clipboard", "owl_custom"])("ignores other emoji %s", async (reaction) => {
    const payload = event(); payload.event.reaction = reaction;
    expect((await send(signedRequest(payload))).status).toBe(200);
    expect(getByName).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores reaction removal and non-message items", async () => {
    const payload = event(); payload.event.type = "reaction_removed";
    await send(signedRequest(payload));
    payload.event.type = "reaction_added"; payload.event.item.type = "file";
    await send(signedRequest(payload));
    expect(getByName).not.toHaveBeenCalled();
  });

  it("routes retried events and multiple reacting users to the same persistent message key", async () => {
    const request = signedRequest(event()); request.headers.set("x-slack-retry-num", "1");
    await send(request);
    const payload = event(); payload.event.user = "U_OTHER"; payload.event_id = "Ev_OTHER";
    await send(signedRequest(payload));
    expect(getByName.mock.calls).toEqual([["T_TEST:C_TEST:1790211600.000001"], ["T_TEST:C_TEST:1790211600.000001"]]);
  });

  it("rejects an unsigned event or URL verification before parsing", async () => {
    const request = signedRequest({ type: "url_verification", challenge: "untrusted" });
    request.headers.delete("x-slack-signature");
    const parse = vi.spyOn(request, "json");
    expect((await send(request)).status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
    expect(getByName).not.toHaveBeenCalled();
  });

  it.each([null, [], { type: "url_verification" }, { ...event(), team_id: "" },
    { ...event(), event: { ...event().event, item: { type: "message", channel: "C_TEST", ts: "bad" } } },
  ])("rejects malformed payloads: %j", async (payload) => {
    expect((await send(signedRequest(payload))).status).toBe(400);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("requires POST and JSON", async () => {
    expect((await send(new Request("https://example.com/slack/events"))).status).toBe(405);
    const request = signedRequest(event()); request.headers.set("Content-Type", "text/plain");
    expect((await send(request)).status).toBe(415);
  });

  it("does not retry storage when the result notification fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));
    expect((await send(signedRequest(event()))).status).toBe(200);
    expect(importMessage).toHaveBeenCalledTimes(1);
  });

  it("reports an uncertain importer result without retrying", async () => {
    importMessage.mockRejectedValue(new Error("Object reset"));
    expect((await send(signedRequest(event()))).status).toBe(200);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string).text).toContain("저장 여부를 확인하지 못했습니다");
    expect(importMessage).toHaveBeenCalledTimes(1);
  });
});
