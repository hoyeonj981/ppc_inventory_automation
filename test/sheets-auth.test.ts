import { withEnv } from "cloudflare:workers";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getGoogleAccessToken } from "../src/sheets/auth";

let privateKey: string;
let publicKey: CryptoKey;
const email = "inventory@example.iam.gserviceaccount.com";

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = await exportPKCS8(pair.privateKey);
  publicKey = pair.publicKey;
});

async function token(key = privateKey, accountEmail = email) {
  return await withEnv({ GOOGLE_SERVICE_ACCOUNT_EMAIL: accountEmail, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: key }, getGoogleAccessToken);
}

describe("Google service account authentication", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "test-token", token_type: "Bearer" })));
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])("signs a valid Sheets JWT with escaped newlines: %s", async (escaped) => {
    expect(await token(escaped ? privateKey.replaceAll("\n", "\\n") : privateKey)).toBe("test-token");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init?.method).toBe("POST");
    const form = init?.body as URLSearchParams;
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const { payload } = await jwtVerify(form.get("assertion")!, publicKey, {
      algorithms: ["RS256"], issuer: email, audience: "https://oauth2.googleapis.com/token",
    });
    expect(payload.scope).toBe("https://www.googleapis.com/auth/spreadsheets");
    expect(payload.exp! - payload.iat!).toBe(300);
  });

  it("rejects missing credentials before a network request", async () => {
    await expect(token("", "")).rejects.toThrow("Missing Google service account credentials");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an invalid key without exposing it", async () => {
    await expect(token("sensitive-invalid-key")).rejects.toThrow("Invalid Google service account credentials");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports the HTTP status without Google's error body", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "sensitive-body" }, { status: 403 }));
    await expect(token()).rejects.toThrow("Google token request failed (HTTP 403)");
  });

  it.each([null, {}, { access_token: "" }, { access_token: 123 }, { access_token: "test-token", token_type: "Other" }])("rejects malformed token response %j", async (body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    await expect(token()).rejects.toThrow("Invalid Google token response");
  });

  it("bounds network requests and sanitizes failures", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(fetch).mockRejectedValueOnce(new Error("sensitive-network-error"));
    await expect(token()).rejects.toThrow("Google token request failed or timed out");
    expect(timeout).toHaveBeenCalledWith(5000);
  });
});
