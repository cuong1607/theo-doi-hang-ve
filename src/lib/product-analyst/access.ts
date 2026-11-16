// PRODUCT-ANALYTICS-4: who may use the web assistant (spec §121: admin /
// analyst roles first). UX + page gate; the orchestrator still re-authorizes
// user, shop grant and product on every analysis and every tool call.
// Pure (relative imports only).
import { hasPermission, type Role } from "../auth/permissions.ts";
import { CONVERSATION_ALLOWED_ROLES } from "../conversation/service.ts";
import { getProductAnalystConfig, type ProductAnalystConfig } from "./config.ts";

export function webAssistantAvailable(role: Role | null | undefined, config: ProductAnalystConfig = getProductAnalystConfig()): boolean {
  if (!role || !config.webEnabled) return false;
  return CONVERSATION_ALLOWED_ROLES.includes(role) && hasPermission(role, "app:shopee") && hasPermission(role, "channel:view");
}
