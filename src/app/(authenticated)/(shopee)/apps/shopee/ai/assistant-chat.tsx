"use client";

// PRODUCT-ANALYTICS-4: web chat of the Product Analyst. The URL holds the
// context (shop / product / period): changing it navigates, and the server
// re-validates it. One analysis at a time (send disabled while pending); the
// server enforces the timeout. Nothing is sent to the model until the user
// presses send or a suggested question.
import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bot, Loader2, Package, SendHorizontal, Store, User, X } from "lucide-react";

import type { AnalystOutput } from "@/lib/product-analyst/contracts";
import { AnalysisCard } from "@/components/product-analyst/analysis-card";

import { askProductAnalystAction, searchAssistantProducts, type ProductOption } from "./actions";

export type ChatPeriod = "today" | "yesterday" | "7d" | "30d";
const PERIODS: Array<{ id: ChatPeriod; label: string }> = [
  { id: "today", label: "Hôm nay" },
  { id: "yesterday", label: "Hôm qua" },
  { id: "7d", label: "7 ngày" },
  { id: "30d", label: "30 ngày" },
];

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  analysis?: AnalystOutput | null;
  meta?: { cached?: boolean; durationMs?: number };
  failed?: boolean;
}

export function AssistantChat({
  shops,
  shopId,
  product,
  period,
  initialMessages,
  freshness,
}: {
  shops: Array<{ id: string; name: string }>;
  shopId: string;
  product: ProductOption | null;
  period: ChatPeriod;
  initialMessages: ChatMessage[];
  freshness: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [pending, start] = useTransition();
  const [status, setStatus] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, pending]);

  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.push(`${pathname}?${next.toString()}`);
  };

  const shopName = shops.find((s) => s.id === shopId)?.name ?? "";
  const suggestions = product
    ? ["Tại sao doanh số sản phẩm này giảm?", "Ads của sản phẩm này kỳ này thế nào?", "ROAS giảm do CPC hay conversion?"]
    : [`Sản phẩm nào cần chú ý nhất ở ${shopName}?`, "Sản phẩm nào yếu nhất kỳ này?"];

  const send = (text: string, analysisType: "user_question" | "ui_request" = "user_question") => {
    const question = text.trim();
    if (!question || pending) return;
    const clientMessageId = crypto.randomUUID();
    setMessages((m) => [...m, { id: clientMessageId, role: "user", text: question }]);
    setInput("");
    setStatus("Đang phân tích…");
    start(async () => {
      const r = await askProductAnalystAction({ shopId, productId: product?.id ?? null, period, question, clientMessageId, analysisType });
      if (r.kind === "duplicate") {
        setStatus("");
        return;
      }
      const reply: ChatMessage =
        r.kind === "analysis"
          ? { id: `${clientMessageId}-a`, role: "assistant", text: r.output.summary, analysis: r.output, meta: { cached: r.cached, durationMs: r.durationMs } }
          : { id: `${clientMessageId}-a`, role: "assistant", text: r.message, failed: r.kind === "error" || r.kind === "denied" || r.kind === "unauthorized" };
      setMessages((m) => [...m, reply]);
      setStatus(r.kind === "analysis" ? "Đã có câu trả lời." : r.message);
      inputRef.current?.focus();
    });
  };

  return (
    <div className="flex min-h-[calc(100svh-9rem)] flex-col gap-3" data-slot="assistant-chat">
      <ContextBar shops={shops} shopId={shopId} product={product} period={period} freshness={freshness} disabled={pending} onChange={go} />

      <ol ref={listRef} aria-label="Hội thoại" className="flex-1 space-y-3 overflow-y-auto rounded-2xl border bg-ads-surface p-3 md:p-4">
        {messages.length === 0 && (
          <li className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <span aria-hidden="true" className="app-gradient inline-flex size-10 items-center justify-center rounded-xl text-white dark:text-background">
              <Bot className="size-5" />
            </span>
            <p className="font-medium text-foreground">Hỏi về {product ? "sản phẩm này" : `các sản phẩm của ${shopName}`}</p>
            <p className="max-w-md">Trợ lý đọc số liệu đã đồng bộ (doanh số, Ads, tín hiệu), tách rõ dữ kiện và giả thuyết, và không thay đổi gì trên Shopee.</p>
          </li>
        )}
        {messages.map((m) => (
          <li key={m.id} className={`flex gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`} data-role={m.role}>
            {m.role === "assistant" && (
              <span aria-hidden="true" className="mt-1 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-app-accent-soft text-app-accent-text">
                <Bot className="size-4" />
              </span>
            )}
            <div className={`max-w-[min(42rem,88%)] min-w-0 rounded-2xl px-3 py-2 ${m.role === "user" ? "bg-app-accent text-white dark:text-background" : m.failed ? "border border-warning/40 bg-warning-soft text-warning-text" : "border bg-card"}`}>
              <span className="sr-only">{m.role === "user" ? "Bạn: " : "Trợ lý: "}</span>
              {m.analysis ? <AnalysisCard output={m.analysis} meta={m.meta} /> : <p className="text-sm whitespace-pre-line">{m.text}</p>}
            </div>
            {m.role === "user" && (
              <span aria-hidden="true" className="mt-1 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <User className="size-4" />
              </span>
            )}
          </li>
        ))}
        {pending && (
          <li className="flex items-center gap-2 text-sm text-muted-foreground" aria-hidden="true">
            <Loader2 className="size-4 animate-spin" /> Đang đọc số liệu và phân tích…
          </li>
        )}
      </ol>
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>

      <div className="flex flex-wrap gap-2" aria-label="Câu hỏi gợi ý">
        {suggestions.map((s) => (
          <button key={s} type="button" disabled={pending} onClick={() => send(s, "ui_request")} className="rounded-full border border-ads-border bg-card px-3 py-1.5 text-xs text-foreground hover:bg-ads-surface-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50">
            {s}
          </button>
        ))}
      </div>

      <form
        className="sticky bottom-0 flex items-end gap-2 rounded-2xl border bg-card p-2 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <label htmlFor="assistant-input" className="sr-only">
          Câu hỏi cho trợ lý phân tích
        </label>
        <textarea
          id="assistant-input"
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(input);
            }
          }}
          rows={1}
          maxLength={2000}
          placeholder={product ? "Hỏi về sản phẩm này…" : "Hỏi về các sản phẩm của shop…"}
          className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
        <button type="submit" disabled={pending || !input.trim()} aria-label="Gửi câu hỏi" className="ads-gradient-primary inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-white focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none disabled:opacity-50">
          {pending ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <SendHorizontal aria-hidden="true" className="size-4" />}
        </button>
      </form>
    </div>
  );
}

function ContextBar({
  shops,
  shopId,
  product,
  period,
  freshness,
  disabled,
  onChange,
}: {
  shops: Array<{ id: string; name: string }>;
  shopId: string;
  product: ProductOption | null;
  period: ChatPeriod;
  freshness: string | null;
  disabled: boolean;
  onChange: (patch: Record<string, string | null>) => void;
}) {
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<ProductOption[]>([]);
  const [searching, startSearch] = useTransition();

  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(() => startSearch(async () => setOptions(await searchAssistantProducts({ shopId, q }))), 250);
    return () => clearTimeout(t);
  }, [q, shopId]);
  const shownOptions = q.trim().length < 2 ? [] : options;

  const field = "h-9 rounded-full border border-ads-border bg-card px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";
  return (
    <section aria-label="Ngữ cảnh phân tích" className="flex flex-wrap items-center gap-2 rounded-2xl border border-ads-border bg-ads-surface p-2.5" data-slot="assistant-context">
      <label className="flex min-w-0 flex-[1_1_10rem] items-center gap-1.5">
        <Store aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="sr-only">Shop</span>
        <select value={shopId} disabled={disabled} onChange={(e) => onChange({ shop: e.target.value, product: null })} className={`${field} w-full min-w-0`}>
          {shops.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <div className="relative flex min-w-0 flex-[2_1_14rem] items-center gap-1.5">
        <Package aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        {product ? (
          <span className="flex h-9 min-w-0 flex-1 items-center gap-1 rounded-full border border-app-accent-border bg-app-accent-soft px-3 text-sm text-app-accent-text" data-slot="assistant-product">
            <span className="truncate" title={product.name ?? product.itemId}>
              {product.name ?? `Item ${product.itemId}`}
            </span>
            <button type="button" disabled={disabled} onClick={() => onChange({ product: null })} aria-label="Bỏ chọn sản phẩm (hỏi cấp shop)" className="ml-auto rounded-full p-0.5 hover:bg-card focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
              <X className="size-3.5" />
            </button>
          </span>
        ) : (
          <>
            <label htmlFor="assistant-product-search" className="sr-only">
              Chọn sản phẩm (tên, SKU hoặc item ID)
            </label>
            <input
              id="assistant-product-search"
              value={q}
              disabled={disabled}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Cả shop · tìm sản phẩm (tên, SKU, ID)…"
              autoComplete="off"
              role="combobox"
              aria-expanded={shownOptions.length > 0}
              aria-controls="assistant-product-options"
              className={`${field} w-full min-w-0`}
            />
            {shownOptions.length > 0 && (
              <ul id="assistant-product-options" role="listbox" aria-label="Sản phẩm phù hợp" className="absolute top-10 right-0 left-6 z-30 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg">
                {shownOptions.map((o) => (
                  <li key={o.id} role="option" aria-selected="false">
                    <button
                      type="button"
                      onClick={() => {
                        setQ("");
                        onChange({ product: o.id });
                      }}
                      className="w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    >
                      <span className="line-clamp-1">{o.name ?? `Item ${o.itemId}`}</span>
                      <span className="text-xs text-muted-foreground">
                        {o.sku ? `SKU ${o.sku} · ` : ""}ID {o.itemId}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {searching && <Loader2 aria-hidden="true" className="absolute right-3 size-4 animate-spin text-muted-foreground" />}
          </>
        )}
      </div>

      <div role="radiogroup" aria-label="Kỳ phân tích" className="flex rounded-full border border-ads-border bg-card p-0.5">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={p.id === period}
            disabled={disabled}
            onClick={() => onChange({ period: p.id === "7d" ? null : p.id })}
            className={`rounded-full px-2.5 py-1 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${p.id === period ? "bg-app-accent text-white dark:text-background" : "text-muted-foreground hover:text-foreground"}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {freshness && <p className="w-full text-[11px] text-muted-foreground">{freshness}</p>}
    </section>
  );
}
