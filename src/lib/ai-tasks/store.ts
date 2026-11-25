// ============================================================
// PHASE 06 — persistence contract (implemented by supabase-store.ts; faked in
// unit tests). Every write that matters is ONE SQL function (00078) so it is
// atomic and lease-checked in the database, not in this process.
// ============================================================
import type { ConnectionRef, GrantRef } from "../zalo-personal/dashboard/access.ts";
import type { ReserveResult } from "../zalo-personal/ai/service.ts";
import type { AiLimits } from "../ai-assistant/config.ts";
import type { ExternalChannel, DeliveryRecord } from "./channels.ts";
import type { ScannedMessage } from "./detect.ts";
import type { InboxNotification } from "./messages.ts";
import type { TaskStatus } from "./lifecycle.ts";
import type { ClaimedOccurrence, ReminderPrefs } from "./reminders.ts";

export interface ScanConnection {
  connectionId: string;
  ownerUserId: string;
  accountId: string;
  directMessageMode: "off" | "metadata" | "content";
  cursorAt: string;
  cursorId: string;
}

export interface ScanCommit {
  connectionId: string;
  worker: string;
  cursorAt: string;
  cursorId: string;
  scanned: number;
  mentions: Array<{ messageId: string; externalId: string; kind: "direct" | "all"; target: "self" | "linked" | "unlinked"; internalUserId: string | null }>;
  candidates: Array<{ messageId: string; score: number; reasons: string[] }>;
  notifications: InboxNotification[];
  dayStart: Date;
  maxCandidatesPerDay: number;
  release: boolean;
}

export interface ClaimedCandidate {
  id: string;
  connectionId: string;
  conversationId: string;
  messageId: string;
  messageAt: Date;
  score: number;
  attempts: number;
  ownerUserId: string;
  accountId: string | null;
  connectionStatus: "active" | "disabled";
  directMessageMode: "off" | "metadata" | "content";
  conversationType: "user" | "group";
  groupName: string | null;
  groupMode: string | null;
  consentStatus: string | null;
}

export interface ContextRow {
  id: string;
  senderExternalId: string;
  isSelf: boolean;
  text: string;
  mentions: unknown;
  messageAt: Date;
  isCandidate: boolean;
}

export interface StoredTaskPayload {
  dedupeKey: string;
  candidateId: string;
  conversationId: string;
  title: string;
  description: string | null;
  assignorExternalId: string | null;
  deadlineAt: string | null;
  deadlinePrecision: "exact" | "day_part" | "date" | "range" | "none";
  deadlinePhrase: string | null;
  deadlineAssumed: boolean;
  priority: string | null;
  confidence: number;
  missing: string[];
  evidence: Array<{ messageId: string; quote: string }>;
  extractor: "gemini" | "rules";
  sourceMessageAt: string;
  sources: Array<{ messageId: string; role: "primary" | "context" }>;
  assignees: Array<{ externalId: string; source: "mention" | "ai" }>;
  notify: Array<{ userId: string; title: string; body: string }>;
}

export interface CandidateResult {
  id: string;
  status: "pending" | "task_created" | "no_task" | "needs_clarification" | "skipped" | "failed";
  reason: string | null;
  extractor: "gemini" | "rules" | null;
  usageId: string | null;
  retryAt: string | null;
}

export interface ProposalPayload {
  taskId: string;
  conversationId: string;
  deadlineAt: string;
  phrase: string;
  messageId: string;
  notify: Array<{ userId: string; title: string; body: string }>;
}

export interface OpenTaskRow {
  id: string;
  connectionId: string;
  conversationId: string;
  conversationType: "user" | "group";
  title: string;
  status: TaskStatus;
  deadlineAt: Date | null;
}

export interface ProfileInfo {
  id: string;
  role: string;
  isActive: boolean;
  name: string | null;
}

export interface ConversationInfo {
  id: string;
  connectionId: string;
  conversationType: "user" | "group";
  groupName: string | null;
}

export interface ResolveItem {
  id: string;
  status: "sent" | "sent_late" | "skipped_expired" | "skipped" | "cancelled" | "failed";
  reason: string | null;
}

/** Shared by the engine and the dashboard service. */
export interface AccessStore {
  loadAccess(userId: string): Promise<{ connections: ConnectionRef[]; grants: GrantRef[] }>;
  profiles(ids: string[]): Promise<ProfileInfo[]>;
  conversationInfo(id: string): Promise<ConversationInfo | null>;
  /** owner + users holding a connection-wide MANAGE grant (active grants only) */
  connectionManagers(connectionId: string): Promise<string[]>;
  prefs(userIds: string[]): Promise<Map<string, ReminderPrefs>>;
}

export interface TaskEngineStore extends AccessStore {
  startRun(workerId: string): Promise<number>;
  finishRun(id: number, status: "ok" | "partial" | "error", stats: Record<string, number>, errorCategory: string | null): Promise<void>;
  pruneRuns(before: Date): Promise<void>;

  claimScan(worker: string, leaseSeconds: number, backfillMinutes: number, limit: number): Promise<ScanConnection[]>;
  scanMessages(connectionId: string, after: { at: string; id: string }, until: Date, limit: number): Promise<ScannedMessage[]>;
  identities(connectionId: string): Promise<Map<string, string>>;
  commitScan(c: ScanCommit): Promise<{ ok: true; mentions: number; candidates: number; capped: number; notifications: number } | { ok: false; error: string }>;
  releaseScan(connectionId: string, worker: string): Promise<void>;

  claimCandidates(worker: string, limit: number, leaseSeconds: number): Promise<ClaimedCandidate[]>;
  context(conversationId: string, messageIds: string[], before: number): Promise<ContextRow[]>;
  openTasksOfConversation(conversationId: string): Promise<Array<{ id: string; title: string; deadlineAt: Date | null }>>;
  extractionsSince(since: Date): Promise<number>;
  reserve(userId: string, provider: string, model: string, estimated: number, dayStart: Date, limits: AiLimits): Promise<ReserveResult>;
  finishUsage(id: string, r: { status: "completed" | "failed"; reason: string | null; inputTokens: number; outputTokens: number; confirmed: boolean; attempts: number; redactions: number; durationMs: number }): Promise<void>;
  storeExtraction(worker: string, candidates: CandidateResult[], tasks: StoredTaskPayload[], proposals: ProposalPayload[]): Promise<{ ok: true; created: Array<{ dedupeKey: string; id: string }>; duplicates: number; invalid: number; proposals: number }>;

  markOverdue(graceSeconds: number): Promise<number>;
  ensureMorning(localDate: string, scheduledFor: Date): Promise<number>;
  claimReminders(worker: string, limit: number, leaseSeconds: number): Promise<ClaimedOccurrence[]>;
  resolveReminders(worker: string, items: ResolveItem[], notification: InboxNotification | null): Promise<{ ok: true; notificationId: string | null; created: boolean; items: ResolveItem[]; lost: number }>;
  retryReminder(id: string, worker: string, error: string, delaySeconds: number): Promise<"retry" | "failed" | "lease_lost">;
  openTasksForUser(userId: string): Promise<OpenTaskRow[]>;

  externalRecipient(userId: string, channel: ExternalChannel, connectionId: string | null): Promise<string | null>;
  externalSentLastHour(userId: string, channel: ExternalChannel): Promise<number>;
  recordDelivery(notificationId: string, channel: ExternalChannel, record: DeliveryRecord): Promise<void>;
}
