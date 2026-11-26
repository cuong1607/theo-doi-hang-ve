// PHASE 04.5 — POST a one-time code to link the caller's Zalo account (Phase 05
// issuePersonalLinkCode: 8 characters, 10 minutes, only its SHA-256 is stored;
// the plaintext is returned once). The user then sends "LINK <mã>" in a 1-1 chat.
import { authorizeReplyApi, respondReply } from "@/lib/zalo-reply/server";
import { createLinkCode } from "@/lib/zalo-reply/service";
import { guarded } from "@/lib/zalo-personal/dashboard/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return guarded("replies:link_code", async () => {
    const gate = await authorizeReplyApi();
    if (!gate.ok) return gate.response;
    return respondReply(await createLinkCode(gate.deps, gate.actor));
  });
}
