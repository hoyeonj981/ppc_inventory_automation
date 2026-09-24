import { describe, expect, it } from "vitest";
import { parseInventoryMessage } from "../src/slack/message-inventory";

const report = `과재고 발생 보고
• 발견 크루명: 민들레
• 발견일시/위치: 9월 24일 /A11-11-203
• 보증소비기한 경과 여부: N
• 법적소비기한 경과 여부: N
• SKU명: 롯데 찰옥수수 140ml
• 해당 로케이션 전산재고 0, 실재고 1 / 과재고 1개 피박스 이동 완료, 다른 로케이션 재고 일치`;
const timestamp = "1790211600.000001";
const parse = (text: string) => parseInventoryMessage(text, "U_AUTHOR", timestamp);

describe("inventory message conversion", () => {
  it("extracts the historical report without inventing barcode, expiration or a discovery year", () => {
    expect(parse(report)).toEqual({ foundByName: "민들레", record: {
      barcode: "", quantity: 1, expirationDate: "", location: "A11-11-203", foundBy: "U_AUTHOR",
      foundAt: new Date(Number(timestamp) * 1000).toISOString(), type: "overstock", source: "message",
    } });
  });

  it("handles reordered lines, emphasis, full-width colons and spacing", () => {
    const variant = report.split("\n").reverse().join("\r\n").replaceAll("• ", "- ")
      .replaceAll(":", "：").replaceAll("과재고", "과 재고").replace("발견 크루명", "**발견 크루 명**");
    expect(parse(variant)).toEqual(parse(report));
  });

  it("reads shortage counts instead of computerized and physical stock", () => {
    expect(parse(report.replaceAll("과재고", "부족재고").replace("전산재고 0, 실재고 1", "전산재고 91, 실재고 90")).record)
      .toMatchObject({ type: "shortage", quantity: 1 });
  });

  it("accepts separate location, quantity and complete discovery time fields", () => {
    expect(parse(`부족재고 발생 보고\n수량: 2개\n발견로케이션: A-01-02\n발견자: <@U_FOUND>\n바코드: 00123\n소비기한: 2027.3.1\n발견일시: 2026-09-24 08:30`))
      .toMatchObject({ foundByName: "<@U_FOUND>", record: {
        barcode: "00123", quantity: 2, expirationDate: "2027-03-01", location: "A-01-02", foundAt: "2026-09-23T23:30:00.000Z",
      } });
  });

  it("supports a full discovery datetime in the combined date/location field", () => {
    expect(parse(report.replace("9월 24일", "2026/9/24 08:30")).record.foundAt).toBe("2026-09-23T23:30:00.000Z");
  });

  it.each(["N/A", "없음", "미기재", "-"])("keeps absent expiration %s empty for sheet N/A formatting", (value) => {
    expect(parse(`${report}\n소비기한: ${value}`).record.expirationDate).toBe("");
  });

  it("leaves name resolution to the author fallback when the discovery name is absent", () => {
    const result = parse(report.replace("• 발견 크루명: 민들레\n", ""));
    expect(result.foundByName).toBeUndefined();
    expect(result.record.foundBy).toBe("U_AUTHOR");
  });

  it.each(["0", "-1", "1.5", "1,2", "1~2", "1/2", "9007199254740992"])("rejects invalid variance quantity %s", (value) => {
    expect(() => parse(report.replace("과재고 1개", `과재고 ${value}개`))).toThrow("수량");
  });

  it("supports correctly grouped counts", () => {
    expect(parse(report.replace("과재고 1개", "과재고 1,234개")).record.quantity).toBe(1234);
  });

  it.each([
    report.replace("과재고 1개", "재고 이동"),
    `${report}\n수량: 2`,
    `${report}\n부족재고 발생 보고`,
    `${report}\nSKU명: 다른 상품`,
    report.replace("/A11-11-203", ""),
    `${report}\n발견로케이션: B-01-02`,
    `${report}\n소비기한: 2027-02-30`,
    `${report}\n소비기한: 12월 31일`,
  ])("rejects ambiguous or incomplete values instead of guessing: %s", (text) => {
    expect(() => parse(text)).toThrow();
  });
});
