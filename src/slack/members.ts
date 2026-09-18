import { env } from "cloudflare:workers";

export async function getChannelMemberIds(channelId: string, signal: AbortSignal): Promise<Set<string>> {
  if (!env.SLACK_BOT_TOKEN) throw new Error("Missing Slack bot token");
  const members = new Set<string>();
  let cursor = "";
  do {
    const params = new URLSearchParams({ channel: channelId, limit: "200", cursor });
    const response = await fetch(`https://slack.com/api/conversations.members?${params}`, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` }, signal,
    });
    const result = await response.json() as {
      ok?: boolean; members?: string[]; response_metadata?: { next_cursor?: string };
    };
    if (!response.ok || !result?.ok || !Array.isArray(result.members)) {
      throw new Error("Failed to look up channel members");
    }
    for (const id of result.members) members.add(id);
    cursor = result.response_metadata?.next_cursor?.trim() || "";
  } while (cursor);
  return members;
}

export async function getChannelMemberOptions(channelId: string, signal: AbortSignal) {
  const memberIds = await getChannelMemberIds(channelId, signal);
  if (memberIds.size === 0) return [];
  const options: { text: { type: string; text: string }; value: string }[] = [];
  let cursor = "";
  do {
    const params = new URLSearchParams({ limit: "200", cursor });
    const response = await fetch(`https://slack.com/api/users.list?${params}`, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` }, signal,
    });
    const result = await response.json() as {
      ok?: boolean;
      members?: { id: string; is_bot?: boolean; deleted?: boolean; profile?: { display_name?: string; real_name?: string } }[];
      response_metadata?: { next_cursor?: string };
    };
    if (!response.ok || !result?.ok || !Array.isArray(result.members)) {
      throw new Error("Failed to look up channel member names");
    }
    for (const user of result.members) {
      if (!memberIds.delete(user.id) || user.is_bot || user.deleted || user.id === "USLACKBOT") continue;
      const name = user.profile?.display_name?.trim() || user.profile?.real_name?.trim() || user.id;
      options.push({ text: { type: "plain_text", text: name.slice(0, 75) }, value: user.id });
    }
    cursor = result.response_metadata?.next_cursor?.trim() || "";
  } while (cursor && memberIds.size > 0);
  return options.sort((a, b) => a.text.text.localeCompare(b.text.text, "ko"));
}
