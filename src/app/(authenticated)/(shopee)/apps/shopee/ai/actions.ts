"use server";

// PRODUCT-ANALYTICS-4: web assistant actions. Each one authorizes again
// (session + app:shopee + rollout role + web flag); the conversation layer
// re-reads shop grants and the orchestrator re-authorizes every tool call.
// Read only: nothing here writes to Shopee or to analytics tables.
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { askWeb, WEB_PERIODS, type WebAnswer } from "@/lib/conversation/web";
import { SupabaseConversationStore } from "@/lib/conversation/supabase-store";
import { foldVietnamese } from "@/lib/conversation/router";
import { webAssistantAvailable } from "@/lib/product-analyst/access";
import { getProductAnalyst } from "@/lib/product-analyst/server";
import { createAdminClient } from "@/lib/supabase/admin";

const AskSchema = z.object({
  shopId: z.uuid(),
  productId: z.uuid().nullable(),
  period: z.enum(Object.keys(WEB_PERIODS) as [keyof typeof WEB_PERIODS, ...Array<keyof typeof WEB_PERIODS>]),
  question: z.string().trim().min(1).max(2000),
  clientMessageId: z.uuid(),
  analysisType: z.enum(["user_question", "ui_request"]),
});

export type AskResult = WebAnswer | { kind: "unauthorized"; message: string };

export async function askProductAnalystAction(input: z.input<typeof AskSchema>): Promise<AskResult> {
  const auth = await authorizeAction("app:shopee");
  if (!auth.ok) return { kind: "unauthorized", message: auth.message };
  if (!webAssistantAvailable(auth.auth.profile.role)) return { kind: "unauthorized", message: "Trợ lý phân tích chưa được bật cho tài khoản này." };
  const parsed = AskSchema.safeParse(input);
  if (!parsed.success) return { kind: "text", message: "Câu hỏi không hợp lệ." };
  const store = new SupabaseConversationStore(createAdminClient());
  return askWeb({ store, analyst: getProductAnalyst("web") }, { ...parsed.data, internalUserId: auth.auth.user.id });
}

export interface ProductOption {
  id: string;
  name: string | null;
  sku: string | null;
  itemId: string;
}

/** Product picker: names / SKU / item id of ONE granted shop (≤ 8, accent-insensitive). */
export async function searchAssistantProducts(input: { shopId: string; q: string }): Promise<ProductOption[]> {
  const auth = await authorizeAction("app:shopee");
  if (!auth.ok || !webAssistantAvailable(auth.auth.profile.role)) return [];
  const shopId = z.uuid().safeParse(input.shopId);
  const q = foldVietnamese(String(input.q ?? "")).slice(0, 80);
  if (!shopId.success || q.length < 2) return [];
  const store = new SupabaseConversationStore(createAdminClient());
  if (!(await store.allowedShops(auth.auth.user.id)).some((s) => s.id === shopId.data)) return [];
  const terms = q.split(" ").filter(Boolean);
  const all = await store.findProducts(shopId.data);
  return all
    .filter((p) => p.itemId === q.replace(/\s+/g, "") || terms.every((t) => foldVietnamese(`${p.name ?? ""} ${p.sku ?? ""}`).includes(t)))
    .slice(0, 8)
    .map((p) => ({ id: p.id, name: p.name, sku: p.sku, itemId: p.itemId }));
}
