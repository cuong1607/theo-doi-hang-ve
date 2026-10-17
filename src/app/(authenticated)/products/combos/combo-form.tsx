"use client";

// PRODUCT-COMBO-1: create / edit combo. Components are ATOMIC products only
// (searched server-side); duplicates are merged on save. Editing the BOM
// applies to orders costed after the change — the warning says so.
import { Plus, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Callout } from "@/components/patterns/callout";
import { LoadingButton } from "@/components/patterns/loading-button";
import { toast } from "@/components/patterns/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { saveComboAction, searchComboComponentsAction } from "./actions";

export type ComboFormComponent = { productId: string; sku: string; name: string; quantity: string };
type Option = { id: string; sku: string; name: string };

export function ComboForm({
  comboId,
  initial,
}: {
  comboId: string | null;
  initial: { sku: string; name: string; unit: string; note: string; components: ComboFormComponent[] };
}) {
  const router = useRouter();
  const [sku, setSku] = useState(initial.sku);
  const [name, setName] = useState(initial.name);
  const [unit, setUnit] = useState(initial.unit || "combo");
  const [note, setNote] = useState(initial.note);
  const [components, setComponents] = useState<ComboFormComponent[]>(initial.components);
  const [error, setError] = useState<{ message: string; field?: string | null } | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const res = await saveComboAction(comboId, {
        sku,
        name,
        unit,
        note,
        components: components.map((c) => ({ productId: c.productId, quantity: c.quantity })),
      });
      if (!res.ok) {
        setError({ message: res.message, field: res.field });
        return;
      }
      toast.success(res.message);
      router.push(`/products/combos/${res.id}`);
    } catch {
      setError({ message: "Không lưu được combo. Vui lòng thử lại." });
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (f: string) => (error?.field === f ? error.message : null);

  return (
    <form onSubmit={submit} className="space-y-5">
      {comboId && (
        <Callout tone="warning">Thay đổi thành phần combo chỉ áp dụng cho các đơn hàng được tính giá vốn sau thời điểm thay đổi.</Callout>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Tên combo *</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!fieldError("name")} required maxLength={255} />
          {fieldError("name") && <span className="text-xs text-danger-text">{fieldError("name")}</span>}
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">SKU combo *</span>
          <Input value={sku} onChange={(e) => setSku(e.target.value)} aria-invalid={!!fieldError("sku")} required maxLength={100} placeholder="VD: THAM-50X60-X3" />
          <span className="block text-xs text-muted-foreground">Chỉ là mã định danh — cấu trúc combo lấy từ danh sách thành phần bên dưới, không suy ra từ SKU.</span>
          {fieldError("sku") && <span className="text-xs text-danger-text">{fieldError("sku")}</span>}
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Đơn vị</span>
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={50} />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Ghi chú</span>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Thành phần * ({components.length})</p>
        </div>
        {components.length === 0 && <p className="text-sm text-muted-foreground">Chưa có thành phần — tìm và thêm sản phẩm thật (không chọn được combo).</p>}
        <div className="space-y-2">
          {components.map((c, i) => (
            <div key={`${c.productId}-${i}`} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <div className="min-w-0 flex-1 text-sm">
                <p className="truncate font-medium">{c.sku}</p>
                <p className="truncate text-xs text-muted-foreground">{c.name}</p>
              </div>
              <label className="flex items-center gap-1.5 text-sm">
                <span className="text-muted-foreground">SL / combo</span>
                <Input
                  value={c.quantity}
                  onChange={(e) => setComponents((list) => list.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                  inputMode="decimal"
                  className="w-24 text-right"
                  aria-label={`Số lượng ${c.sku} mỗi combo`}
                />
              </label>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setComponents((list) => list.filter((_, j) => j !== i))} aria-label={`Bỏ ${c.sku}`}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        <ComponentPicker
          onPick={(o) =>
            setComponents((list) =>
              list.some((x) => x.productId === o.id) ? list : [...list, { productId: o.id, sku: o.sku, name: o.name, quantity: "1" }],
            )
          }
        />
        {fieldError("components") && <p className="text-xs text-danger-text">{fieldError("components")}</p>}
      </div>

      {error && !error.field && <Callout tone="danger">{error.message}</Callout>}
      <div className="flex flex-wrap gap-2">
        <LoadingButton type="submit" loading={saving} loadingText="Đang lưu…" icon={<Save />}>
          {comboId ? "Lưu combo" : "Tạo combo"}
        </LoadingButton>
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={saving}>
          Huỷ
        </Button>
      </div>
    </form>
  );
}

function ComponentPicker({ onPick }: { onPick: (o: Option) => void }) {
  const [term, setTerm] = useState("");
  // results are keyed by the term they answer, so "loading" is derived (no setState in the effect body)
  const [result, setResult] = useState<{ term: string; options: Option[] } | null>(null);
  const q = term.trim();

  useEffect(() => {
    if (!q) return;
    const handle = setTimeout(async () => setResult({ term: q, options: await searchComboComponentsAction(q) }), 250);
    return () => clearTimeout(handle);
  }, [q]);

  const loading = q !== "" && result?.term !== q;
  const options = result?.term === q ? result.options : [];

  return (
    <div className="space-y-1 rounded-md border border-dashed p-2">
      <label className="flex items-center gap-2 text-sm">
        <Plus aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="sr-only">Tìm sản phẩm thành phần</span>
        <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Thêm thành phần: tìm theo SKU hoặc tên sản phẩm…" />
      </label>
      {term.trim() && (
        <div className="max-h-56 overflow-y-auto rounded-md border">
          {loading ? (
            <p className="p-2 text-sm text-muted-foreground">Đang tìm…</p>
          ) : options.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">Không có sản phẩm thật nào phù hợp.</p>
          ) : (
            options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onPick(o);
                  setTerm("");
                }}
                className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
              >
                <span className="font-medium">{o.sku}</span>
                <span className="truncate text-muted-foreground">— {o.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
