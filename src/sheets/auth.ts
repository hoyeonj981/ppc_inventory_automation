import { env } from "cloudflare:workers";
import { importPKCS8, SignJWT } from "jose";

export async function getGoogleAccessToken(): Promise<string> {
  if (
    !env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() ||
    !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim()
  ) {
    throw new Error("Missing Google service account credentials");
  }

  let assertion: string;
  try {
    const key = await importPKCS8(
      env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replaceAll("\\n", "\n"),
      "RS256",
    );
    assertion = await new SignJWT({
      scope: "https://www.googleapis.com/auth/spreadsheets",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(env.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim())
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  } catch {
    throw new Error("Invalid Google service account credentials");
  }

  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error("Google token request failed or timed out");
  }
  if (!response.ok)
    throw new Error(`Google token request failed (HTTP ${response.status})`);
  try {
    const result = (await response.json()) as {
      access_token?: unknown;
      token_type?: unknown;
    };
    if (
      typeof result?.access_token === "string" &&
      result.access_token &&
      result.token_type === "Bearer"
    ) {
      return result.access_token;
    }
  } catch {
    // Never expose Google's response body or credentials in errors.
  }
  throw new Error("Invalid Google token response");
}
