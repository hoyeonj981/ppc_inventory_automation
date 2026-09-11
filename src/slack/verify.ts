import { env } from "cloudflare:workers";

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;
const encoder = new TextEncoder();
const TIMESTAMP_HEADER = "x-slack-request-timestamp";
const SIGNATURE_HEADER = "x-slack-signature";

export async function verifySlackRequest(request: Request): Promise<boolean> {
  const signingSecret = env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("Missing Slack signing secret");
    return false;
  }

  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);

  if (!timestamp || !/^\d+$/.test(timestamp)) return false;
  if (!signature || !/^v0=[0-9a-f]{64}$/.test(signature)) return false;

  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Date.now() / 1000 - timestampSeconds) > MAX_TIMESTAMP_SKEW_SECONDS
  ) {
    console.error("Timestamp is outside the allowed five-minute window");
    return false;
  }

  const rawBody = new Uint8Array(await request.clone().arrayBuffer());
  const prefix = encoder.encode(`v0:${timestamp}:`);
  const signedBody = new Uint8Array(prefix.length + rawBody.length);
  signedBody.set(prefix);
  signedBody.set(rawBody, prefix.length);

  const signatureBytes = new Uint8Array(32);
  for (let i = 0; i < signatureBytes.length; i++) {
    signatureBytes[i] = Number.parseInt(
      signature.slice(3 + i * 2, 5 + i * 2),
      16,
    );
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify("HMAC", key, signatureBytes, signedBody);
}
