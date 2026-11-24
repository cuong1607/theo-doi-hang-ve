// ZALO PERSONAL — GET connections the reader may see (no session, cookie or secret is ever returned);
// POST creates a connection OWNED BY THE CALLER (self-service, "zalo_personal:connect"; audited).
import { createConnectionBody } from "@/lib/zalo-personal/dashboard/contracts";
import { createConnection } from "@/lib/zalo-personal/dashboard/self-service";
import { listConnections } from "@/lib/zalo-personal/dashboard/service";
import { authorizeZaloApi, getSelfServiceDeps, guarded, parseInput, readJson, respond } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guarded("connections", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    return respond(await listConnections(gate.deps, gate.actor));
  });
}

export async function POST(request: Request) {
  return guarded("connection:create", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const body = parseInput(createConnectionBody, await readJson(request));
    if (!body.ok) return body.response;
    return respond(await createConnection(getSelfServiceDeps(), gate.actor, body.data));
  });
}
