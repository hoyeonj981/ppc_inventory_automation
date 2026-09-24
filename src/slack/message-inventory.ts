import type { InventoryRecord } from "./inventory";

function dateParts(value: string): string {
  const match = value.match(/^(\d{4})\s*[년./-]\s*(\d{1,2})\s*[월./-]\s*(\d{1,2})\s*일?$/);
  if (!match) throw new Error("소비기한은 연도가 포함된 날짜로 적어 주세요. 예: 2026-12-31");
  const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("본문의 날짜가 올바른지 확인해 주세요.");
  }
  return date;
}

// Read known report labels, tolerating Slack bullets, emphasis, spacing and line order.
// Unknown prose remains available through the original message link; never infer missing stock counts.
export function parseInventoryMessage(text: string, authorId: string, messageTs: string): {
  record: InventoryRecord; foundByName?: string;
} {
  const lines = text.replace(/\*/g, "").split(/\r?\n/).map((line) => line.trim().replace(/^[•●▪◦·-]\s*/, ""));
  const normalized = lines.join("\n");
  const field = (label: string): string => {
    const pattern = new RegExp(`^(?:${label})\\s*[:：=]\\s*(.*?)\\s*$`, "i");
    const values = lines.flatMap((line) => { const match = line.match(pattern); return match ? [match[1]] : []; });
    if (values.length > 1) throw new Error("한 메시지에는 한 건의 재고 보고만 적어 주세요.");
    return values[0] ?? "";
  };
  const types = new Set([...normalized.matchAll(/과\s*재고|부족\s*재고/g)].map(([value]) => value.replace(/\s/g, "")));
  if (types.size !== 1) throw new Error("과재고 또는 부족재고 중 하나의 보고인지 확인해 주세요.");
  const type = types.has("과재고") ? "overstock" : "shortage";

  const counts = [...normalized.matchAll(/(?:과\s*재고|부족\s*재고)(?:\s*수량)?\s*[:：=]?\s*([+-]?\d[\d,.]*)(?=\s*개|\s*$)/gm)]
    .map((match) => match[1].replace(/,$/, ""));
  const quantityField = field("수량|발견\\s*수량");
  if (quantityField) counts.push(quantityField.replace(/\s*개\s*$/, ""));
  const quantities = counts.map((count) => /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(count) ? Number(count.replaceAll(",", "")) : NaN);
  if (quantities.length === 0 || quantities.some((n) => !Number.isSafeInteger(n) || n < 1) || new Set(quantities).size !== 1) {
    throw new Error("과재고·부족재고 수량을 하나로 확인할 수 없습니다. 예: 과재고 1개 또는 수량: 1");
  }
  // Reject multi-SKU reports even when their quantities happen to be equal.
  field("SKU\\s*명");
  const combined = field("발견\\s*(?:일시|일자)\\s*[/／]\\s*(?:위치|로케이션)");
  const locationField = field("(?:발견\\s*)?(?:로케이션|위치)");
  const combinedLocation = combined.match(/[/／]\s*([A-Za-z0-9]+(?:\s*-\s*[A-Za-z0-9]+)+)\s*$/);
  const location = (locationField || combinedLocation?.[1] || "").trim();
  if (!location || location.length > 100 || (locationField && combinedLocation && locationField !== combinedLocation[1])) {
    throw new Error("발견 위치를 하나로 확인할 수 없습니다. 예: 발견로케이션: A11-11-203");
  }
  const barcode = field("바\\s*코드");
  if (barcode.length > 100) throw new Error("바코드는 100자 이내로 적어 주세요.");
  const expiration = field("(?:법적\\s*)?소비\\s*기한");
  const expirationDate = !expiration || /^(?:N\/A|없음|미기재|-)$/i.test(expiration) ? "" : dateParts(expiration);
  const foundByName = field("발견\\s*(?:크루\\s*명|자(?:\\s*명)?)");

  let foundAt = new Date(Number(messageTs) * 1000).toISOString();
  const discovery = field("발견\\s*(?:일시|시각)") || (combinedLocation ? combined.slice(0, combinedLocation.index).trim() : "");
  const fullTime = discovery.match(/^(\d{4}[년./-]\s*\d{1,2}[월./-]\s*\d{1,2}\s*일?)[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (fullTime) {
    const date = dateParts(fullTime[1]);
    if (+fullTime[2] > 23 || +fullTime[3] > 59 || +(fullTime[4] ?? 0) > 59) throw new Error("발견시각이 올바른지 확인해 주세요.");
    foundAt = new Date(`${date}T${fullTime[2].padStart(2, "0")}:${fullTime[3]}:${fullTime[4] ?? "00"}+09:00`).toISOString();
  }
  return {
    record: { barcode, quantity: quantities[0], expirationDate, location, foundBy: authorId, foundAt, type, source: "message" },
    ...(foundByName ? { foundByName } : {}),
  };
}
