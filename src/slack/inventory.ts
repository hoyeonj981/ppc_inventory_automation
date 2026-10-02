import { env } from "cloudflare:workers";
import type { InventoryRecord } from "../core/inventory";
import { getChannelMemberOptions } from "./members";

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
      block_id: "photo",
      optional: true,
      label: plainText("사진 (JPG, PNG, GIF 1장)"),
      element: {
        type: "file_input",
        action_id: "value",
        filetypes: ["jpg", "jpeg", "png", "gif"],
        max_files: 1,
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
      block_id: "location",
      label: plainText("발견로케이션"),
      element: {
        type: "plain_text_input",
        action_id: "value",
        max_length: 100,
      },
    },
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
      block_id: "expiration_date",
      label: plainText("소비기한(제조기한)"),
      element: { type: "datepicker", action_id: "value" },
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
      block_id: "found_by",
      label: plainText("발견자"),
      element: {
        type: "static_select",
        action_id: "value",
        placeholder: plainText("현재 채널의 멤버를 선택해 주세요"),
      },
    },
    {
      type: "context",
      elements: [
        plainText(
          "저장하면 현재 채널에 보고 내용과 사진을 게시하고, Google Sheets에 재고 정보와 보고 메시지 링크를 기록합니다.",
        ),
      ],
    },
  ],
};

export async function openInventoryModal(triggerId: string, channelId: string): Promise<boolean> {
  if (!env.SLACK_BOT_TOKEN) {
    console.error("Missing Slack bot token");
    return false;
  }
  try {
    // Member lookup and views.open share Slack's acknowledgement deadline.
    const signal = AbortSignal.timeout(2000);
    const options = await getChannelMemberOptions(channelId, signal);
    if (options.length === 0 || options.length > 10000) {
      console.warn("Cannot open inventory modal: no selectable members or too many members");
      return false;
    }
    const selection = options.length <= 100 ? { options } : {
      option_groups: Array.from({ length: Math.ceil(options.length / 100) }, (_, index) => ({
        label: plainText(`멤버 ${index * 100 + 1}–${Math.min((index + 1) * 100, options.length)}`),
        options: options.slice(index * 100, (index + 1) * 100),
      })),
    };
    const view = {
      ...inventoryModal,
      private_metadata: channelId,
      blocks: inventoryModal.blocks.map((block) => block.block_id === "found_by"
        ? { ...block, element: { ...block.element, ...selection } }
        : block),
    };
    const response = await fetch("https://slack.com/api/views.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trigger_id: triggerId, view }),
      signal,
    });
    const result = (await response.json()) as { ok?: boolean };
    if (response.ok && result?.ok === true) return true;
  } catch {
    // Do not log the token, trigger ID, or full Slack response.
  }
  console.error("Failed to open inventory modal");
  return false;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseInventoryValues(
  values: unknown,
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
  const foundBy = text(object(field("found_by").selected_option).value);
  const errors: Record<string, string> = {};
  const files = field("photo").files;
  let photoFileId: string | undefined;
  if (files !== undefined && files !== null) {
    if (!Array.isArray(files) || files.length > 1) {
      errors.photo = "사진은 1장만 첨부해 주세요.";
    } else if (files.length === 1) {
      const file = object(files[0]);
      if (typeof file.id !== "string" || !/^F[A-Z0-9]+$/.test(file.id) ||
          !["jpg", "jpeg", "png", "gif"].includes(text(file.filetype))) {
        errors.photo = "JPG, PNG, GIF 사진을 첨부해 주세요.";
      } else {
        photoFileId = file.id;
      }
    }
  }
  if (!foundBy) errors.found_by = "현재 채널의 발견자를 선택해 주세요.";

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
    errors.expiration_date = "올바른 소비기한(제조기한)을 선택해 주세요.";
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
      ...(photoFileId ? { photoFileId } : {}),
    },
  };
}

export function inventoryConfirmation(
  record: InventoryRecord,
  foundByName = record.foundBy,
  status: "saving" | "saved" | "unconfirmed" | "report_unconfirmed" | "link_unconfirmed" = "saving",
) {
  const foundAt = new Date(record.foundAt).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour12: false,
  });
  return {
    type: "modal",
    title: plainText(status === "saving" ? "저장 중" : status === "saved" ? "저장 완료" : "저장 확인 필요"),
    close: plainText("닫기"),
    blocks: [
      {
        type: "section",
        text: plainText(
          [
            `바코드: ${record.barcode}`,
            `수량: ${record.quantity}`,
            `소비기한(제조기한): ${record.expirationDate}`,
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
            saving: "채널 보고와 Google Sheets 저장 중입니다. 완료될 때까지 기다려 주세요. 화면을 닫아도 처리는 계속됩니다.",
            saved: "채널에 보고 메시지를 게시하고 재고 정보와 보고 메시지 링크를 Google Sheets에 저장했습니다.",
            unconfirmed: "채널 보고는 게시되었습니다. 시트 저장 여부를 확인하지 못했습니다. 중복 입력을 피하려면 채널과 시트, Worker 로그를 확인한 뒤 다시 제출해 주세요.",
            report_unconfirmed: "채널 보고 게시 여부를 확인하지 못해 시트에는 저장하지 않았습니다. 중복 입력을 피하려면 채널과 Worker 로그를 확인한 뒤 다시 제출해 주세요.",
            link_unconfirmed: "채널 보고는 게시되었지만 메시지 링크를 가져오지 못해 시트에는 저장하지 않았습니다. 중복 입력을 피하려면 채널과 Worker 로그를 확인해 주세요.",
          }[status]),
        ],
      },
    ],
  };
}
