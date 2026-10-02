import { env } from "cloudflare:workers";
import { appendInventoryRow } from "../sheets/append";
import type { InventoryRecord } from "../core/inventory";
import { inventoryConfirmation } from "./inventory";
import { getReportPermalink, postInventoryReport } from "./report";

export async function saveInventorySubmission(
  record: InventoryRecord,
  foundByName: string,
  submissionId: string,
  channelId: string,
): Promise<void> {
  const signal = AbortSignal.timeout(22000);
  let status: "saved" | "unconfirmed" | "report_unconfirmed" | "link_unconfirmed" = "report_unconfirmed";
  try {
    const messageTs = await postInventoryReport(record, foundByName, channelId, signal);
    console.info("inventory.report_posted", { submissionId, channelId, messageTs });
    status = "link_unconfirmed";
    const reportUrl = await getReportPermalink(channelId, messageTs, signal);
    status = "unconfirmed";
    await appendInventoryRow(record, foundByName, reportUrl, signal);
    status = "saved";
    console.info("inventory.saved", { submissionId });
  } catch (error) {
    // API helpers only emit sanitized errors, never credentials or response bodies.
    console.error("inventory.save_unconfirmed", {
      submissionId,
      status,
      reason: error instanceof Error ? error.message : "Unexpected storage error",
    });
  }

  // The external ID belongs to the acknowledgement view, not the old input view.
  // If the acknowledgement has not arrived yet, retry only the UI update, never the append.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch("https://slack.com/api/views.update", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          external_id: submissionId,
          view: { ...inventoryConfirmation(record, foundByName, status), external_id: submissionId },
        }),
        signal: AbortSignal.timeout(2000),
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (response.ok && result?.ok === true) return;
      if (attempt < 2 && (result?.error === "view_not_found" || result?.error === "not_found")) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
    } catch {
      // The user may already have closed the modal. Storage outcome remains in the logs.
    }
    break;
  }
  console.warn("inventory.status_update_failed", { submissionId, status });
}
