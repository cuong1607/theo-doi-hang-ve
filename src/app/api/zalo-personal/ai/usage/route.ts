// ZALO PERSONAL Phase 04 — AI usage today (own; system-wide totals for admins only),
// budget status. Counts and categories only: no prompt, answer or message text.
import { getUsage } from "@/lib/zalo-personal/ai/service";
import { authorizeAiApi, respondAi } from "@/lib/zalo-personal/ai/server";
import { guarded } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guarded("ai:usage", async () => {
    const gate = await authorizeAiApi();
    if (!gate.ok) return gate.response;
    return respondAi(await getUsage(gate.deps, gate.actor));
  });
}
