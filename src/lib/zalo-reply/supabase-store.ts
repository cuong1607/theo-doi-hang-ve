// ============================================================
// PHASE 04.5 — Supabase implementation of the reply stores (service role,
// server only). Every state change goes through the 00079 RPCs; plain table
// reads only for views. Errors carry an operation + DB code, never data.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import type { DraftStatus, ReviewAction, WorkerOutcome } from "./lifecycle.ts";
import type { DraftCitation } from "./policy.ts";
import { DEFAULT_SETTINGS, type AuditEntry, type BlockRow, type ControlRow, type ConversationOption, type DraftFilter, type DraftRow, type EngineStore, type InboundClaim, type InboundContext, type InboundDecision, type InboundRow, type OutboundJob, type OutboundStore, type ReplySettings, type ReviewStore, type ScanClaim, type ScannedRow, type StoreResultInput } from "./store.ts";

export class ReplyStoreError extends Error {
  readonly category: string;
  constructor(op: string, code: string | undefined) {
    super(`zalo-reply store: ${op} failed (${code ?? "unknown"})`);
    this.name = "ReplyStoreError";
    this.category = `store_${op}_${code ?? "unknown"}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);
  }
}

function check<T>(op: string, res: { data: T | null; error: { code?: string } | null }): T {
  if (res.error) throw new ReplyStoreError(op, res.error.code);
  return res.data as T;
}

type Raw = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function settingsOf(r: Raw | null | undefined): ReplySettings {
  if (!r) return { ...DEFAULT_SETTINGS };
  return {
    replyMode: (s(r.reply_mode) ?? "draft_only") as ReplySettings["replyMode"],
    directEnabled: r.direct_enabled !== false,
    unlinkedHelp: r.unlinked_help === true,
    cooldownSeconds: n(r.cooldown_seconds),
    perUserPerHour: n(r.per_user_per_hour),
    perGroupPerHour: n(r.per_group_per_hour),
    dailySendLimit: n(r.daily_send_limit),
    maxPerConversationPerDay: n(r.max_per_conversation_per_day),
    draftTtlMinutes: n(r.draft_ttl_minutes),
    sendPaused: r.send_paused === true,
    pausedReason: s(r.paused_reason),
    pausedAt: s(r.paused_at),
  };
}

const DRAFT_COLS =
  "id, connection_id, conversation_id, conversation_type, source_message_id, asker_external_id, asker_user_id, audience, kind, pipeline, required_permissions, status, approval, approved_by, approved_at, original_text, text, edited, version, citations, caveats, response_status, model, expires_at, attempts, sending_started_at, sent_at, zalo_msg_id, error_category, hold_reason, created_at, updated_at";

export class SupabaseReplyStore implements EngineStore, ReviewStore, OutboundStore {
  private readonly db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  // ------------------------------------------------------------ engine
  async recover() {
    const r = check<Raw>("recover", await this.db.rpc("zp_reply_recover"));
    return { expired: n(r.expired), unknown: n(r.unknown) };
  }

  async scanClaim(worker: string, leaseSeconds: number, backfillMinutes: number, limit: number): Promise<ScanClaim[]> {
    const rows = check<Raw[]>("scanClaim", await this.db.rpc("zp_reply_scan_claim", { p_worker: worker, p_lease_seconds: leaseSeconds, p_backfill_minutes: backfillMinutes, p_limit: limit }));
    return (rows ?? []).map((r) => ({ connectionId: String(r.connection_id), zaloAccountId: s(r.zalo_account_id), cursorAt: String(r.cursor_at), cursorId: String(r.cursor_id) }));
  }

  async settings(connectionId: string): Promise<ReplySettings> {
    const r = check<Raw | null>("settings", await this.db.from("zalo_personal_reply_settings").select("*").eq("connection_id", connectionId).maybeSingle());
    return settingsOf(r);
  }

  async scanMessages(connectionId: string, afterAt: string, afterId: string, until: Date, limit: number): Promise<ScannedRow[]> {
    const rows = check<Raw[]>("scanMessages", await this.db.rpc("zp_reply_scan_messages", { p_connection_id: connectionId, p_after_at: afterAt, p_after_id: afterId, p_until: until.toISOString(), p_limit: limit }));
    return (rows ?? []).map((r) => ({
      id: String(r.id),
      conversationId: String(r.conversation_id),
      conversationType: r.conversation_type === "group" ? "group" : "user",
      groupMode: (s(r.group_mode) as ScannedRow["groupMode"]) ?? null,
      groupConsent: (s(r.group_consent) as ScannedRow["groupConsent"]) ?? null,
      messageType: String(r.message_type),
      contentStored: r.content_stored === true,
      text: s(r.text_content),
      mentions: r.mentions,
      isSelf: r.is_self === true,
      senderExternalId: String(r.sender_external_id),
      ingestedAt: String(r.ingested_at),
    }));
  }

  async scanCommit(connectionId: string, worker: string, cursor: { at: string; id: string } | null, scanned: number, inbound: InboundDecision[], release: boolean) {
    const r = check<Raw>(
      "scanCommit",
      await this.db.rpc("zp_reply_scan_commit", { p_connection_id: connectionId, p_worker: worker, p_cursor_at: cursor?.at ?? null, p_cursor_id: cursor?.id ?? null, p_scanned: scanned, p_inbound: inbound, p_release: release }),
    );
    return r.ok === true ? { ok: true as const, queued: n(r.queued), skipped: n(r.skipped) } : { ok: false as const, error: String(r.error ?? "unknown") };
  }

  async scanRelease(connectionId: string, worker: string) {
    check("scanRelease", await this.db.rpc("zp_reply_scan_release", { p_connection_id: connectionId, p_worker: worker }));
  }

  async claimInbound(worker: string, leaseSeconds: number, limit: number): Promise<InboundClaim[]> {
    const rows = check<Raw[]>("claimInbound", await this.db.rpc("zp_reply_claim_inbound", { p_worker: worker, p_lease_seconds: leaseSeconds, p_limit: limit }));
    return (rows ?? []).map((r) => ({ id: String(r.id), connectionId: String(r.connection_id), conversationId: String(r.conversation_id), messageId: String(r.message_id), trigger: r.trigger as InboundClaim["trigger"], senderExternalId: String(r.sender_external_id), attempts: n(r.attempts) }));
  }

  async inboundContext(inboundId: string): Promise<InboundContext | null> {
    const r = check<Raw | null>("inboundContext", await this.db.rpc("zp_reply_inbound_context", { p_inbound_id: inboundId }));
    if (!r) return null;
    return {
      inboundId: String(r.inboundId),
      connectionId: String(r.connectionId),
      conversationId: String(r.conversationId),
      messageId: String(r.messageId),
      trigger: r.trigger as InboundContext["trigger"],
      senderExternalId: String(r.senderExternalId),
      conversationType: r.conversationType === "group" ? "group" : "user",
      externalConversationId: String(r.externalConversationId),
      groupMode: (s(r.groupMode) as InboundContext["groupMode"]) ?? null,
      groupConsent: (s(r.groupConsent) as InboundContext["groupConsent"]) ?? null,
      groupSendVerified: r.groupSendVerified === true,
      text: s(r.text),
      mentions: r.mentions,
      messageAt: String(r.messageAt),
      connectionStatus: r.connectionStatus === "active" ? "active" : "disabled",
      zaloAccountId: s(r.zaloAccountId),
      ownerUserId: String(r.ownerUserId),
      settings: settingsOf(r.settings as Raw | null),
      allowlisted: r.allowlisted === true,
      directVerified: r.directVerified === true,
      blocked: r.blocked === true,
      emergencyStop: r.emergencyStop === true,
    };
  }

  async storeResult(inboundId: string, worker: string, result: StoreResultInput) {
    const r = check<Raw>("storeResult", await this.db.rpc("zp_reply_store_result", { p_inbound_id: inboundId, p_worker: worker, p_result: result }));
    return r.ok === true ? { ok: true as const, draftId: s(r.draftId), status: (s(r.status) as DraftStatus | null) ?? null } : { ok: false as const, error: String(r.error ?? "unknown") };
  }

  // ------------------------------------------------------------ outbound
  async claim(workerId: string, accountId: string, leaseSeconds: number, globalDailyCap: number, autoEnabled: boolean) {
    const r = check<Raw>("claim", await this.db.rpc("zp_reply_claim_outbound", { p_worker_id: workerId, p_account_id: accountId, p_lease_seconds: leaseSeconds, p_global_daily_cap: globalDailyCap, p_auto_enabled: autoEnabled }));
    if (r.ok !== true) return { ok: false as const, error: String(r.error ?? "unknown") };
    const j = r.job as Raw | null;
    const job: OutboundJob | null = j
      ? { draftId: String(j.draftId), claimToken: String(j.claimToken), threadId: String(j.threadId), threadType: j.threadType === "group" ? "group" : "user", text: String(j.text), leaseUntil: String(j.leaseUntil) }
      : null;
    return { ok: true as const, job, reason: s(r.reason) };
  }

  async report(workerId: string, draftId: string, claimToken: string, outcome: WorkerOutcome, zaloMsgId: string | null, error: string | null) {
    const r = check<Raw>("report", await this.db.rpc("zp_reply_report", { p_worker_id: workerId, p_draft_id: draftId, p_claim_token: claimToken, p_outcome: outcome, p_zalo_msg_id: zaloMsgId, p_error: error }));
    return r.ok === true ? { ok: true as const, status: String(r.status), changed: r.changed === true } : { ok: false as const, error: String(r.error ?? "unknown") };
  }

  // ------------------------------------------------------------ review
  private async hydrate(rows: Raw[]): Promise<DraftRow[]> {
    if (!rows.length) return [];
    const convIds = [...new Set(rows.map((r) => String(r.conversation_id)))];
    const msgIds = [...new Set(rows.map((r) => String(r.source_message_id)))];
    const userIds = [...new Set(rows.flatMap((r) => [s(r.asker_user_id), s(r.approved_by)]).filter((v): v is string => !!v))];
    const [convs, msgs, users] = await Promise.all([
      this.db.from("zalo_personal_conversations").select("id, external_conversation_id, grp:zalo_personal_groups(display_name)").in("id", convIds),
      this.db.from("zalo_personal_messages").select("id, text_content, content_stored, sent_at, received_at").in("id", msgIds),
      userIds.length ? this.db.from("profiles").select("id, full_name").in("id", userIds) : Promise.resolve({ data: [], error: null }),
    ]);
    const conv = new Map(check<Raw[]>("drafts_conv", convs).map((c) => [String(c.id), c]));
    const msg = new Map(check<Raw[]>("drafts_msg", msgs).map((m) => [String(m.id), m]));
    const user = new Map(check<Raw[]>("drafts_user", users as { data: Raw[] | null; error: { code?: string } | null }).map((u) => [String(u.id), s(u.full_name)]));
    return rows.map((r) => {
      const c = conv.get(String(r.conversation_id));
      const m = msg.get(String(r.source_message_id));
      const g = c?.grp as Raw | Raw[] | null | undefined;
      const groupName = Array.isArray(g) ? s(g[0]?.display_name) : s(g?.display_name);
      return {
        id: String(r.id),
        connectionId: String(r.connection_id),
        conversationId: String(r.conversation_id),
        conversationType: r.conversation_type === "group" ? "group" : "user",
        externalConversationId: s(c?.external_conversation_id) ?? "0",
        groupName,
        sourceMessageId: String(r.source_message_id),
        sourceText: m && m.content_stored === true ? s(m.text_content) : null,
        sourceAt: m ? s(m.sent_at) ?? s(m.received_at) : null,
        askerExternalId: String(r.asker_external_id),
        askerUserId: s(r.asker_user_id),
        askerName: s(r.asker_user_id) ? user.get(String(r.asker_user_id)) ?? null : null,
        audience: r.audience === "group" ? "group" : "private",
        kind: r.kind as DraftRow["kind"],
        pipeline: r.pipeline as DraftRow["pipeline"],
        requiredPermissions: arr<string>(r.required_permissions),
        status: r.status as DraftStatus,
        approval: (s(r.approval) as DraftRow["approval"]) ?? null,
        approvedByName: s(r.approved_by) ? user.get(String(r.approved_by)) ?? null : null,
        approvedAt: s(r.approved_at),
        originalText: String(r.original_text),
        text: String(r.text),
        edited: r.edited === true,
        version: n(r.version),
        citations: arr<DraftCitation>(r.citations),
        caveats: arr<string>(r.caveats),
        responseStatus: s(r.response_status),
        model: s(r.model),
        expiresAt: String(r.expires_at),
        attempts: n(r.attempts),
        sendingStartedAt: s(r.sending_started_at),
        sentAt: s(r.sent_at),
        zaloMsgId: s(r.zalo_msg_id),
        errorCategory: s(r.error_category),
        holdReason: s(r.hold_reason),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
      };
    });
  }

  async drafts(f: DraftFilter): Promise<DraftRow[]> {
    let q = this.db.from("zalo_personal_reply_drafts").select(DRAFT_COLS).in("connection_id", f.connectionIds);
    if (f.statuses?.length) q = q.in("status", f.statuses);
    // 1-1 drafts only for connections the reader owns
    q = f.directConnectionIds.length ? q.or(`conversation_type.eq.group,connection_id.in.(${f.directConnectionIds.join(",")})`) : q.eq("conversation_type", "group");
    const rows = check<Raw[]>("drafts", await q.order("created_at", { ascending: false }).limit(Math.min(Math.max(f.limit, 1), 200)));
    return this.hydrate(rows ?? []);
  }

  async draft(id: string): Promise<DraftRow | null> {
    const r = check<Raw | null>("draft", await this.db.from("zalo_personal_reply_drafts").select(DRAFT_COLS).eq("id", id).maybeSingle());
    return r ? (await this.hydrate([r]))[0]! : null;
  }

  async audit(draftId: string): Promise<AuditEntry[]> {
    const rows = check<Raw[]>("audit", await this.db.from("zalo_personal_reply_audit").select("id, action, actor_kind, actor_user_id, from_status, to_status, details, created_at, actor:profiles(full_name)").eq("draft_id", draftId).order("id").limit(200));
    return (rows ?? []).map((a) => ({
      id: n(a.id),
      action: String(a.action),
      actorKind: a.actor_kind as AuditEntry["actorKind"],
      actorName: s((a.actor as Raw | null)?.full_name),
      fromStatus: s(a.from_status),
      toStatus: s(a.to_status),
      details: (a.details as Record<string, unknown>) ?? {},
      createdAt: String(a.created_at),
    }));
  }

  async act(actorId: string, draftId: string, action: ReviewAction, version: number, text: string | null, note: string | null) {
    const r = check<Raw>("act", await this.db.rpc("zp_reply_act", { p_actor: actorId, p_draft_id: draftId, p_action: action, p_version: version, p_text: text, p_note: note }));
    return r.ok === true ? { ok: true as const, status: r.status as DraftStatus, version: n(r.version) } : { ok: false as const, error: String(r.error ?? "unknown"), status: s(r.status) ?? undefined };
  }

  async statusCounts(connectionIds: string[], directConnectionIds: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const statuses: DraftStatus[] = ["pending_approval", "queued", "sending", "delivery_unknown", "failed"];
    await Promise.all(
      statuses.map(async (st) => {
        let q = this.db.from("zalo_personal_reply_drafts").select("id", { count: "exact", head: true }).in("connection_id", connectionIds).eq("status", st);
        q = directConnectionIds.length ? q.or(`conversation_type.eq.group,connection_id.in.(${directConnectionIds.join(",")})`) : q.eq("conversation_type", "group");
        const r = await q;
        if (r.error) throw new ReplyStoreError("statusCounts", r.error.code);
        out[st] = r.count ?? 0;
      }),
    );
    return out;
  }

  async inbound(connectionIds: string[], directConnectionIds: string[], limit: number): Promise<InboundRow[]> {
    const rows = check<Raw[]>(
      "inbound",
      await this.db.from("zalo_personal_reply_inbound").select("id, connection_id, conversation_id, trigger, status, reason, created_at, conv:zalo_personal_conversations(conversation_type)").in("connection_id", connectionIds).order("created_at", { ascending: false }).limit(limit * 2),
    );
    return (rows ?? [])
      .map((r) => {
        const c = r.conv as Raw | Raw[] | null;
        const type = (Array.isArray(c) ? s(c[0]?.conversation_type) : s(c?.conversation_type)) === "group" ? "group" : "user";
        return { id: String(r.id), connectionId: String(r.connection_id), conversationId: String(r.conversation_id), conversationType: type, trigger: r.trigger as InboundRow["trigger"], status: r.status as InboundRow["status"], reason: s(r.reason), createdAt: String(r.created_at) } as InboundRow;
      })
      .filter((r) => r.conversationType === "group" || directConnectionIds.includes(r.connectionId))
      .slice(0, limit);
  }

  async settingsFor(connectionIds: string[]): Promise<Map<string, ReplySettings>> {
    const out = new Map<string, ReplySettings>();
    if (!connectionIds.length) return out;
    const rows = check<Raw[]>("settingsFor", await this.db.from("zalo_personal_reply_settings").select("*").in("connection_id", connectionIds));
    for (const r of rows ?? []) out.set(String(r.connection_id), settingsOf(r));
    for (const id of connectionIds) if (!out.has(id)) out.set(id, { ...DEFAULT_SETTINGS });
    return out;
  }

  async conversations(connectionIds: string[]): Promise<ConversationOption[]> {
    const [convs, allow] = await Promise.all([
      this.db.from("zalo_personal_conversations").select("id, connection_id, conversation_type, external_conversation_id, last_message_at, grp:zalo_personal_groups(display_name, mode, send_verified_at)").in("connection_id", connectionIds).order("last_message_at", { ascending: false, nullsFirst: false }).limit(200),
      this.db.from("zalo_personal_reply_allowlist").select("conversation_id, note").in("connection_id", connectionIds),
    ]);
    const allowed = new Map(check<Raw[]>("allowlist", allow).map((a) => [String(a.conversation_id), s(a.note)]));
    return check<Raw[]>("conversations", convs).map((c) => {
      const g = (Array.isArray(c.grp) ? c.grp[0] : c.grp) as Raw | null | undefined;
      return {
        id: String(c.id),
        connectionId: String(c.connection_id),
        conversationType: c.conversation_type === "group" ? "group" : "user",
        externalConversationId: String(c.external_conversation_id),
        groupName: s(g?.display_name),
        groupMode: (s(g?.mode) as ConversationOption["groupMode"]) ?? null,
        groupSendVerified: !!s(g?.send_verified_at),
        allowlisted: allowed.has(String(c.id)),
        allowNote: allowed.get(String(c.id)) ?? null,
      };
    });
  }

  async blocks(connectionIds: string[]): Promise<BlockRow[]> {
    const rows = check<Raw[]>("blocks", await this.db.from("zalo_personal_reply_blocks").select("connection_id, external_user_id, note, created_at").in("connection_id", connectionIds).order("created_at", { ascending: false }).limit(200));
    return (rows ?? []).map((b) => ({ connectionId: String(b.connection_id), externalUserId: String(b.external_user_id), note: s(b.note), createdAt: String(b.created_at) }));
  }

  async control(): Promise<ControlRow> {
    const r = check<Raw | null>("control", await this.db.from("zalo_personal_reply_control").select("emergency_stop, changed_at, reason, by:profiles(full_name)").eq("id", 1).maybeSingle());
    return { emergencyStop: r?.emergency_stop === true, changedAt: s(r?.changed_at), changedByName: s((r?.by as Raw | null)?.full_name), reason: s(r?.reason) };
  }

  async admin(actorId: string, action: string, connectionId: string | null, payload: Record<string, unknown>) {
    const r = check<Raw>("admin", await this.db.rpc("zp_reply_admin", { p_actor: actorId, p_action: action, p_connection_id: connectionId, p_payload: payload }));
    return r.ok === true ? { ok: true as const } : { ok: false as const, error: String(r.error ?? "unknown") };
  }

  async sentToday(connectionIds: string[], since: Date): Promise<number> {
    if (!connectionIds.length) return 0;
    const r = await this.db.from("zalo_personal_reply_drafts").select("id", { count: "exact", head: true }).in("connection_id", connectionIds).eq("status", "sent").gte("sent_at", since.toISOString());
    if (r.error) throw new ReplyStoreError("sentToday", r.error.code);
    return r.count ?? 0;
  }
}
