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
      "2027-01-15T23:30:00.000Z", label,
    ]);
    expect(source.foundBy).toBe("U_SUBMITTER");
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
      "2027-01-15T23:30:00.000Z", "과재고",
    ]]);
  });

  it("preserves literal strings for RAW writes without CSV escaping", () => {
    const row = toInventorySheetRow({ ...record, barcode: "=1+2" }, '호연, "재고팀"');
    expect(row[0]).toBe("=1+2");
    expect(row[4]).toBe('호연, "재고팀"');
  });
});
