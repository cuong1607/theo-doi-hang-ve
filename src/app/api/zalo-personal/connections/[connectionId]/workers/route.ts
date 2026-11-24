// ZALO PERSONAL — the OWNER issues a worker credential. The HMAC secret is generated and
// encrypted on the server and returned ONCE in this response (no-store); it is never logged.
import { idParam } from "@/lib/zalo-personal/dashboard/contracts";
import { ingestUrlFrom, issueWorker } from "@/lib/zalo-personal/dashboard/self-service";
import { authorizeZaloApi, getSelfServiceDeps, guarded, parseInput, respond } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  return guarded("worker:issue", async () => {
    const gate = await authorizeZaloApi();
    if (!gate.ok) return gate.response;
    const id = parseInput(idParam, (await params).connectionId);
    if (!id.ok) return id.response;
    const ingestUrl = ingestUrlFrom(process.env.APP_URL?.trim() || new URL(request.url).origin) ?? "https://<địa-chỉ-app>";
    return respond(await issueWorker(getSelfServiceDeps(), gate.actor, id.data, ingestUrl));
  });
}
