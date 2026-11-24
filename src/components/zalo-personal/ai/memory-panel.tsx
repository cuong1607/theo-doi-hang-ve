"use client";

// ZALO PERSONAL Phase 04 — on-demand summaries + structured memory for ONE conversation.
// Nothing is summarised automatically. Every item keeps its source messages; AI items
// stay "AI suy luận" until a person with manage rights confirms or rejects them.
import { useState, useTransition } from "react";
import { Brain, Check, FileText, Loader2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/patterns/callout";
import { toast } from "@/components/patterns/toast";
import { formatDateTime } from "@/lib/ui/format";
import type { FactView, MemoryView, NoticeView, SummarizeResult, SummaryView } from "@/lib/zalo-personal/ai/service";

import { callApi } from "../api-client";
import { PERIOD_ITEMS, periodBody, SelectField } from "./ask-panel";
import { CitationChips } from "./citation-list";

const KIND_ITEMS = [
  { value: "daily", label: "Theo ngày" },
  { value: "conversation", label: "Cả hội thoại trong khoảng" },
  { value: "topic", label: "Theo chủ đề" },
  { value: "decision", label: "Các quyết định" },
];
const FACT_KIND: Record<string, string> = { fact: "Thông tin", decision: "Quyết định", project_ref: "Dự án / lô hàng", assignment: "Việc được nhắc", open_question: "Câu hỏi mở", important_date: "Mốc thời gian" };
const EVIDENCE: Record<FactView["evidenceStatus"], string> = { ai_inferred: "AI suy luận", user_confirmed: "Đã xác nhận", user_rejected: "Đã bác bỏ" };
const STALE: Record<string, string> = { source_deleted: "tin nguồn đã bị xóa", consent_withdrawn: "nhóm đã rút đồng ý", superseded: "đã có bản mới" };

function SummaryCard({ s }: { s: SummaryView }) {
  return (
    <article className="space-y-2 rounded-lg border bg-card p-4">
      <header className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{KIND_ITEMS.find((k) => k.value === s.kind)?.label}{s.topic ? `: ${s.topic}` : ""}</span>
        <Badge variant="outline">{s.periodLabel}</Badge>
        <Badge variant="outline">{s.messageCount} tin · v{s.version}</Badge>
        {s.reused && <Badge variant="secondary">Dùng lại (nguồn không đổi)</Badge>}
        {s.status === "stale" && <Badge variant="destructive">Cũ: {STALE[s.staleReason ?? ""] ?? "cần tạo lại"}</Badge>}
        <span className="ml-auto tabular-nums">{formatDateTime(s.createdAt)}</span>
      </header>
      {s.summary && <p className="whitespace-pre-wrap break-words text-sm">{s.summary}</p>}
      {s.sections
        .filter((x) => x.items.length > 0)
        .map((sec) => (
          <div key={sec.key}>
            <h4 className="text-xs font-medium text-muted-foreground">{sec.title}</h4>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {sec.items.map((it, i) => (
                <li key={i} className="break-words">
                  {it.date && <span className="tabular-nums">{it.date.split("-").reverse().join("/")}: </span>}
                  {it.text}
                  {typeof it.confidence === "number" && <span className="ml-1 text-xs text-muted-foreground">(độ tin cậy {Math.round(it.confidence * 100)}%)</span>}
                  <CitationChips citations={it.citations} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      {s.truncated && <p className="text-xs text-muted-foreground">Khoảng thời gian có nhiều tin hơn giới hạn: chỉ phần tin mới nhất được tóm tắt.</p>}
    </article>
  );
}

export function MemoryPanel({ conversations, defaultFrom, defaultTo }: { conversations: { id: string; title: string }[]; defaultFrom: string; defaultTo: string }) {
  const [conversationId, setConversationId] = useState(conversations[0]?.id ?? "");
  const [kind, setKind] = useState("daily");
  const [preset, setPreset] = useState("today");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [topic, setTopic] = useState("");
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [latest, setLatest] = useState<SummaryView | null>(null);
  const [notice, setNotice] = useState<NoticeView | null>(null);
  const [pending, startTransition] = useTransition();

  if (conversations.length === 0) return <p className="text-sm text-muted-foreground">Chưa có hội thoại nào bạn được phép xem.</p>;

  const load = (id: string) =>
    startTransition(async () => {
      const res = await callApi<MemoryView>(`/api/zalo-personal/ai/memory/${id}`);
      if (!res.ok) toast.error(res.message);
      else setMemory(res.data);
    });

  const summarize = (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);
    startTransition(async () => {
      const res = await callApi<SummarizeResult>("/api/zalo-personal/ai/summarize", {
        method: "POST",
        body: { conversationId, kind, topic: kind === "topic" ? topic.trim() : undefined, period: kind === "daily" && preset === "auto" ? undefined : periodBody(preset, from, to) },
      });
      if (!res.ok) {
        setNotice({ code: res.error, text: res.error === "invalid_input" ? "Thiếu hoặc sai thông tin (chủ đề 2–100 ký tự; tóm tắt theo ngày chỉ một ngày)." : res.message, tone: "warning" });
        return;
      }
      setLatest(res.data.summary);
      setNotice(res.data.notice);
      const m = await callApi<MemoryView>(`/api/zalo-personal/ai/memory/${conversationId}`);
      if (m.ok) setMemory(m.data);
    });
  };

  const review = (f: FactView, evidence: "user_confirmed" | "user_rejected") =>
    startTransition(async () => {
      const res = await callApi<{ changed: boolean }>(`/api/zalo-personal/ai/facts/${f.id}`, { method: "PATCH", body: { evidence } });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      setMemory((m) => (m ? { ...m, facts: m.facts.map((x) => (x.id === f.id ? { ...x, evidenceStatus: evidence } : x)) } : m));
    });

  return (
    <div className="space-y-4">
      <form onSubmit={summarize} className="grid gap-3 rounded-lg border bg-card p-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Tóm tắt hội thoại">
        <SelectField
          label="Hội thoại"
          value={conversationId}
          onChange={(v) => {
            setConversationId(v);
            setMemory(null);
            setLatest(null);
          }}
          items={conversations.map((c) => ({ value: c.id, label: c.title }))}
        />
        <SelectField label="Loại tóm tắt" value={kind} onChange={setKind} items={KIND_ITEMS} />
        <SelectField label="Thời gian" value={preset} onChange={setPreset} items={PERIOD_ITEMS.filter((p) => p.value !== "auto")} />
        {kind === "topic" && (
          <label className="space-y-1 text-sm">
            <span className="font-medium">Chủ đề</span>
            <Input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={100} placeholder="Ví dụ: vải cotton" required />
          </label>
        )}
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
        <div className="flex flex-wrap items-end gap-2 md:col-span-2 xl:col-span-4">
          <Button type="submit" disabled={pending || !conversationId}>
            {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <FileText aria-hidden="true" />}
            Tóm tắt
          </Button>
          <Button type="button" variant="outline" disabled={pending || !conversationId} onClick={() => load(conversationId)}>
            <Brain aria-hidden="true" />
            Xem ghi nhớ đã lưu
          </Button>
          <p className="text-xs text-muted-foreground">Chỉ tóm tắt khi bạn bấm. Nếu tin nguồn không đổi, hệ thống dùng lại bản cũ thay vì gọi AI.</p>
        </div>
      </form>
      {notice && <Callout tone={notice.tone}>{notice.text}</Callout>}
      {latest && <SummaryCard s={latest} />}
      {memory && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Ghi nhớ của {memory.conversation.title}</h3>
          {memory.facts.length === 0 && memory.summaries.length === 0 && <p className="text-sm text-muted-foreground">Chưa có tóm tắt hay ghi nhớ nào.</p>}
          {memory.facts.length > 0 && (
            <ul className="space-y-1.5">
              {memory.facts.map((f) => (
                <li key={f.id} className={`rounded-md border px-3 py-2 text-sm ${f.status !== "active" ? "opacity-60" : ""}`}>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="outline">{FACT_KIND[f.kind]}</Badge>
                    <Badge variant={f.evidenceStatus === "user_confirmed" ? "secondary" : "outline"}>{EVIDENCE[f.evidenceStatus]}</Badge>
                    <span>độ tin cậy {Math.round(f.confidence * 100)}%</span>
                    {f.status !== "active" && <Badge variant="destructive">Cũ: {STALE[f.staleReason ?? ""] ?? f.status}</Badge>}
                    {memory.canReview && f.status === "active" && (
                      <span className="ml-auto inline-flex gap-1">
                        <Button size="xs" variant="outline" disabled={pending || f.evidenceStatus === "user_confirmed"} onClick={() => review(f, "user_confirmed")}>
                          <Check aria-hidden="true" />
                          Xác nhận
                        </Button>
                        <Button size="xs" variant="outline" disabled={pending || f.evidenceStatus === "user_rejected"} onClick={() => review(f, "user_rejected")}>
                          <X aria-hidden="true" />
                          Bác bỏ
                        </Button>
                      </span>
                    )}
                  </div>
                  <p className="mt-1 break-words">
                    {f.valueDate && <span className="tabular-nums">{f.valueDate.split("-").reverse().join("/")}: </span>}
                    {f.statement}
                    <CitationChips citations={f.citations} />
                  </p>
                </li>
              ))}
            </ul>
          )}
          {memory.summaries.map((s) => (
            <SummaryCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}
