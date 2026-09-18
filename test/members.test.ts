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
      const options = await getChannelMemberOptions("C_CURRENT", "");
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

  it.each([" 호연 ", "jang", "u_selected"])("searches by display name, real name, and ID: %s", async (query) => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, members: ["U_SELECTED", "U_OTHER"] }))
      .mockResolvedValueOnce(Response.json({ ok: true, members: [
        { id: "U_SELECTED", profile: { display_name: "호연", real_name: "Jang" } }, user("U_OTHER", "민수"),
      ] }));
    await withEnv({ SLACK_BOT_TOKEN: "xoxb-test" }, async () => {
      expect((await getChannelMemberOptions("C_CURRENT", query)).map((option) => option.value)).toEqual(["U_SELECTED"]);
    });
  });

  it("limits results to 100 and can search members beyond that limit", async () => {
    const members = Array.from({ length: 101 }, (_, i) => user(`U${String(i).padStart(3, "0")}`, "가".repeat(80) + i));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => Response.json({
      ok: true, members: String(input).includes("conversations.members") ? members.map((member) => member.id) : members,
    }));
    await withEnv({ SLACK_BOT_TOKEN: "xoxb-test" }, async () => {
      const options = await getChannelMemberOptions("C_CURRENT", "");
      expect(options).toHaveLength(100);
      expect(options.every((option) => option.text.text.length <= 75)).toBe(true);
      expect((await getChannelMemberOptions("C_CURRENT", "U100"))[0].value).toBe("U100");
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
      await expect(getChannelMemberOptions("C_CURRENT", "")).rejects.toThrow();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not return partial options if a profile page fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, members: ["U1", "U2"] }))
      .mockResolvedValueOnce(Response.json({ ok: true, members: [user("U1")], response_metadata: { next_cursor: "next" } }))
      .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
    await withEnv({ SLACK_BOT_TOKEN: "xoxb-test" }, async () => {
      await expect(getChannelMemberOptions("C_CURRENT", "")).rejects.toThrow();
    });
  });
});
