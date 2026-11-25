// ============================================================
// PHASE 05 — Central AI System Assistant: shared types.
//
// Vocabulary
//   channel   where the question came from (web dashboard, Zalo OA, Zalo Personal)
//   audience  who will READ the answer: "private" = only the asker, "group" =
//             a multi-member conversation (answers there are public to everyone in it)
//   sensitivity of a tool's data: knowledge (definitions, no live data),
//             operational (hàng về), financial (công nợ, doanh số, Ads spend)
//
// Pure: no I/O, no "@/" imports.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ZodType } from "zod";

import type { Permission, Role } from "../auth/permissions.ts";

export type SystemChannel = "web" | "zalo_oa" | "zalo_personal";
export type Audience = "private" | "group";
export type Sensitivity = "knowledge" | "operational" | "financial";
export type ToolModule = "shopee" | "receiving" | "payables" | "knowledge";

/** The internal user a request runs as — ALWAYS loaded from public.profiles on the server. */
export interface InternalActor {
  userId: string;
  role: Role;
  active: boolean;
}

export interface ResponseConstraints {
  /** hard cap of the rendered answer */
  maxChars: number;
  /** a channel may never send by itself in Phase 05 */
  canSend: false;
}

export interface ChannelContext {
  channel: SystemChannel;
  audience: Audience;
  /** opaque thread reference for logs (never shown, never sent to the model) */
  conversationRef: string | null;
  constraints: ResponseConstraints;
}

export type IdentityResolution =
  | { status: "resolved"; actor: InternalActor }
  /** no verified link between this channel identity and an internal user */
  | { status: "unlinked" }
  /** linked, but the profile is disabled / missing */
  | { status: "inactive"; userId: string };

// ------------------------------------------------------------------ tools

export type ToolOutcome = "ok" | "empty" | "denied" | "invalid_args" | "not_found" | "ambiguous" | "unavailable" | "timeout" | "error";

export type Freshness = "fresh" | "stale" | "manual_entry" | "unknown";

export interface SourceInfo {
  /** e.g. "Công nợ NCC" */
  label: string;
  /** the SQL view / RPC / table the figures come from (shown to the user) */
  origin: string;
  /** screen where the same data can be checked */
  href: string | null;
  /** when the tool read the database */
  readAt: string;
  /** when the underlying data last changed / synced (null = unknown) */
  dataUpdatedAt: string | null;
  freshness: Freshness;
  /** the period / filter the figures cover, in words */
  coverage: string;
}

export interface SourceRef extends SourceInfo {
  /** citation label inside one answer: T1, T2 … */
  id: string;
  tool: string;
}

export interface ToolResult {
  outcome: ToolOutcome;
  /** compact JSON handed to the model (aggregates and labelled values only) */
  data: Record<string, unknown> | null;
  /** deterministic Vietnamese lines: the answer when no model may / can write one */
  lines: string[];
  source: SourceInfo | null;
  rowCount: number;
  caveats: string[];
  /** resolved scope for the audit log (period, ids, flags) — never figures */
  scope: Record<string, unknown>;
  /** user-safe explanation for a non-ok outcome */
  message?: string;
}

export interface ToolFlags {
  /** SHOPEE_ADS_DATA_SOURCE=real — only then are the Ads tables real data */
  adsRealData: boolean;
}

export interface ToolContext {
  db: SupabaseClient;
  actor: InternalActor;
  now: Date;
  maxRows: number;
  flags: ToolFlags;
  signal: AbortSignal;
}

export interface SystemToolDefinition<A = unknown> {
  /** snake_case, the only identifier the model may use */
  name: string;
  /** short Vietnamese title for the UI / sources */
  title: string;
  /** what the tool answers (shown to the model) */
  description: string;
  module: ToolModule;
  sensitivity: Sensitivity;
  /** ALL required (plus ai_system:use). Re-checked at execution time. */
  requiredPermissions: readonly Permission[];
  /** strict Zod schema: unknown keys are rejected */
  input: ZodType<A>;
  timeoutMs: number;
  /** max rows a call may return */
  maxRows: number;
  /** how fresh the data is, in words (shown to the model + docs) */
  freshness: string;
  /** example questions (prompt + docs) */
  examples: readonly string[];
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

// ------------------------------------------------------------------ answers

export type AnswerStatus = "answered" | "insufficient" | "denied" | "unsupported" | "clarify" | "refused" | "error" | "rate_limited";

export interface AnswerPoint {
  text: string;
  sourceIds: string[];
}

export interface ToolUseView {
  name: string;
  title: string;
  outcome: ToolOutcome;
}

export interface AssistantResponse {
  requestId: string | null;
  status: AnswerStatus;
  /** plain text (no markup) */
  answer: string;
  points: AnswerPoint[];
  sources: SourceRef[];
  caveats: string[];
  tools: ToolUseView[];
  meta: {
    planner: "gemini" | "rules" | "none";
    synthesis: "gemini" | "formatter" | "none";
    model: string | null;
    generatedAt: string;
    /** why the model was not used for the wording (policy, budget, invalid output …) */
    notice: string | null;
  };
}
