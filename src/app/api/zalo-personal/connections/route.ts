// ZALO PERSONAL Phase 03 — GET connections the reader may see (no session, cookie or secret is ever returned).
import { listConnections } from "@/lib/zalo-personal/dashboard/service";
import { authorizeZaloApi, guarded, respond } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guarded("connections", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    return respond(await listConnections(gate.deps, gate.actor));
  });
}
