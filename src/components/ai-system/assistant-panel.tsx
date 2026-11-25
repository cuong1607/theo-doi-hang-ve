"use client";

// PHASE 05 — Trợ lý hệ thống (web). The question is POSTed in the body; the
// server decides identity, permissions, tools, data policy and budget. The
// history below lives only in this page (not stored as a conversation, never
// mixed with Zalo OA / Zalo Personal histories). Answers are plain text.
import { useState, useTransition } from "react";
import { Bot, Database, ExternalLink, Loader2, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/patterns/callout";
import type { AnswerStatus, AssistantResponse, SourceRef } from "@/lib/ai-system/types";
import { formatDateTime } from "@/lib/ui/format";

import { callApi } from "../zalo-personal/api-client";

const STATUS_VIEW: Record<AnswerStatus, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  answered: { label: "Đã trả lời", tone: "success" },
  insufficient: { label: "Thiếu dữ liệu", tone: "warning" },
  denied: { label: "Không có quyền", tone: "danger" },
  unsupported: { label: "Chưa hỗ trợ", tone: "info" },
  clarify: { label: "Cần rõ hơn", tone: "info" },
  refused: { label: "Chỉ đọc", tone: "warning" },
  error: { label: "Lỗi lấy dữ liệu", tone: "danger" },
  rate_limited: { label: "Hỏi quá nhanh", tone: "warning" },
};

const FRESHNESS: Record<SourceRef["freshness"], string> = {
  fresh: "dữ liệu mới",
  stale: "dữ liệu có thể đã cũ",
  manual_entry: "nhập tay",
  unknown: "không rõ thời điểm",
};

const OUTCOME: Record<string, string> = { ok: "có dữ liệu", empty: "không có bản ghi", denied: "bị từ chối", invalid_args: "tham số sai", not_found: "không tìm thấy", ambiguous: "chưa rõ đối tượng", unavailable: "chưa có dữ liệu", timeout: "quá thời gian", error: "lỗi" };

interface Turn {
  question: string;
  response: AssistantResponse;
}

function SourceList({ sources }: { sources: SourceRef[] }) {
  if (!sources.length) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Nguồn dữ liệu</h3>
      <ul className="space-y-1.5 text-xs">
        {sources.map((s) => (
          <li key={s.id} className="rounded-md border bg-muted/30 px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{s.id}</Badge>
              <span className="font-medium text-foreground">{s.label}</span>
              <span className="text-muted-foreground">· {s.origin}</span>
              {s.href && (
                <a href={s.href} className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">
                  Mở màn hình <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              )}
            </div>
            <p className="mt-1 text-muted-foreground">
              Phạm vi: {s.coverage}. Đọc lúc {formatDateTime(s.readAt)} · dữ liệu cập nhật {s.dataUpdatedAt ? formatDateTime(s.dataUpdatedAt) : "không rõ"} ({FRESHNESS[s.freshness]}).
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TurnCard({ turn }: { turn: Turn }) {
  const r = turn.response;
  const view = STATUS_VIEW[r.status];
  const callout = r.status !== "answered";
  return (
    <article className="space-y-3 rounded-lg border bg-card p-4" aria-label="Câu trả lời của trợ lý">
      <header className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Hỏi: {turn.question}</span>
        <Badge variant={view.tone === "success" ? "secondary" : "outline"}>{view.label}</Badge>
        <time dateTime={r.meta.generatedAt} className="ml-auto tabular-nums">
          {formatDateTime(r.meta.generatedAt)}
        </time>
      </header>
      {callout ? <Callout tone={view.tone}>{r.answer}</Callout> : r.answer && <p className="whitespace-pre-wrap break-words text-sm">{r.answer}</p>}
      {r.points.length > 0 && (
        <ul className="list-disc space-y-1.5 pl-5 text-sm">
          {r.points.map((p, i) => (
            <li key={i} className="break-words">
              {p.text}
              {p.sourceIds.map((s) => (
                <Badge key={s} variant="outline" className="ml-1.5 align-middle text-[10px]">
                  {s}
                </Badge>
              ))}
            </li>
          ))}
        </ul>
      )}
      {r.caveats.length > 0 && (
        <ul className="space-y-1 text-xs text-warning-text" aria-label="Lưu ý">
          {r.caveats.map((c, i) => (
            <li key={i}>⚠ {c}</li>
          ))}
        </ul>
      )}
      <SourceList sources={r.sources} />
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {r.tools.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Database aria-hidden="true" className="size-3" />
            {r.tools.map((t) => `${t.title} (${OUTCOME[t.outcome] ?? t.outcome})`).join(" · ")}
          </span>
        )}
        <span>{r.meta.synthesis === "gemini" ? `Diễn đạt bởi AI (${r.meta.model ?? "Gemini"}), số liệu đã đối chiếu với nguồn` : r.meta.synthesis === "formatter" ? "Số liệu trình bày nguyên văn từ hệ thống (không qua AI)" : ""}</span>
        {r.meta.notice && <span className="text-warning-text">{r.meta.notice}</span>}
      </footer>
      {r.status === "answered" && r.meta.synthesis === "gemini" && <p className="text-xs text-muted-foreground">AI có thể diễn đạt sai. Mỗi ý kèm nhãn nguồn; mở màn hình nguồn để kiểm tra trước khi dùng.</p>}
    </article>
  );
}

export function AssistantPanel({ suggestions, disabledNotice }: { suggestions: string[]; disabledNotice: string | null }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const ask = (q: string) => {
    const text = q.trim();
    if (text.length < 2) {
      setError("Bạn nhập câu hỏi (ít nhất 2 ký tự) nhé.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await callApi<AssistantResponse>("/api/ai/system/ask", { method: "POST", body: { question: text } });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setTurns((t) => [{ question: text, response: res.data }, ...t].slice(0, 20));
      setQuestion("");
    });
  };

  return (
    <div className="space-y-4">
      {disabledNotice && <Callout tone="info">{disabledNotice}</Callout>}
      <form
        className="space-y-2 rounded-lg border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <label htmlFor="sys-question" className="text-sm font-medium">
          Câu hỏi về dữ liệu hệ thống
        </label>
        <textarea
          id="sys-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(question);
            }
          }}
          maxLength={500}
          rows={2}
          placeholder="Ví dụ: Còn nợ nhà cung cấp bao nhiêu?"
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={pending}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Send aria-hidden="true" className="size-4" />}
            {pending ? "Đang lấy dữ liệu…" : "Hỏi"}
          </Button>
          <span className="text-xs text-muted-foreground">{question.length}/500 · Chỉ đọc dữ liệu theo quyền của bạn.</span>
        </div>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1" aria-label="Câu hỏi gợi ý">
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => ask(s)} disabled={pending} className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
                {s}
              </button>
            ))}
          </div>
        )}
      </form>
      {error && <Callout tone="danger">{error}</Callout>}
      {pending && (
        <div className="flex items-center gap-2 rounded-lg border bg-card p-4 text-sm text-muted-foreground" role="status">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Đang kiểm tra quyền và đọc dữ liệu…
        </div>
      )}
      {turns.length === 0 && !pending && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          <Bot aria-hidden="true" className="size-4" /> Chưa có câu hỏi nào. Chọn một câu gợi ý hoặc tự nhập câu hỏi.
        </div>
      )}
      <div className="space-y-3">
        {turns.map((t, i) => (
          <TurnCard key={`${t.response.meta.generatedAt}-${i}`} turn={t} />
        ))}
      </div>
    </div>
  );
}
