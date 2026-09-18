import { createHmac } from "node:crypto";
import { env, withEnv } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

describe("inventory submission through Google storage", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([[false, false], [false, true], [true, false], [true, true]])("connects signed input through storage, existing headers: %s, photo: %s", async (hasHeaders, hasPhoto) => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const privateKey = await exportPKCS8(pair.privateKey);
    const calls: string[] = [];
    let savedBody: unknown;
    let completedView: { external_id: string; title: { text: string } } | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input as string);
      calls.push(url.hostname + url.pathname);
      if (url.hostname === "slack.com" && url.pathname === "/api/conversations.members") {
        expect(url.searchParams.get("channel")).toBe("C_CURRENT");
        return Response.json({ ok: true, members: ["U_SELECTED", "U_SUBMITTER"] });
      }
      if (url.hostname === "slack.com" && url.pathname === "/api/users.info") {
        expect(url.searchParams.get("user")).toBe("U_SELECTED");
        return Response.json({ ok: true, user: { profile: { display_name: "호연" } } });
      }
      if (url.hostname === "slack.com" && url.pathname === "/api/chat.postMessage") {
        const report = JSON.parse(init?.body as string);
        expect(report.channel).toBe("C_CURRENT");
        expect(report.text).toContain("부족재고 발견");
        expect(report.blocks).toHaveLength(hasPhoto ? 2 : 1);
        if (hasPhoto) expect(report.blocks[1].slack_file).toEqual({ id: "F123PHOTO" });
        return Response.json({ ok: true, channel: "C_CURRENT", ts: "1800000000.000001" });
      }
      if (url.hostname === "slack.com" && url.pathname === "/api/chat.getPermalink") {
        expect(url.searchParams.get("channel")).toBe("C_CURRENT");
        expect(url.searchParams.get("message_ts")).toBe("1800000000.000001");
        return Response.json({ ok: true, permalink: "https://test.slack.com/archives/C_CURRENT/p1800000000000001" });
      }
      if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
        return Response.json({ access_token: "test-google-token", token_type: "Bearer" });
      }
      if (url.hostname === "sheets.googleapis.com" && decodeURIComponent(url.pathname).endsWith("!A1:H1")) {
        if (init?.method === "PUT") {
          expect(hasHeaders).toBe(false);
          expect(JSON.parse(init.body as string)).toEqual({ majorDimension: "ROWS", values: [[
            "바코드", "수량", "소비기한", "발견로케이션", "발견자", "발견시각", "유형", "보고 메시지 링크",
          ]] });
          return Response.json({ updatedRows: 1, updatedCells: 8 });
        }
        return Response.json(hasHeaders ? { values: [["바코드", "수량", "소비기한", "발견로케이션", "발견자", "발견시각", "유형", "보고 메시지 링크"]] } : {});
      }
      if (url.hostname === "sheets.googleapis.com" && url.pathname.endsWith(":append")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer test-google-token" });
        savedBody = JSON.parse(init?.body as string);
        return Response.json({ updates: { updatedRows: 1, updatedCells: 8 } });
      }
      if (url.hostname === "slack.com" && url.pathname === "/api/views.update") {
        completedView = JSON.parse(init?.body as string).view;
        return Response.json({ ok: true });
      }
      throw new Error("Unexpected network request in storage integration test");
    });

    await withEnv({
      SLACK_SIGNING_SECRET: "test-secret", SLACK_BOT_TOKEN: "xoxb-test",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "inventory@example.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
      GOOGLE_INVENTORY_SHEET_ID: "test-sheet", GOOGLE_INVENTORY_SHEET_TAB_NAME: "재고",
    }, async () => {
      const payload = {
        type: "view_submission", user: { id: "U_SUBMITTER" },
        view: { callback_id: "inventory_submit", private_metadata: "C_CURRENT", state: { values: {
          found_by: { value: { selected_option: { value: "U_SELECTED" } } },
          barcode: { value: { value: "001234" } },
          quantity: { value: { value: "3" } },
          expiration_date: { value: { selected_date: "2027-03-01" } },
          location: { value: { value: " A-01-02 " } },
          type: { value: { selected_option: { value: "shortage" } } },
          ...(hasPhoto ? { photo: { value: { type: "file_input", files: [{ id: "F123PHOTO", filetype: "jpg" }] } } } : {}),
        } } },
      };
      const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", "test-secret").update(`v0:${timestamp}:${body}`).digest("hex");
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request("https://example.com/slack/interactions", {
        method: "POST", body,
        headers: { "Content-Type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${signature}` },
      }), env, ctx);
      expect(response.status).toBe(200);
      const ack = await response.json() as { response_action: string; view: { external_id: string; title: { text: string } } };
      expect(ack.response_action).toBe("update");
      expect(ack.view.title.text).toBe("저장 중");
      await waitOnExecutionContext(ctx);
      expect(savedBody).toEqual({ majorDimension: "ROWS", values: [[
        "001234", 3, "2027-03-01", "A-01-02", "호연", expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*\+09:00$/), "부족재고", "https://test.slack.com/archives/C_CURRENT/p1800000000000001",
      ]] });
      expect(completedView?.external_id).toBe(ack.view.external_id);
      expect(completedView?.title.text).toBe("저장 완료");
      expect(calls).toHaveLength(hasHeaders ? 8 : 9);
      expect(calls[0]).toBe("slack.com/api/conversations.members");
      expect(calls[1]).toBe("slack.com/api/users.info");
      expect(calls[2]).toBe("slack.com/api/chat.postMessage");
      expect(calls[3]).toBe("slack.com/api/chat.getPermalink");
      expect(calls[4]).toBe("oauth2.googleapis.com/token");
      expect(calls[5]).toMatch(/^sheets.googleapis.com\//);
      expect(decodeURIComponent(calls[5]).endsWith("!A1:H1")).toBe(true);
      expect(calls.at(-2)?.endsWith(":append")).toBe(true);
      expect(calls.at(-1)).toBe("slack.com/api/views.update");
    });
  });
});
