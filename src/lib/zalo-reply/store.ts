// ============================================================
// PHASE 04.5 — persistence interfaces (implemented by supabase-store.ts,
// faked in tests). Pure types.
// ============================================================
import type { DraftStatus, ReviewAction, WorkerOutcome } from "./lifecycle.ts";
import type { DraftCitation, DraftPayload } from "./policy.ts";
import type { GroupMode, ScannedMessage, Trigger } from "./router.ts";

/**
 * PHASE 07 reply modes (00081):
 *   disabled              nothing is analysed or answered
 *   draft_only            drafts for review — NEVER sent (approve refused)
 *   manual_approval       a person approves each reply, then the worker sends it
 *   auto_reply_allowlist  auto-send inside the auto scopes below; the rest still needs approval
 */
export const REPLY_MODES = ["disabled", "draft_only", "manual_approval", "auto_reply_allowlist"] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];
/** 1-1 auto scope: nobody | allowlisted chats only | every linked person */
export const AUTO_DIRECT_SCOPES = ["off", "allowlist", "all_linked"] as const;
export type AutoDirectScope = (typeof AUTO_DIRECT_SCOPES)[number];
/** 1-1 text kept by the server: none | metadata | LINKED people only (recommended) | everybody */
export const DIRECT_MESSAGE_MODES = ["off", "metadata", "linked", "content"] as const;
export type DirectMessageMode = (typeof DIRECT_MESSAGE_MODES)[number];

export interface ReplySettings {
  replyMode: ReplyMode;
  /** per-connection outbound switch (default OFF) */
  sendEnabled: boolean;
  autoDirect: AutoDirectScope;
  autoGroups: boolean;
  directEnabled: boolean;
  unlinkedHelp: boolean;
  cooldownSeconds: number;
  perUserPerHour: number;
  perGroupPerHour: number;
  dailySendLimit: number;
  maxPerConversationPerDay: number;
  draftTtlMinutes: number;
  sendPaused: boolean;
  pausedReason: string | null;
  pausedAt: string | null;
}

export const DEFAULT_SETTINGS: ReplySettings = {
  replyMode: "draft_only",
  sendEnabled: false,
  autoDirect: "off",
  autoGroups: false,
  directEnabled: true,
  unlinkedHelp: false,
  cooldownSeconds: 60,
  perUserPerHour: 10,
  perGroupPerHour: 20,
  dailySendLimit: 50,
  maxPerConversationPerDay: 20,
  draftTtlMinutes: 60,
  sendPaused: false,
  pausedReason: null,
  pausedAt: null,
};

export interface ScanClaim {
  connectionId: string;
  zaloAccountId: string | null;
  cursorAt: string;
  cursorId: string;
}

export interface ScannedRow extends ScannedMessage {
  ingestedAt: string;
}

export interface InboundDecision {
  messageId: string;
  trigger: Trigger;
  decision: "process" | "skip";
  reason: string | null;
}

export interface InboundClaim {
  id: string;
  connectionId: string;
  conversationId: string;
  messageId: string;
  trigger: Trigger;
  senderExternalId: string;
  attempts: number;
}

export interface InboundContext {
  inboundId: string;
  connectionId: string;
  conversationId: string;
  messageId: string;
  trigger: Trigger;
  senderExternalId: string;
  conversationType: "user" | "group";
  externalConversationId: string;
  groupMode: GroupMode | null;
  groupConsent: "none" | "granted" | "withdrawn" | null;
  groupSendVerified: boolean;
  text: string | null;
  mentions: unknown;
  messageAt: string;
  connectionStatus: "active" | "disabled";
  zaloAccountId: string | null;
  ownerUserId: string;
  settings: ReplySettings;
  allowlisted: boolean;
  directVerified: boolean;
  blocked: boolean;
  emergencyStop: boolean;
}

export type StoreResultInput = { skip: string; fail?: boolean } | { draft: DraftPayload };

export interface EngineStore {
  recover(): Promise<{ expired: number; unknown: number }>;
  scanClaim(worker: string, leaseSeconds: number, backfillMinutes: number, limit: number): Promise<ScanClaim[]>;
  settings(connectionId: string): Promise<ReplySettings>;
  scanMessages(connectionId: string, afterAt: string, afterId: string, until: Date, limit: number): Promise<ScannedRow[]>;
  scanCommit(connectionId: string, worker: string, cursor: { at: string; id: string } | null, scanned: number, inbound: InboundDecision[], release: boolean): Promise<{ ok: true; queued: number; skipped: number } | { ok: false; error: string }>;
  scanRelease(connectionId: string, worker: string): Promise<void>;
  claimInbound(worker: string, leaseSeconds: number, limit: number): Promise<InboundClaim[]>;
  inboundContext(inboundId: string): Promise<InboundContext | null>;
  storeResult(inboundId: string, worker: string, result: StoreResultInput): Promise<{ ok: true; draftId: string | null; status: DraftStatus | null } | { ok: false; error: string }>;
}

// ------------------------------------------------------------------ dashboard

export interface DraftRow {
  id: string;
  connectionId: string;
  conversationId: string;
  conversationType: "user" | "group";
  externalConversationId: string;
  groupName: string | null;
  /** null for a reminder (no inbound message) */
  sourceMessageId: string | null;
  sourceText: string | null;
  sourceAt: string | null;
  askerExternalId: string;
  askerUserId: string | null;
  askerName: string | null;
  audience: "private" | "group";
  kind: DraftPayload["kind"];
  pipeline: DraftPayload["pipeline"];
  requiredPermissions: string[];
  status: DraftStatus;
  approval: "manual" | "auto" | null;
  approvedByName: string | null;
  approvedAt: string | null;
  originalText: string;
  text: string;
  edited: boolean;
  version: number;
  citations: DraftCitation[];
  caveats: string[];
  responseStatus: string | null;
  model: string | null;
  expiresAt: string;
  attempts: number;
  sendingStartedAt: string | null;
  sentAt: string | null;
  zaloMsgId: string | null;
  errorCategory: string | null;
  holdReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  actorKind: "user" | "system" | "worker";
  actorName: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface InboundRow {
  id: string;
  connectionId: string;
  conversationId: string;
  conversationType: "user" | "group";
  trigger: Trigger;
  status: "queued" | "processing" | "done" | "skipped" | "failed";
  reason: string | null;
  createdAt: string;
}

export interface ConversationOption {
  id: string;
  connectionId: string;
  conversationType: "user" | "group";
  externalConversationId: string;
  groupName: string | null;
  groupMode: GroupMode | null;
  groupSendVerified: boolean;
  allowlisted: boolean;
  allowNote: string | null;
}

export interface BlockRow {
  connectionId: string;
  externalUserId: string;
  note: string | null;
  createdAt: string;
}

export interface ControlRow {
  emergencyStop: boolean;
  changedAt: string | null;
  changedByName: string | null;
  reason: string | null;
}

export interface DraftFilter {
  connectionIds: string[];
  /** connections where the reader may also see 1-1 drafts (owner) */
  directConnectionIds: string[];
  statuses?: DraftStatus[];
  limit: number;
}

export interface ReviewStore {
  drafts(f: DraftFilter): Promise<DraftRow[]>;
  draft(id: string): Promise<DraftRow | null>;
  audit(draftId: string): Promise<AuditEntry[]>;
  act(actorId: string, draftId: string, action: ReviewAction, version: number, text: string | null, note: string | null): Promise<{ ok: true; status: DraftStatus; version: number } | { ok: false; error: string; status?: string }>;
  statusCounts(connectionIds: string[], directConnectionIds: string[]): Promise<Record<string, number>>;
  inbound(connectionIds: string[], directConnectionIds: string[], limit: number): Promise<InboundRow[]>;
  settingsFor(connectionIds: string[]): Promise<Map<string, ReplySettings>>;
  conversations(connectionIds: string[]): Promise<ConversationOption[]>;
  blocks(connectionIds: string[]): Promise<BlockRow[]>;
  control(): Promise<ControlRow>;
  admin(actorId: string, action: string, connectionId: string | null, payload: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }>;
  sentToday(connectionIds: string[], since: Date): Promise<number>;
}

// ------------------------------------------------------------------ worker outbound

export interface OutboundJob {
  draftId: string;
  claimToken: string;
  threadId: string;
  threadType: "user" | "group";
  text: string;
  leaseUntil: string;
}

export interface OutboundStore {
  claim(workerId: string, accountId: string, leaseSeconds: number, globalDailyCap: number, autoEnabled: boolean, remindersEnabled?: boolean): Promise<{ ok: true; job: OutboundJob | null; reason: string | null } | { ok: false; error: string }>;
  report(workerId: string, draftId: string, claimToken: string, outcome: WorkerOutcome, zaloMsgId: string | null, error: string | null): Promise<{ ok: true; status: string; changed: boolean } | { ok: false; error: string }>;
}
