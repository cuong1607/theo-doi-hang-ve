// ZALO PERSONAL Phase 03 — GET summary metrics for the reader's scope.
import { getOverview } from "@/lib/zalo-personal/dashboard/service";
import { authorizeZaloApi, guarded, respond } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guarded("overview", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    return respond(await getOverview(gate.deps, gate.actor));
  });
}
