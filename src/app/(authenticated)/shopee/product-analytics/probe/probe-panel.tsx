"use client";

import { useState, useTransition } from "react";
import { Download, Play } from "lucide-react";

import type { ProductAnalyticsProbeResult } from "@/lib/channels/shopee/product-analytics/discovery";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/patterns/callout";
import { LoadingButton } from "@/components/patterns/loading-button";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { runProductAnalyticsProbeAction } from "./actions";

const CONFIRM = "READ-ONLY";

function download(name: string, data: unknown) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString("vi-VN"));

export function ProductAnalyticsProbePanel({ shops }: { shops: Array<{ id: string; name: string; status: string | null }> }) {
  const [shopId, setShopId] = useState("");
  const [itemIds, setItemIds] = useState("");
  const [confirm, setConfirm] = useState("");
  const [result, setResult] = useState<ProductAnalyticsProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () =>
    start(async () => {
      setError(null);
      const res = await runProductAnalyticsProbeAction({ shopId, itemIds, confirm });
      if (res.ok) setResult(res.result);
      else setError(res.message);
    });

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_1fr_12rem_auto] sm:items-end">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Shop</span>
          <select value={shopId} onChange={(e) => setShopId(e.target.value)} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm" aria-label="Shop">
            <option value="">— Chọn 1 shop —</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id} disabled={s.status !== "connected"}>
                {s.name}
                {s.status !== "connected" ? ` (${s.status ?? "chưa kết nối"})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Item id (tối đa 10, cách nhau bằng dấu phẩy)</span>
          <Input value={itemIds} onChange={(e) => setItemIds(e.target.value)} placeholder="24740290518, 41630539392" aria-label="Item id" autoComplete="off" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Gõ {CONFIRM} để xác nhận</span>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={CONFIRM} aria-label="Xác nhận chỉ đọc" autoComplete="off" />
        </label>
        <LoadingButton loading={pending} disabled={!shopId || !itemIds.trim() || confirm !== CONFIRM} icon={<Play aria-hidden="true" />} onClick={run}>
          {pending ? "Đang probe…" : "Chạy probe chỉ đọc"}
        </LoadingButton>
      </div>

      {error && <Callout tone="danger" title="Không chạy được probe">{error}</Callout>}

      {result && (
        <section className="space-y-3" aria-label="Kết quả probe">
          <Callout
            tone={result.report.calls.some((c) => c.classification === "OK") ? "success" : "warning"}
            title={`MÔI TRƯỜNG: ${result.environment.toUpperCase()} · CHẾ ĐỘ: CHỈ ĐỌC · SHOP: ${result.shopLabel}`}
            action={
              <Button variant="outline" size="sm" onClick={() => download(`product-analytics-probe-${result.ranAt.slice(0, 16).replace(/[:T]/g, "")}.json`, result)}>
                <Download aria-hidden="true" /> Tải báo cáo JSON
              </Button>
            }
          >
            {result.report.requestsUsed}/{result.report.requestBudget} request · cửa sổ nội bộ / Ads: {result.window.from} → {result.window.to} (giờ VN) ·{" "}
            {result.report.calls.map((c) => `${c.label}: ${c.classification}`).join(" · ")}
          </Callout>

          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-[1000px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">sale</TableHead>
                  <TableHead className="text-right">views</TableHead>
                  <TableHead className="text-right">likes</TableHead>
                  <TableHead className="text-right">sao / đánh giá</TableHead>
                  <TableHead className="text-right">SL nội bộ (từ ngày)</TableHead>
                  <TableHead className="text-right">SL 7 ngày</TableHead>
                  <TableHead className="text-right">Ads 7 ngày: hiển thị / click</TableHead>
                  <TableHead>Join Ads</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.comparisons.map((c) => (
                  <TableRow key={c.itemId}>
                    <TableCell className="font-mono text-xs">
                      {c.itemId}
                      {!c.returned && <StatusBadge tone="warning">không trả về</StatusBadge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{n(c.provider?.sale)}</TableCell>
                    <TableCell className="text-right tabular-nums">{n(c.provider?.views)}</TableCell>
                    <TableCell className="text-right tabular-nums">{n(c.provider?.likes)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {n(c.provider?.ratingStar)} / {n(c.provider?.commentCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {n(c.internal.unitsInDb)} <span className="text-xs text-muted-foreground">({c.internal.firstOrderAt?.slice(0, 10) ?? "—"})</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{n(c.internal.units7d)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {n(c.ads.impression7d)} / {n(c.ads.clicks7d)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={c.ads.adsProductRow ? "success" : "neutral"}>{c.ads.adsProductRow ? "khớp" : "không có"}</StatusBadge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  );
}
