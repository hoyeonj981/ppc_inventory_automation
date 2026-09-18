import { withEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getChannelMemberIds, getChannelMemberOptions } from "../src/slack/members";

const user = (id: string, display_name = id) => ({ id, profile: { display_name } });

describe("channel member selection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("paginates members and profiles, excluding outsiders, bots, and deleted users", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, members: ["U1", "U2", "UBOT"], response_metadata: { next_cursor: "members-next" } }))
      .mockResolvedValueOnce(Response.json({ ok: true, members: ["U3", "UDELETED", "USLACKBOT"] }))
      .mockResolvedValueOnce(Response.json({ ok: true, members: [user("U1", "호연"), user("U_OUTSIDE"), { ...user("UBOT"), is_bot: true }], response_metadata: { next_cursor: "users-next" } }))
      .mockResolvedValueOnce(Response.json({ ok: true, members: [{ id: "U2", profile: { real_name: "민수" } }, user("U3", ""), { ...user("UDELETED"), deleted: true }, user("USLACKBOT")] }));
    await withEnv({ SLACK_BOT_TOKEN: "xoxb-test" }, async () => {
      const options = await getChannelMemberOptions("C_CURRENT", AbortSignal.timeout(2000));
      expect(options).toHaveLength(3);
      expect(options).toEqual(expect.arrayContaining([
        { text: { type: "plain_text", text: "호연" }, value: "U1" },
        { text: { type: "plain_text", text: "민수" }, value: "U2" },
        { text: { type: "plain_text", text: "U3" }, value: "U3" },
      ]));
    });
    const urls = fetchMock.mock.calls.map(([url]) => new URL(url as string));
    expect(urls[0].searchParams.get("channel")).toBe("C_CURRENT");
    expect(urls[1].searchParams.get("cursor")).toBe("members-next");
    expect(urls[3].searchParams.get("cursor")).toBe("users-next");
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toEqual({ Authorization: "Bearer xoxb-test" });
      expect(init?.signal).toBe(fetchMock.mock.calls[0][1]?.signal);
    }
  });

  it("keeps all members when there are more than 100", async () => {
    const members = Array.from({ length: 101 }, (_, i) => user(`U${String(i).padStart(3, "0")}`, "가".repeat(80) + i));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => Response.json({
      ok: true, members: String(input).includes("conversations.members") ? members.map((member) => member.id) : members,
    }));
    await withEnv({ SLACK_BOT_TOKEN: "xoxb-test" }, async () => {
      const options = await getChannelMemberOptions("C_CURRENT", AbortSignal.timeout(2000));
      expect(options).toHaveLength(101);
      expect(options.every((option) => option.text.text.length <= 75)).toBe(true);
      expect(options.some((option) => option.value === "U100")).toBe(true);
    });
  });

  it.each([200, 429, 503])("rejects failed membership responses with HTTP %s", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: false }, { status }));
    await withEnv({ SLACK_BOT_TOKEN: "xoxb-test" }, async () => {
      await expect(getChannelMemberIds("C_CURRENT", AbortSignal.timeout(1000))).rejects.toThrow();
    });
  });

  it("fails without a bot token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await withEnv({ SLACK_BOT_TOKEN: "" }, async () => {
      await expect(getChannelMemberOptions("C_CURRENT", AbortSignal.timeout(2000))).rejects.toThrow();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops scanning the workspace after all channel members are accounted for", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, members: ["U1", "UBOT"] }))
      .mockResolvedValueOnce(Response.json({ ok: true, members: [user("U1"), { ...user("UBOT"), is_bot: true }], response_metadata: { next_cursor: "unneeded-page" } }));
    await withEnv({ SLACK_BOT_TOKEN: "xoxb-test" }, async () => {
      const options = await getChannelMemberOptions("C_CURRENT", AbortSignal.timeout(2000));
      expect(options.map((option) => option.value)).toEqual(["U1"]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not return partial options if a profile page fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, members: ["U1", "U2"] }))
      .mockResolvedValueOnce(Response.json({ ok: true, members: [user("U1")], response_metadata: { next_cursor: "next" } }))
      .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
    await withEnv({ SLACK_BOT_TOKEN: "xoxb-test" }, async () => {
      await expect(getChannelMemberOptions("C_CURRENT", AbortSignal.timeout(2000))).rejects.toThrow();
    });
  });
});
