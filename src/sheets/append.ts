import { env } from "cloudflare:workers";
import { getGoogleAccessToken } from "./auth";
import { INVENTORY_SHEET_HEADERS, toInventorySheetRow } from "./inventory";
import type { InventoryRecord } from "../slack/inventory";

async function ensureInventoryHeaders(url: URL, token: string, signal: AbortSignal): Promise<void> {
  url.searchParams.set("majorDimension", "ROWS");
  // Preserve formulas even if their displayed result is an empty string.
  url.searchParams.set("valueRenderOption", "FORMULA");
  let response: Response;
  try {
    response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, signal });
  } catch {
    throw new Error("Google Sheets header lookup failed or timed out");
  }
  if (!response.ok) throw new Error(`Google Sheets header lookup failed (HTTP ${response.status})`);

  let hasValues: boolean;
  try {
    const result = await response.json() as { values?: unknown };
    const rows = result.values === undefined ? [] : result.values;
    if (!Array.isArray(rows) || rows.length > 1 || (rows.length === 1 && !Array.isArray(rows[0]))) {
      throw new Error("Invalid header rows");
    }
    hasValues = (rows[0] ?? []).some((value: unknown) => value !== "" && value !== null && value !== undefined);
  } catch {
    throw new Error("Invalid Google Sheets header response");
  }
  if (hasValues) return;

  url.search = "";
  url.searchParams.set("valueInputOption", "RAW");
  try {
    response = await fetch(url.toString(), {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ majorDimension: "ROWS", values: [INVENTORY_SHEET_HEADERS] }),
      signal,
    });
  } catch {
    throw new Error("Google Sheets header creation failed or timed out; inventory row not appended");
  }
  if (!response.ok) throw new Error(`Google Sheets header creation failed (HTTP ${response.status})`);
  try {
    const result = await response.json() as { updatedRows?: number; updatedCells?: number };
    if (result?.updatedRows === 1 && result.updatedCells === INVENTORY_SHEET_HEADERS.length) return;
  } catch {
    // Never log response bodies or proceed with an unconfirmed header write.
  }
  throw new Error("Google Sheets header creation not confirmed; inventory row not appended");
}

export async function appendInventoryRow(record: InventoryRecord, foundByName: string): Promise<void> {
  const sheetId = env.GOOGLE_INVENTORY_SHEET_ID?.trim();
  const tabName = env.GOOGLE_INVENTORY_SHEET_TAB_NAME;
  if (!sheetId || !tabName?.trim()) throw new Error("Missing Google inventory sheet configuration");
  const token = await getGoogleAccessToken();
  const tab = `'${tabName.replaceAll("'", "''")}'`;
  const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/`;
  // Bound all sheet requests together, leaving time for auth and Slack result updates.
  const signal = AbortSignal.timeout(15000);
  await ensureInventoryHeaders(new URL(valuesUrl + encodeURIComponent(`${tab}!A1:G1`)), token, signal);
  const url = new URL(`${valuesUrl}${encodeURIComponent(`${tab}!A:G`)}:append`);
  url.searchParams.set("valueInputOption", "RAW");
  url.searchParams.set("insertDataOption", "INSERT_ROWS");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ majorDimension: "ROWS", values: [toInventorySheetRow(record, foundByName)] }),
      signal,
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
