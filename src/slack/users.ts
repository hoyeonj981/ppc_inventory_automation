import { env } from "cloudflare:workers";

export async function getSlackUserName(userId: string): Promise<string> {
  if (!env.SLACK_BOT_TOKEN) {
    console.warn("Missing Slack bot token for user name lookup");
    return userId;
  }

  try {
    const response = await fetch(
      `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
      {
        headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
        // Leave time to acknowledge the submission within Slack's three-second limit.
        signal: AbortSignal.timeout(1000),
      },
    );
    const result = (await response.json()) as {
      ok?: boolean;
      user?: { profile?: { display_name?: unknown; real_name?: unknown } };
    };
    if (response.ok && result?.ok === true) {
      const profile = result.user?.profile;
      for (const name of [profile?.display_name, profile?.real_name]) {
        if (typeof name === "string" && name.trim()) return name.trim();
      }
      return userId;
    }
  } catch {
    // Do not log the token or full user profile. Lookup failure must not block submission.
  }
  console.warn("Failed to look up Slack user name; using Slack ID");
  return userId;
}
