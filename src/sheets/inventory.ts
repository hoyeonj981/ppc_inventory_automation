import type { InventoryRecord } from "../slack/inventory";

// Accept a validated record. Write the returned row with valueInputOption: "RAW".
export function toInventorySheetRow(
  record: InventoryRecord,
  foundByName = record.foundBy,
): [
  barcode: string,
  quantity: number,
  expirationDate: string,
  location: string,
  foundByName: string,
  foundAt: string,
  type: string,
] {
  return [
    record.barcode,
    record.quantity,
    record.expirationDate,
    record.location,
    foundByName.trim() || record.foundBy,
    record.foundAt,
    record.type === "overstock" ? "과재고" : "부족재고",
  ];
}
