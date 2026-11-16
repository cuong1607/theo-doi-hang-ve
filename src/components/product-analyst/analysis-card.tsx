// PRODUCT-ANALYTICS-4: one validated AnalystOutput, rendered for the web chat.
// Order follows the contract: conclusion → data caveat → evidence → findings →
// hypotheses (with both sides) → missing data → what to check. Colours are
// tokens; every tone also has words (never colour alone).
import { AlertTriangle, CircleHelp, ListChecks, Lightbulb, SearchCheck } from "lucide-react";

import type { AnalystOutput, Confidence, FindingSeverity } from "@/lib/product-analyst/contracts";

const CONF: Record<Confidence, { label: string; cls: string }> = {
  HIGH: { label: "Độ tin cậy cao", cls: "bg-success-soft text-success-text" },
  MEDIUM: { label: "Độ tin cậy trung bình", cls: "bg-info-soft text-info-text" },
  LOW: { label: "Độ tin cậy thấp", cls: "bg-warning-soft text-warning-text" },
};
const SEV: Record<FindingSeverity, { label: string; cls: string }> = {
  INFO: { label: "Thông tin", cls: "border-l-info" },
  NOTICE: { label: "Đáng chú ý", cls: "border-l-warning" },
  WARNING: { label: "Cảnh báo", cls: "border-l-destructive" },
};

export function ConfidenceBadge({ value }: { value: Confidence }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CONF[value].cls}`}>{CONF[value].label}</span>;
}

export function AnalysisCard({ output, meta }: { output: AnalystOutput; meta?: { cached?: boolean; durationMs?: number } }) {
  const evidenceById = new Map(output.evidence.map((e) => [e.id, e.text]));
  const analytic = output.findings.length > 0 || output.hypotheses.length > 0 || output.evidence.length > 0;
  return (
    <div className="space-y-3 text-sm" data-slot="analysis-card">
      <div className="space-y-2">
        <p className="text-[0.95rem] leading-relaxed font-medium text-foreground">{output.summary}</p>
        {analytic && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ConfidenceBadge value={output.confidence} />
            {meta?.cached && <span>· câu trả lời đã lưu (dữ liệu chưa đổi)</span>}
          </div>
        )}
      </div>

      {output.data_quality_note && (
        <p role="note" className="flex gap-2 rounded-lg bg-warning-soft px-3 py-2 text-warning-text">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="sr-only">Lưu ý dữ liệu: </span>
            {output.data_quality_note}
          </span>
        </p>
      )}

      {output.evidence.length > 0 && (
        <section aria-label="Bằng chứng chính">
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Bằng chứng chính</h3>
          <ul className="flex flex-wrap gap-1.5">
            {output.evidence.map((e) => (
              <li key={e.id} className="rounded-md border bg-card px-2 py-1 text-xs">
                {e.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {output.findings.length > 0 && (
        <section aria-label="Nhận định" className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <SearchCheck aria-hidden="true" className="size-3.5" /> Nhận định
          </h3>
          {output.findings.map((f, i) => (
            <div key={i} className={`rounded-md border border-l-4 bg-card px-3 py-2 ${SEV[f.severity].cls}`}>
              <p className="font-medium">
                {f.title} <span className="text-xs font-normal text-muted-foreground">· {SEV[f.severity].label}</span>
              </p>
              <p className="text-muted-foreground">{f.description}</p>
              {f.evidence_refs.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Căn cứ: {f.evidence_refs.map((r) => evidenceById.get(r)).filter(Boolean).join(" · ")}</p>}
            </div>
          ))}
        </section>
      )}

      {output.hypotheses.length > 0 && (
        <section aria-label="Khả năng giải thích" className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <Lightbulb aria-hidden="true" className="size-3.5" /> Khả năng (giả thuyết, chưa phải kết luận)
          </h3>
          {output.hypotheses.map((h, i) => (
            <details key={i} className="group rounded-md border bg-card px-3 py-2">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-2 rounded focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                <span>{h.statement}</span>
                <ConfidenceBadge value={h.confidence} />
              </summary>
              <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
                <Side label="Ủng hộ" items={h.supporting_evidence} />
                <Side label="Ngược lại" items={h.counter_evidence} />
                <Side label="Còn thiếu" items={h.missing_data} />
              </dl>
            </details>
          ))}
        </section>
      )}

      {output.missing_data.length > 0 && (
        <p className="flex gap-2 text-xs text-muted-foreground">
          <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>Hệ thống chưa có: {output.missing_data.join("; ")}.</span>
        </p>
      )}

      {output.suggested_checks.length > 0 && (
        <section aria-label="Nên kiểm tra">
          <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <ListChecks aria-hidden="true" className="size-3.5" /> Nên kiểm tra
          </h3>
          <ul className="list-disc space-y-0.5 pl-5">
            {output.suggested_checks.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </section>
      )}
      {meta?.durationMs !== undefined && !meta.cached && <p className="text-[11px] text-muted-foreground">Phân tích trong {(meta.durationMs / 1000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} giây · chỉ đọc dữ liệu đã đồng bộ</p>}
    </div>
  );
}

function Side({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="flex gap-1.5">
      <dt className="shrink-0 font-medium">{label}:</dt>
      <dd>{items.join("; ")}</dd>
    </div>
  );
}
