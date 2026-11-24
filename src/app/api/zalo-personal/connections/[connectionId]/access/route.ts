// ZALO PERSONAL Phase 03 — GET / POST access grants of one connection (owner only; audited).
import { grantBody, idParam } from "@/lib/zalo-personal/dashboard/contracts";
import { grantAccess, listGrants } from "@/lib/zalo-personal/dashboard/service";
import { authorizeZaloApi, guarded, parseInput, readJson, respond } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  return guarded("access:list", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).connectionId);
    if (!id.ok) return id.response;
    return respond(await listGrants(gate.deps, gate.actor, id.data));
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  return guarded("access:grant", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).connectionId);
    if (!id.ok) return id.response;
    const body = parseInput(grantBody, await readJson(request));
    if (!body.ok) return body.response;
    return respond(await grantAccess(gate.deps, gate.actor, id.data, body.data));
  });
}
