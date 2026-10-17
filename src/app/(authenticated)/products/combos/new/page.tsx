import { requirePermission } from "@/lib/auth/session";
import { PageContainer, PageHeader } from "@/components/patterns/page-header";
import { Card, CardContent } from "@/components/ui/card";

import { ComboForm } from "../combo-form";

export default async function NewComboPage() {
  await requirePermission("product:manage");
  return (
    <PageContainer>
      <PageHeader
        title="Tạo combo"
        description="Combo là SKU bán hàng gồm nhiều sản phẩm thật. Combo không có tồn kho hay giá vốn riêng — giá vốn và tồn kho luôn tính theo các sản phẩm thành phần."
      />
      <Card>
        <CardContent className="pt-6">
          <ComboForm comboId={null} initial={{ sku: "", name: "", unit: "combo", note: "", components: [] }} />
        </CardContent>
      </Card>
    </PageContainer>
  );
}
