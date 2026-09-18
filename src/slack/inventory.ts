import { env } from "cloudflare:workers";

export const INVENTORY_CALLBACK_ID = "inventory_submit";

const plainText = (text: string) => ({ type: "plain_text", text });

export const inventoryModal = {
  type: "modal",
  callback_id: INVENTORY_CALLBACK_ID,
  title: plainText("재고 발견 입력"),
  submit: plainText("저장"),
  close: plainText("취소"),
  blocks: [
    {
      type: "input",
      block_id: "type",
      label: plainText("유형"),
      element: {
        type: "static_select",
        action_id: "value",
        options: [
          { text: plainText("과재고"), value: "overstock" },
          { text: plainText("부족재고"), value: "shortage" },
        ],
      },
    },
    {
      type: "input",
      block_id: "barcode",
      label: plainText("바코드"),
      element: {
        type: "plain_text_input",
        action_id: "value",
        max_length: 100,
      },
    },
    {
      type: "input",
      block_id: "quantity",
      label: plainText("수량"),
      element: {
        type: "number_input",
        action_id: "value",
        is_decimal_allowed: false,
        min_value: "1",
      },
    },
    {
      type: "input",
      block_id: "expiration_date",
      label: plainText("소비기한"),
      element: { type: "datepicker", action_id: "value" },
    },
    {
      type: "input",
      block_id: "location",
      label: plainText("발견로케이션"),
      element: {
        type: "plain_text_input",
        action_id: "value",
        max_length: 100,
      },
    },
    {
      type: "context",
      elements: [
        plainText(
          "발견자는 제출자의 Slack 프로필 이름으로 표시됩니다(조회 실패 시 Slack ID). 발견시각은 제출 요청 수신 시각입니다. 저장을 누르면 Google Sheets에 기록됩니다.",
        ),
      ],
    },
  ],
};

export async function openInventoryModal(triggerId: string): Promise<boolean> {
  if (!env.SLACK_BOT_TOKEN) {
    console.error("Missing Slack bot token");
    return false;
  }
  try {
    const response = await fetch("https://slack.com/api/views.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trigger_id: triggerId, view: inventoryModal }),
      // Leave time to acknowledge the slash command within Slack's three-second limit.
      signal: AbortSignal.timeout(2000),
    });
    const result = (await response.json()) as { ok?: boolean };
    if (response.ok && result?.ok === true) return true;
  } catch {
    // Do not log the token, trigger ID, or full Slack response.
  }
  console.error("Failed to open inventory modal");
  return false;
}

export interface InventoryRecord {
  barcode: string;
  quantity: number;
  expirationDate: string;
  location: string;
  foundBy: string;
  foundAt: string;
  type: "overstock" | "shortage";
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseInventoryValues(
  values: unknown,
  foundBy: string,
  foundAt: string,
):
  | { record: InventoryRecord; errors?: never }
  | { errors: Record<string, string>; record?: never } {
  const field = (id: string) => object(object(object(values)[id]).value);
  const text = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";
  const barcode = text(field("barcode").value);
  const quantityText = text(field("quantity").value);
  const quantity = Number(quantityText);
  const expirationDate = text(field("expiration_date").selected_date);
  const location = text(field("location").value);
  const type = object(field("type").selected_option).value;
  const errors: Record<string, string> = {};

  if (!barcode || barcode.length > 100)
    errors.barcode = "바코드를 1~100자로 입력해 주세요.";
  if (
    !/^\d+$/.test(quantityText) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1
  ) {
    errors.quantity = "수량은 1 이상의 정수로 입력해 주세요.";
  }
  const date = new Date(`${expirationDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(expirationDate) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== expirationDate
  ) {
    errors.expiration_date = "올바른 소비기한을 선택해 주세요.";
  }
  if (!location || location.length > 100)
    errors.location = "발견로케이션을 1~100자로 입력해 주세요.";
  if (type !== "overstock" && type !== "shortage") {
    errors.type = "과재고 또는 부족재고를 선택해 주세요.";
  }
  if (Object.keys(errors).length > 0) return { errors };

  return {
    record: {
      barcode,
      quantity,
      expirationDate,
      location,
      foundBy,
      foundAt,
      type: type as InventoryRecord["type"],
    },
  };
}

export function inventoryConfirmation(
  record: InventoryRecord,
  foundByName = record.foundBy,
  status: "saving" | "saved" | "unconfirmed" = "saving",
) {
  const foundAt = new Date(record.foundAt).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour12: false,
  });
  return {
    type: "modal",
    title: plainText({ saving: "저장 중", saved: "저장 완료", unconfirmed: "저장 확인 필요" }[status]),
    close: plainText("닫기"),
    blocks: [
      {
        type: "section",
        text: plainText(
          [
            `바코드: ${record.barcode}`,
            `수량: ${record.quantity}`,
            `소비기한: ${record.expirationDate}`,
            `발견로케이션: ${record.location}`,
            `발견자: ${foundByName}`,
            `발견시각: ${foundAt} (한국시간)`,
            `유형: ${record.type === "overstock" ? "과재고" : "부족재고"}`,
          ].join("\n"),
        ),
      },
      {
        type: "context",
        elements: [
          plainText({
            saving: "Google Sheets에 저장 중입니다. 완료될 때까지 기다려 주세요. 화면을 닫아도 저장 처리는 계속됩니다.",
            saved: "Google Sheets에 저장했습니다.",
            unconfirmed: "저장 여부를 확인하지 못했습니다. 중복 입력을 피하려면 시트와 Worker 로그를 확인한 뒤 다시 제출해 주세요.",
          }[status]),
        ],
      },
    ],
  };
}
