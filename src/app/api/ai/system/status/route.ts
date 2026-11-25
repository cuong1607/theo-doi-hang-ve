// PHASE 05 — GET /api/ai/system/status: model / data-policy state, today's
// model usage and the tools the CURRENT user may use. No figures.
import { loadActor } from "@/lib/ai-system/identity";
import { authorizeSystemApi, getSystemAssistantDeps, respondJson } from "@/lib/ai-system/server";
import { buildStatus } from "@/lib/ai-system/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const vnDayStart = (now: Date) => {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - 7 * 3_600_000);
};

export async function GET() {
  const gate = await authorizeSystemApi();
  if (!gate.ok) return gate.response;
  try {
    const deps = getSystemAssistantDeps();
    const who = await loadActor(deps.store, gate.userId);
    if (who.status !== "resolved") return respondJson(403, { success: false, error: "inactive", errorMessage: "Tài khoản đã bị vô hiệu hóa." });
    const usage = await deps.identityStore.usageToday(gate.userId, vnDayStart(new Date()));
    return respondJson(200, { success: true, data: buildStatus({ aiConfig: deps.aiConfig, config: deps.config, registry: deps.registry, actor: who.actor, modelCallsToday: usage.modelCalls }) as unknown as Record<string, unknown> });
  } catch (err) {
    console.error(JSON.stringify({ source: "ai-system", op: "status", error: err instanceof Error ? err.name : "unknown" }));
    return respondJson(500, { success: false, error: "server_error", errorMessage: "Không đọc được trạng thái trợ lý." });
  }
}
