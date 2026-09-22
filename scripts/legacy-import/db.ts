import { createClient } from "@supabase/supabase-js";

// Standalone script, not run through Next.js — mirrors src/lib/supabase/admin.ts
// but reads env vars directly (invoke with `node --env-file=.env.local ...`).
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Chạy script với `node --env-file=.env.local ...`."
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type DbSnapshot = {
  supplierNameToCode: Map<string, string>;
  supplierNameToId: Map<string, string>;
  productSkuToId: Map<string, string>;
  existingProductSkus: Set<string>;
};

export async function loadDbSnapshot(supabase: ReturnType<typeof createAdminClient>): Promise<DbSnapshot> {
  const { data: suppliers, error: supplierErr } = await supabase.from("suppliers").select("id, code, name");
  if (supplierErr) throw supplierErr;

  const { data: products, error: productErr } = await supabase.from("products").select("id, sku");
  if (productErr) throw productErr;

  const supplierNameToCode = new Map<string, string>();
  const supplierNameToId = new Map<string, string>();
  for (const s of suppliers ?? []) {
    supplierNameToCode.set(s.name.trim(), s.code);
    supplierNameToId.set(s.name.trim(), s.id);
  }

  const productSkuToId = new Map<string, string>();
  for (const p of products ?? []) {
    productSkuToId.set(p.sku, p.id);
  }

  return {
    supplierNameToCode,
    supplierNameToId,
    productSkuToId,
    existingProductSkus: new Set(productSkuToId.keys()),
  };
}
