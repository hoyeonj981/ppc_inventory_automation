import type { InventoryRecord } from "../core/inventory";

export const INVENTORY_SHEET_HEADERS = [
  "바코드", "SKU명", "수량", "소비기한(제조기한)", "발견로케이션", "발견자", "발견시각", "유형", "입력경로", "보고 메시지 링크",
] as const;

// Accept a validated record. Write the returned row with valueInputOption: "RAW".
export function toInventorySheetRow(
  record: InventoryRecord,
  foundByName = record.foundBy,
  reportUrl = "",
): [
  barcode: string,
  skuName: string,
  quantity: number,
  expirationDate: string,
  location: string,
  foundByName: string,
  foundAt: string,
  type: string,
  source: string,
  reportUrl: string,
] {
  // Asia/Seoul uses UTC+09:00. Keep the offset explicit instead of labelling local time as UTC.
  const foundAt = new Date(new Date(record.foundAt).getTime() + 9 * 60 * 60 * 1000)
    .toISOString().replace("Z", "+09:00");
  // Fields an input path does not collect are written as N/A rather than left blank.
  return [
    record.barcode || "N/A",
    record.skuName || "N/A",
    record.quantity,
    record.expirationDate || "N/A",
    record.location,
    foundByName.trim() || record.foundBy,
    foundAt,
    record.type === "overstock" ? "과재고" : "부족재고",
    record.source === "message" ? "메시지 변환" : "앱 입력",
    reportUrl || "N/A",
  ];
}
