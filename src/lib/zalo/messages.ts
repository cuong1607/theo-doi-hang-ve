// ============================================================
// PHASE ZL1: sendZaloTextMessage — the one function that actually sends a
// message. Server-only: pulls a real access token via
// getValidZaloAccessToken() and calls out to Zalo with it.
// ============================================================
import "server-only";
import { z } from "zod";

import { ZALO_SEND_MESSAGE_URL, zaloFetch, type FetchImpl } from "./client.ts";
import { getValidZaloAccessToken } from "./token.ts";

const inputSchema = z.object({
  recipientId: z.string().trim().min(1, "Thiếu recipientId."),
  text: z.string().trim().min(1, "Nội dung tin nhắn không được rỗng.").max(2000, "Nội dung tin nhắn quá dài."),
});

export type SendZaloTextMessageInput = z.input<typeof inputSchema>;

export type SendZaloTextMessageResult = {
  success: boolean;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
};

// Never swallows an error silently — every failure path returns a populated
// errorCode/errorMessage rather than throwing past the caller or returning
// a bare `{ success: false }`.
export async function sendZaloTextMessage(
  input: SendZaloTextMessageInput,
  fetchImpl?: FetchImpl
): Promise<SendZaloTextMessageResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      errorCode: "invalid_input",
      errorMessage: parsed.error.issues[0]?.message ?? "Dữ liệu đầu vào không hợp lệ.",
    };
  }

  const tokenResult = await getValidZaloAccessToken();
  if (!tokenResult.ok) {
    return {
      success: false,
      errorCode: tokenResult.error.errorCode,
      errorMessage: tokenResult.error.errorMessage,
    };
  }

  let response: Response;
  try {
    response = await zaloFetch(
      ZALO_SEND_MESSAGE_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          access_token: tokenResult.accessToken,
        },
        body: JSON.stringify({
          recipient: { user_id: parsed.data.recipientId },
          message: { text: parsed.data.text },
        }),
      },
      fetchImpl
    );
  } catch (err) {
    return {
      success: false,
      errorCode: "network_error",
      errorMessage: err instanceof Error ? err.message : "Không thể kết nối tới Zalo.",
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { success: false, errorCode: "invalid_response", errorMessage: "Zalo trả về dữ liệu không hợp lệ." };
  }

  // Zalo's OpenAPI convention: error === 0 means success; a message_id (or
  // nested data.message_id, seen on some OA API versions) identifies the
  // sent message.
  const parsedData = data as {
    error?: number;
    message?: string;
    message_id?: string;
    data?: { message_id?: string };
  };

  if (!response.ok || parsedData.error !== 0) {
    return {
      success: false,
      errorCode: String(parsedData.error ?? response.status),
      errorMessage: parsedData.message || "Zalo từ chối gửi tin nhắn.",
    };
  }

  return {
    success: true,
    providerMessageId: parsedData.data?.message_id ?? parsedData.message_id,
  };
}
