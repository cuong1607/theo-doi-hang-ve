// PHASE 05 — the default registry: every read-only business tool of the system.
import { SystemToolRegistry } from "../registry.ts";
import { KNOWLEDGE_TOOLS } from "./knowledge.ts";
import { PAYABLES_TOOLS } from "./payables.ts";
import { RECEIVING_TOOLS } from "./receiving.ts";
import { SHOPEE_TOOLS } from "./shopee.ts";

export function createDefaultRegistry(): SystemToolRegistry {
  const r = new SystemToolRegistry();
  for (const t of [...SHOPEE_TOOLS, ...RECEIVING_TOOLS, ...PAYABLES_TOOLS, ...KNOWLEDGE_TOOLS]) r.register(t as never);
  return r;
}
