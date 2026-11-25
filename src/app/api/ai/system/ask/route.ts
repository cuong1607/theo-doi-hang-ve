// PHASE 05 — POST /api/ai/system/ask { question } → AssistantResponse.
// Identity = the server session (never a body field); the assistant re-checks
// the profile, permissions, audience and every tool call. Read only.
import { z } from "zod";

import { answerThroughChannel, webAdapter } from "@/lib/ai-system/channels";
import { authorizeSystemApi, getSystemAssistantDeps, respondJson } from "@/lib/ai-system/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const askBody = z.object({ question: z.string().trim().min(2, "Câu hỏi cần ít nhất 2 ký tự.").max(500, "Câu hỏi tối đa 500 ký tự.") }).strict();

export async function POST(request: Request) {
  const gate = await authorizeSystemApi();
  if (!gate.ok) return gate.response;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return respondJson(400, { success: false, error: "invalid_input", errorMessage: "Dữ liệu gửi lên không hợp lệ." });
  }
  const body = askBody.safeParse(raw);
  if (!body.success) return respondJson(400, { success: false, error: "invalid_input", errorMessage: body.error.issues[0]?.message ?? "Câu hỏi không hợp lệ." });
  try {
    const deps = getSystemAssistantDeps();
    const out = await answerThroughChannel(webAdapter, deps, { sessionUserId: gate.userId }, body.data.question);
    if (!out.ok) return respondJson(404, { success: false, error: "not_enabled", errorMessage: "Trợ lý hệ thống chưa được bật." });
    return respondJson(200, { success: true, data: out.output as unknown as Record<string, unknown> });
  } catch (err) {
    console.error(JSON.stringify({ source: "ai-system", op: "ask", error: err instanceof Error ? err.name : "unknown" }));
    return respondJson(500, { success: false, error: "server_error", errorMessage: "Trợ lý gặp lỗi khi xử lý. Bạn thử lại sau nhé." });
  }
}
