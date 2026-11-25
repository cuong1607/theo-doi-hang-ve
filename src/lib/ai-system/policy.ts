// ============================================================
// PHASE 05 — PermissionPolicy. Default deny; pure.
//
// A tool may run for a request only if ALL hold:
//   1. the actor is ACTIVE (loaded from the database, never from the client)
//   2. the role has ai_system:use
//   3. the role has EVERY permission the tool requires (the same permissions
//      that gate the tool's screens — the assistant never sees more)
//   4. the AUDIENCE may receive the tool's data: a group conversation is
//      public to all its members, so only "knowledge" tools (definitions, no
//      live data) are allowed there — whatever the asker's own rights. The
//      answer is judged by who READS it, not only by who asks.
// Data-scope rules beyond the role (Shopee shop grants) are checked inside
// the tools, at execution time, on every call.
// ============================================================
import { hasPermission } from "../auth/permissions.ts";
import type { Audience, InternalActor, Sensitivity, SystemToolDefinition } from "./types.ts";

export type DenyReason = "inactive" | "no_assistant_permission" | "missing_permission" | "audience";

export type AccessDecision = { allowed: true } | { allowed: false; reason: DenyReason };

/** Which sensitivities an audience may receive. */
export const AUDIENCE_ALLOWS: Record<Audience, readonly Sensitivity[]> = {
  private: ["knowledge", "operational", "financial"],
  group: ["knowledge"],
};

export function canUseAssistant(actor: InternalActor | null): AccessDecision {
  if (!actor || !actor.active) return { allowed: false, reason: "inactive" };
  if (!hasPermission(actor.role, "ai_system:use")) return { allowed: false, reason: "no_assistant_permission" };
  return { allowed: true };
}

export function toolAccess(tool: Pick<SystemToolDefinition<unknown>, "requiredPermissions" | "sensitivity">, actor: InternalActor | null, audience: Audience): AccessDecision {
  const base = canUseAssistant(actor);
  if (!base.allowed) return base;
  if (!tool.requiredPermissions.every((p) => hasPermission(actor!.role, p))) return { allowed: false, reason: "missing_permission" };
  if (!AUDIENCE_ALLOWS[audience].includes(tool.sensitivity)) return { allowed: false, reason: "audience" };
  return { allowed: true };
}

export const DENY_TEXT: Record<DenyReason, string> = {
  inactive: "Tài khoản không còn hoạt động hoặc chưa được xác minh, nên trợ lý không thể truy cập dữ liệu.",
  no_assistant_permission: "Tài khoản của bạn chưa được cấp quyền dùng Trợ lý hệ thống.",
  missing_permission: "Bạn không có quyền xem loại dữ liệu này.",
  audience: "Đây là cuộc trò chuyện nhiều người nên trợ lý không công khai số liệu nội bộ ở đây. Bạn hãy hỏi riêng (chat 1-1 hoặc trên web).",
};
