// PHASE 04.5 — GET / PATCH reply settings of the connections the reader OWNS.
// Enforced by the backend (zp_reply_admin + the claim gates), not by the form.
import { settingsBody } from "@/lib/zalo-reply/contracts";
import { authorizeReplyApi, respondReply } from "@/lib/zalo-reply/server";
import { getSettings, saveSettings } from "@/lib/zalo-reply/service";
import { guarded, parseInput, readJson } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guarded("replies:settings", async () => {
    const gate = await authorizeReplyApi();
    if (!gate.ok) return gate.response;
    return respondReply(await getSettings(gate.deps, gate.actor));
  });
}

export async function PATCH(request: Request) {
  return guarded("replies:settings_save", async () => {
    const gate = await authorizeReplyApi();
    if (!gate.ok) return gate.response;
    const body = parseInput(settingsBody, await readJson(request));
    if (!body.ok) return body.response;
    return respondReply(await saveSettings(gate.deps, gate.actor, body.data));
  });
}
