import { createHmac } from "node:crypto";
import { withEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySlackRequest } from "../src/slack/verify";

const secret = "test-signing-secret";
const now = 1_800_000_000;
const body = "command=%2Finventory&text=%EC%9E%AC%EA%B3%A0+%ED%99%95%EC%9D%B8";

function verifyRequest(request: Request) {
  return withEnv({ SLACK_SIGNING_SECRET: secret }, () =>
    verifySlackRequest(request),
  );
}

function signedRequest(payload = body, timestamp = String(now)): Request {
  const signature = createHmac("sha256", secret)
    .update(`v0:${timestamp}:${payload}`)
    .digest("hex");

  return new Request("https://example.com/slack/commands", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": `v0=${signature}`,
    },
    body: payload,
  });
}

describe("verifySlackRequest", () => {
  afterEach(() => vi.restoreAllMocks());

  function freezeTime(seconds = now) {
    vi.spyOn(Date, "now").mockReturnValue(seconds * 1000);
  }

  it("accepts a signed form and leaves its body available for parsing", async () => {
    freezeTime();
    const request = signedRequest();

    expect(await verifyRequest(request)).toBe(true);
    expect(request.bodyUsed).toBe(false);
    const form = await request.formData();
    expect(form.get("command")).toBe("/inventory");
    expect(form.get("text")).toBe("재고 확인");
  });

  it("accepts Slack's published signature example", async () => {
    freezeTime(1531420618);
    const request = new Request("https://example.com/slack/commands", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": "1531420618",
        "x-slack-signature":
          "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
      },
      body: "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c",
    });

    const valid = await withEnv(
      { SLACK_SIGNING_SECRET: "8f742231b10e8888abcd99yyyzzz85a5" },
      () => verifySlackRequest(request),
    );
    expect(valid).toBe(true);
  });

  it("accepts JSON with whitespace and literal Unicode", async () => {
    freezeTime();
    expect(
      await verifyRequest(signedRequest('{ "text": "재고 확인" }\n')),
    ).toBe(true);
  });

  it("rejects a modified body, including equivalent form encoding", async () => {
    freezeTime();
    const original = signedRequest();
    const modified = new Request(original.url, {
      method: "POST",
      headers: original.headers,
      body: body.replace("+", "%20"),
    });

    expect(await verifyRequest(modified)).toBe(false);
  });

  it("rejects a modified signature", async () => {
    freezeTime();
    const request = signedRequest();
    const signature = request.headers.get("x-slack-signature")!;
    request.headers.set(
      "x-slack-signature",
      signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0"),
    );
    expect(await verifyRequest(request)).toBe(false);
  });

  it("rejects a modified timestamp within the allowed time window", async () => {
    freezeTime();
    const request = signedRequest();
    request.headers.set("x-slack-request-timestamp", String(now - 1));
    expect(await verifyRequest(request)).toBe(false);
  });

  it.each([undefined, "", "wrong-secret"])(
    "rejects a missing or incorrect secret: %s",
    async (value) => {
      freezeTime();
      const valid = await withEnv({ SLACK_SIGNING_SECRET: value }, () =>
        verifySlackRequest(signedRequest()),
      );
      expect(valid).toBe(false);
    },
  );

  it.each([-301, 301])(
    "rejects timestamps outside the five-minute window (%s seconds)",
    async (offset) => {
      freezeTime();
      expect(
        await verifyRequest(signedRequest(body, String(now + offset))),
      ).toBe(false);
    },
  );

  it.each([-300, 300])(
    "accepts timestamps on the five-minute boundary (%s seconds)",
    async (offset) => {
      freezeTime();
      expect(
        await verifyRequest(signedRequest(body, String(now + offset))),
      ).toBe(true);
    },
  );

  it.each(["x-slack-request-timestamp", "x-slack-signature"])(
    "rejects a missing %s header",
    async (header) => {
      freezeTime();
      const request = signedRequest();
      request.headers.delete(header);
      expect(await verifyRequest(request)).toBe(false);
    },
  );

  it.each([
    "",
    "NaN",
    "Infinity",
    "1.8e9",
    "1800000000.0",
    "1800000000junk",
    "-1800000000",
    "9007199254740992",
  ])("rejects an invalid timestamp: %s", async (timestamp) => {
    freezeTime();
    expect(await verifyRequest(signedRequest(body, timestamp))).toBe(false);
  });

  it.each([
    "",
    "v1=" + "a".repeat(64),
    "v0=" + "g".repeat(64),
    "v0=" + "a".repeat(63),
    "v0=" + "a".repeat(65),
  ])("rejects a malformed signature: %s", async (signature) => {
    freezeTime();
    const request = signedRequest();
    request.headers.set("x-slack-signature", signature);
    expect(await verifyRequest(request)).toBe(false);
  });
});
