// ============================================================
// AI ASSISTANT — DataAccessPolicy: may real conversation data leave the
// server for this provider? Pure. Default answer is NO.
//
//   AI_DATA_SHARING_POLICY=none      nothing is sent (default). Ask AI still
//                                    searches and shows the sources it found.
//   redacted                         sent after redact.ts (emails, phones, long
//                                    numbers, codes, secrets, URL paths masked)
//   full                             sent as stored
//   GEMINI_TIER=free                 Google may use free-tier inputs to improve
//                                    its products → real chats are sent only if
//                                    AI_FREE_TIER_DATA_APPROVED=true as well
//   AI_PROVIDER=fake                 nothing leaves the server → always allowed
//
// Namespace rule (D1): this engine only ever receives personal_direct /
// personal_group content in Phase 04; Web / OA history is never an input.
// ============================================================
import type { AiConfig } from "./config.ts";

export type MemoryNamespace = "web_session" | "oa_conversation" | "personal_direct" | "personal_group" | "business_knowledge";

/** Namespaces this phase may read / write. Anything else is refused by code AND by DB CHECKs. */
export const PHASE04_NAMESPACES: readonly MemoryNamespace[] = ["personal_direct", "personal_group"];

export const namespaceOf = (conversationType: "user" | "group"): MemoryNamespace => (conversationType === "group" ? "personal_group" : "personal_direct");

export type SharingDecision = { allowed: true; redact: boolean } | { allowed: false; reason: "policy_none" | "free_tier_not_approved" };

export function sharingDecision(c: AiConfig): SharingDecision {
  if (c.provider === "fake") return { allowed: true, redact: false };
  if (c.dataSharing === "none") return { allowed: false, reason: "policy_none" };
  if (c.tier === "free" && !c.freeTierDataApproved) return { allowed: false, reason: "free_tier_not_approved" };
  return { allowed: true, redact: c.dataSharing === "redacted" };
}

export const SHARING_TEXT: Record<"policy_none" | "free_tier_not_approved", string> = {
  policy_none: "Chính sách dữ liệu đang chặn gửi hội thoại thật tới AI (AI_DATA_SHARING_POLICY=none). Dưới đây là các tin liên quan tìm được, chưa được AI xử lý.",
  free_tier_not_approved:
    "Gemini đang ở gói miễn phí và chủ dự án chưa phê duyệt gửi hội thoại thật (Google có thể dùng dữ liệu gói miễn phí để cải thiện sản phẩm). Dưới đây là các tin liên quan tìm được, chưa được AI xử lý.",
};
