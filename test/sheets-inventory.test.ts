import { describe, expect, it } from "vitest";
import { toInventorySheetRow } from "../src/sheets/inventory";
import { parseInventoryValues, type InventoryRecord } from "../src/slack/inventory";

const record: InventoryRecord = {
  barcode: "0012345678901",
  quantity: 3,
  expirationDate: "2027-03-01",
  location: "A0102",
  foundBy: "U_SUBMITTER",
  foundAt: "2027-01-15T23:30:00.000Z",
  type: "overstock",
};

describe("inventory sheet row", () => {
  it.each([
    ["overstock", "과재고"],
    ["shortage", "부족재고"],
  ] as const)("maps %s into seven ordered cells without changing the record", (type, label) => {
    const source = Object.freeze({ ...record, type });
    const row = toInventorySheetRow(source, " 호연 ");
    expect(row).toEqual([
      "0012345678901", 3, "2027-03-01", "A0102", "호연",
      "2027-01-16T08:30:00.000+09:00", label,
    ]);
    expect(source.foundBy).toBe("U_SUBMITTER");
    expect(source.foundAt).toBe("2027-01-15T23:30:00.000Z");
    expect(typeof row[0]).toBe("string");
    expect(typeof row[1]).toBe("number");
  });

  it.each([undefined, "", "   "])("falls back to Slack ID for name %j", (name) => {
    expect(toInventorySheetRow(record, name)[4]).toBe("U_SUBMITTER");
  });

  it("converts validated modal values to a Sheets values row", () => {
    const result = parseInventoryValues({
      barcode: { value: { value: " 0012345678901 " } },
      quantity: { value: { value: "3" } },
      expiration_date: { value: { selected_date: "2027-03-01" } },
      location: { value: { value: " A-01-02 " } },
      type: { value: { selected_option: { value: "overstock" } } },
    }, "U_SUBMITTER", record.foundAt);
    if (!result.record) throw new Error("Expected a valid inventory record");

    const body = { majorDimension: "ROWS", values: [toInventorySheetRow(result.record, "호연")] };
    expect(body.values).toEqual([[
      "0012345678901", 3, "2027-03-01", "A0102", "호연",
      "2027-01-16T08:30:00.000+09:00", "과재고",
    ]]);
  });

  it("preserves literal strings for RAW writes without CSV escaping", () => {
    const row = toInventorySheetRow({ ...record, barcode: "=1+2" }, '호연, "재고팀"');
    expect(row[0]).toBe("=1+2");
    expect(row[4]).toBe('호연, "재고팀"');
  });

  it.each([
    ["2027-01-15T08:00:00.123Z", "2027-01-15T17:00:00.123+09:00"],
    ["2027-01-15T15:00:00.000Z", "2027-01-16T00:00:00.000+09:00"],
    ["2027-01-31T23:30:00.000Z", "2027-02-01T08:30:00.000+09:00"],
    ["2027-12-31T23:30:00.000Z", "2028-01-01T08:30:00.000+09:00"],
    ["2028-02-28T23:30:00.000Z", "2028-02-29T08:30:00.000+09:00"],
    ["2027-01-15T17:00:00.000+09:00", "2027-01-15T17:00:00.000+09:00"],
  ])("formats %s in Seoul time without changing the instant", (input, expected) => {
    const row = toInventorySheetRow({ ...record, foundAt: input });
    expect(row[5]).toBe(expected);
    expect(new Date(row[5]).getTime()).toBe(new Date(input).getTime());
    expect(row[2]).toBe(record.expirationDate);
  });
});
