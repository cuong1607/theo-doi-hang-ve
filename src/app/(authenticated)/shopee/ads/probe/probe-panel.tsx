"use client";

import { useState, useTransition } from "react";
import { Download, Play } from "lucide-react";

import { ADS_PROBE_CONFIRM_TEXT, type AdsProbeClassification, type AdsProbeReport } from "@/lib/channels/shopee/ads/probe";
import type { Tone } from "@/lib/ui/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/patterns/callout";
import { LoadingButton } from "@/components/patterns/loading-button";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { runAdsProbeAction } from "./actions";

const TONE: Record<AdsProbeClassification, Tone> = {
  AVAILABLE: "success",
  PARAM_ERROR: "warning",
  SHOP_NOT_ELIGIBLE: "warning",
  ENDPOINT_UNAVAILABLE: "warning",
  PERMISSION_DENIED: "danger",
  REAUTH_REQUIRED: "danger",
  PROVIDER_ERROR: "danger",
  UNKNOWN: "neutral",
};

const STOP_LABEL: Record<AdsProbeReport["stoppedReason"], string> = {
  completed: "Hoàn tất",
  budget: "Dừng: hết ngân sách request",
  circuit_breaker: "Dừng: lỗi lặp lại (circuit breaker)",
  reauth_required: "Dừng: token / quyền cần kết nối lại",
};

function download(name: string, data: unknown) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function AdsProbePanel({ shops }: { shops: Array<{ id: string; name: string; status: string | null }> }) {
  const [shopId, setShopId] = useState("");
  const [confirm, setConfirm] = useState("");
  const [report, setReport] = useState<AdsProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () =>
    start(async () => {
      setError(null);
      const res = await runAdsProbeAction({ shopId, confirm });
      if (res.ok) setReport(res.report);
      else setError(res.message);
    });

  const stamp = report ? report.startedAt.slice(0, 16).replace(/[:T]/g, "") : "";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Shop thí điểm (đang chạy quảng cáo)</span>
          <select
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            aria-label="Shop thí điểm"
          >
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
          <span className="font-medium">Gõ {ADS_PROBE_CONFIRM_TEXT} để xác nhận</span>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={ADS_PROBE_CONFIRM_TEXT} aria-label="Xác nhận chỉ đọc" autoComplete="off" />
        </label>
        <LoadingButton loading={pending} disabled={!shopId || confirm !== ADS_PROBE_CONFIRM_TEXT} icon={<Play aria-hidden="true" />} onClick={run}>
          {pending ? "Đang probe…" : "Chạy probe chỉ đọc"}
        </LoadingButton>
      </div>

      {error && <Callout tone="danger" title="Không chạy được probe">{error}</Callout>}

      {report && (
        <section className="space-y-3" aria-label="Kết quả probe">
          <Callout
            tone={report.adsAccess === "AVAILABLE" ? "success" : "warning"}
            title={`MÔI TRƯỜNG: ${report.environment.toUpperCase()} · CHẾ ĐỘ: CHỈ ĐỌC · SHOP: ${report.shopLabel}`}
            action={
              <Button variant="outline" size="sm" onClick={() => download(`ads-probe-report-${stamp}.json`, report)}>
                <Download aria-hidden="true" /> Tải báo cáo JSON
              </Button>
            }
          >
            Truy cập Ads: <strong>{report.adsAccess ?? "—"}</strong> · {STOP_LABEL[report.stoppedReason]} · {report.requestsUsed}/{report.requestBudget} request · ngày (giờ shop): hôm qua {report.dates.yesterday}
          </Callout>

          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Tham số</TableHead>
                  <TableHead>HTTP</TableHead>
                  <TableHead>Kết quả</TableHead>
                  <TableHead>Lỗi provider</TableHead>
                  <TableHead className="text-right">ms</TableHead>
                  <TableHead>Bản ghi</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.calls.map((c) => (
                  <TableRow key={c.step}>
                    <TableCell>{c.step}</TableCell>
                    <TableCell>
                      <div className="font-mono text-xs">GET {c.path.replace("/api/v2/ads/", "")}</div>
                      <div className="text-xs text-muted-foreground">{c.purpose}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{JSON.stringify(c.params)}</TableCell>
                    <TableCell>{c.httpStatus ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge tone={TONE[c.classification]}>{c.classification}</StatusBadge>
                      {c.identicalTo !== undefined && <div className="mt-1 text-xs text-muted-foreground">{c.identicalTo > 0 ? `giống bước ${c.identicalTo}` : `khác bước ${-c.identicalTo}`}</div>}
                    </TableCell>
                    <TableCell className="max-w-64 text-xs">
                      {c.errorCode ? <span className="font-mono">{c.errorCode}</span> : "—"}
                      {c.message && <div className="text-muted-foreground">{c.message}</div>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{c.latencyMs}</TableCell>
                    <TableCell className="font-mono text-xs">{Object.entries(c.arrayLengths).map(([k, n]) => `${k}: ${n}`).join(", ") || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {report.calls.map((c) => (
            <details key={c.step} className="rounded-lg border px-3 py-2 text-sm">
              <summary className="cursor-pointer font-mono text-xs">
                #{c.step} {c.endpoint} — {c.classification}
              </summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(c.body, null, 2)}</pre>
            </details>
          ))}
        </section>
      )}
    </div>
  );
}
