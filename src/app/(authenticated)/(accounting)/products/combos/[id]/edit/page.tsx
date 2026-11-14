import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth/session";
import { getComboOverview } from "@/lib/products/combo";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { Card, CardContent } from "@/components/ui/card";

import { ComboForm } from "../../combo-form";

export default async function EditComboPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("product:manage");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const combo = await getComboOverview(createAdminClient(), id);
  if (!combo) notFound();
  return (
    <PageContainer>
      <PageHeader title={`Sửa combo ${combo.sku}`} description={combo.name} />
      <Card>
        <CardContent className="pt-6">
          <ComboForm
            comboId={combo.comboProductId}
            initial={{
              sku: combo.sku,
              name: combo.name,
              unit: combo.unit,
              note: combo.note ?? "",
              components: combo.components.map((c) => ({ productId: c.productId, sku: c.sku, name: c.name, quantity: c.quantity.replace(/\.?0+$/, "") })),
            }}
          />
        </CardContent>
      </Card>
    </PageContainer>
  );
}
