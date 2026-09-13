import { env } from "cloudflare:workers";
import { getGoogleAccessToken } from "./auth";
import { toInventorySheetRow } from "./inventory";
import type { InventoryRecord } from "../slack/inventory";

export async function appendInventoryRow(record: InventoryRecord, foundByName: string): Promise<void> {
  const sheetId = env.GOOGLE_INVENTORY_SHEET_ID?.trim();
  const tabName = env.GOOGLE_INVENTORY_SHEET_TAB_NAME;
  if (!sheetId || !tabName?.trim()) throw new Error("Missing Google inventory sheet configuration");
  const token = await getGoogleAccessToken();
  const range = `'${tabName.replaceAll("'", "''")}'!A:G`;
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}:append`);
  url.searchParams.set("valueInputOption", "RAW");
  url.searchParams.set("insertDataOption", "INSERT_ROWS");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ majorDimension: "ROWS", values: [toInventorySheetRow(record, foundByName)] }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // A timeout can happen after Google has written the row. Do not retry the append.
    throw new Error("Google Sheets append outcome unknown (network error or timeout); check sheet before retrying");
  }
  if (!response.ok) throw new Error(`Google Sheets append failed (HTTP ${response.status}); check sheet before retrying`);
  try {
    const result = await response.json() as { updates?: { updatedRows?: number; updatedCells?: number } };
    if (result?.updates?.updatedRows === 1 && result.updates.updatedCells === 7) return;
  } catch {
    // Do not log response bodies, which could contain inventory values.
  }
  throw new Error("Google Sheets append outcome unknown (unexpected response); check sheet before retrying");
}
