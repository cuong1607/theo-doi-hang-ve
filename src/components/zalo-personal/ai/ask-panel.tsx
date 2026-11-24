"use client";

// ZALO PERSONAL Phase 04 — Ask AI. The question is POSTed in the body (never the URL);
// the server decides scope, period, budget, data policy and which citations are valid.
// Answers are shown as plain text; nothing is ever sent to Zalo.
import { useState, useTransition } from "react";
import { History, Loader2, MessageSquarePlus, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Callout } from "@/components/patterns/callout";
import { formatDateTime } from "@/lib/ui/format";
import type { AskResult, CoverageView, SessionRecord, TurnView } from "@/lib/zalo-personal/ai/service";

import { callApi } from "../api-client";
import { CitationChips, CitationList } from "./citation-list";

export const PERIOD_ITEMS = [
  { value: "auto", label: "Theo câu hỏi (mặc định 7 ngày)" },
  { value: "today", label: "Hôm nay" },
  { value: "yesterday", label: "Hôm qua" },
  { value: "this_week", label: "Tuần này" },
  { value: "last_week", label: "Tuần trước" },
  { value: "last_7_days", label: "7 ngày qua" },
  { value: "last_30_days", label: "30 ngày qua" },
  { value: "this_month", label: "Tháng này" },
  { value: "last_month", label: "Tháng trước" },
  { value: "custom", label: "Tùy chọn…" },
];

const EXAMPLES = ["Hôm nay nhóm này trao đổi gì?", "Hôm qua có những quyết định nào?", "Có nội dung nào chưa được xác nhận?", "Tìm những tin nhắn liên quan đến NCC"];

export function periodBody(preset: string, from: string, to: string) {
  if (preset === "auto") return undefined;
  if (preset === "custom") return { preset: "custom" as const, from, to };
  return { preset: preset as "today" };
}

export function SelectField({ label, value, onChange, items }: { label: string; value: string; onChange: (v: string) => void; items: { value: string; label: string }[] }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <Select value={value} onValueChange={(v) => onChange(String(v))} items={items}>
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((c) => (
            <SelectItem key={c.value} value={c.value}>
              {c.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function TurnCard({ turn, coverage }: { turn: TurnView; coverage?: CoverageView }) {
  return (
    <article className="space-y-3 rounded-lg border bg-card p-4" aria-label="Câu trả lời của AI">
      <header className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Hỏi: {turn.question}</span>
        <Badge variant="outline">{turn.period.label}</Badge>
        {turn.cached && <Badge variant="secondary">Dùng lại kết quả gần đây</Badge>}
        {turn.status === "sources_only" && <Badge variant="outline">Chưa qua AI</Badge>}
        <time dateTime={turn.createdAt} className="ml-auto tabular-nums">
          {formatDateTime(turn.createdAt)}
        </time>
      </header>
      {turn.notice && <Callout tone={turn.notice.tone}>{turn.notice.text}</Callout>}
      {turn.answer && <p className="whitespace-pre-wrap break-words text-sm">{turn.answer}</p>}
      {turn.points.length > 0 && (
        <ul className="list-disc space-y-1.5 pl-5 text-sm">
          {turn.points.map((p, i) => (
            <li key={i} className="break-words">
              {p.text}
              <CitationChips citations={p.citations} />
            </li>
          ))}
        </ul>
      )}
      {turn.status === "answered" && <p className="text-xs text-muted-foreground">AI có thể nhầm. Mỗi ý đều kèm tin nguồn: hãy mở tin để kiểm tra trước khi dùng.</p>}
      {coverage && (coverage.warnings.length > 0 || coverage.lastSyncAt) && (
        <div className="space-y-1 text-xs text-muted-foreground">
          {coverage.lastSyncAt && <p>Đồng bộ gần nhất: {formatDateTime(coverage.lastSyncAt)} · {coverage.messagesConsidered} tin được xem xét.</p>}
          {coverage.warnings.map((w, i) => (
            <p key={i} className="text-warning-text">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}
      <CitationList citations={turn.status === "answered" ? turn.sources.slice(0, 12) : turn.sources} title={turn.status === "answered" ? "Tin nguồn" : "Tin liên quan tìm được"} />
    </article>
  );
}

export function AskPanel({ conversations, initialSessions, defaultFrom, defaultTo, disabledReason }: { conversations: { id: string; title: string }[]; initialSessions: SessionRecord[]; defaultFrom: string; defaultTo: string; disabledReason: string | null }) {
  const [question, setQuestion] = useState("");
  const [conversationId, setConversationId] = useState("all");
  const [preset, setPreset] = useState("auto");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Array<{ turn: TurnView; coverage?: CoverageView }>>([]);
  const [sessions, setSessions] = useState(initialSessions);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const convItems = [{ value: "all", label: "Mọi hội thoại được phép" }, ...conversations.map((c) => ({ value: c.id, label: c.title }))];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (question.trim().length < 3) {
      setError("Câu hỏi cần ít nhất 3 ký tự.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await callApi<AskResult>("/api/zalo-personal/ai/ask", {
        method: "POST",
        body: { question: question.trim(), sessionId: sessionId ?? undefined, conversationIds: conversationId === "all" ? undefined : [conversationId], period: periodBody(preset, from, to) },
      });
      if (!res.ok) {
        setError(res.error === "invalid_input" ? "Câu hỏi hoặc bộ lọc không hợp lệ (câu hỏi 3–500 ký tự, khoảng thời gian tối đa 92 ngày)." : res.message);
        return;
      }
      if (!sessionId) setSessions((s) => [{ id: res.data.sessionId, userId: "", title: question.trim().slice(0, 120), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turns: 1 }, ...s]);
      setSessionId(res.data.sessionId);
      setTurns((t) => [{ turn: res.data.turn, coverage: res.data.coverage }, ...t]);
      setQuestion("");
    });
  };

  const openSession = (id: string) =>
    startTransition(async () => {
      const res = await callApi<{ turns: TurnView[] }>(`/api/zalo-personal/ai/sessions/${id}`);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setSessionId(id);
      setTurns(res.data.turns.map((turn) => ({ turn })).reverse());
    });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="space-y-4">
        {disabledReason && <Callout tone="info">{disabledReason}</Callout>}
        <form onSubmit={submit} className="grid gap-3 rounded-lg border bg-card p-4 md:grid-cols-2" aria-label="Hỏi AI">
          <label className="space-y-1 text-sm md:col-span-2">
            <span className="font-medium">Câu hỏi</span>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Ví dụ: Hôm qua nhóm kho có quyết định gì về lô hàng vải?"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </label>
          <div className="flex flex-wrap gap-1.5 md:col-span-2">
            {EXAMPLES.map((q) => (
              <button key={q} type="button" onClick={() => setQuestion(q)} className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                {q}
              </button>
            ))}
          </div>
          <SelectField label="Hội thoại" value={conversationId} onChange={setConversationId} items={convItems} />
          <SelectField label="Thời gian" value={preset} onChange={setPreset} items={PERIOD_ITEMS} />
          {preset === "custom" && (
            <>
              <label className="space-y-1 text-sm">
                <span className="font-medium">Từ ngày</span>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">Đến ngày</span>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
              </label>
            </>
          )}
          <div className="flex flex-wrap items-center gap-2 md:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Sparkles aria-hidden="true" />}
              {pending ? "Đang tìm và phân tích…" : "Hỏi AI"}
            </Button>
            {sessionId && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSessionId(null);
                  setTurns([]);
                }}
              >
                <MessageSquarePlus aria-hidden="true" />
                Phiên mới
              </Button>
            )}
            <p className="text-xs text-muted-foreground">Chỉ dùng hội thoại bạn được cấp quyền. Giờ Việt Nam. AI không gửi tin Zalo.</p>
          </div>
        </form>
        {error && <Callout tone="warning">{error}</Callout>}
        {pending && turns.length === 0 && <div className="h-32 animate-pulse rounded-lg border bg-muted/40" aria-label="Đang xử lý" />}
        <div className="space-y-3">
          {turns.map(({ turn, coverage }) => (
            <TurnCard key={turn.id} turn={turn} coverage={coverage} />
          ))}
        </div>
      </div>
      <aside className="space-y-2" aria-label="Phiên hỏi trước">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <History aria-hidden="true" className="size-4" />
          Phiên hỏi của bạn
        </h2>
        {sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground">Chưa có phiên nào.</p>
        ) : (
          <ul className="space-y-1">
            {sessions.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => openSession(s.id)} className={`w-full rounded-md border px-2.5 py-1.5 text-left text-xs hover:bg-muted ${s.id === sessionId ? "border-app-accent-border bg-app-accent-soft/50" : ""}`}>
                  <span className="line-clamp-2 break-words font-medium">{s.title}</span>
                  <span className="text-muted-foreground tabular-nums">{formatDateTime(s.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted-foreground">Chỉ bạn thấy các phiên này. Câu trả lời dựa trên hội thoại bạn mất quyền xem sẽ tự ẩn.</p>
      </aside>
    </div>
  );
}
