// ============================================================
// PHASE 06 — the engine tick (TASK-01/02/03/07/08/09). Pure orchestration over
// an injected store, model provider and clock.
//
// One tick (POST /api/internal/ai-tasks/tick, called every minute by pg_cron →
// pg_net, see 00078): bounded by a time budget, safe to run twice at once.
//   1 scan      claim connections (lease) → next messages after the cursor →
//               mentions (metadata) + candidates (rules) + mention notifications
//               → ONE atomic commit (idempotent) moves the cursor
//   2 extract   claim candidates (SKIP LOCKED + lease), grouped per conversation
//               → policy re-checked NOW → Gemini (only if allowed: flags, data
//               policy, shared budget) or the deterministic rules → validated
//               proposals stored pending_confirmation + confirmation notices
//   3 overdue   accepted / in_progress past deadline + 5 min → 'overdue'
//   4 morning   today's (before 10:00) / tomorrow's (after 18:00) MORNING rows
//   5 remind    recover stale leases → claim due occurrences → recovery policy
//               → web inbox written in the same transaction as the outcome
// Mention detection and reminders never depend on the model.
// Stops starting new work when the budget is used or `signal` is aborted;
// whatever was claimed and not finished is released by lease expiry.
// ============================================================
import { generateWithRetry, AiProviderError, estimateTokens, type AiTextProvider } from "../ai-assistant/provider.ts";
import type { AiConfig } from "../ai-assistant/config.ts";
import { sharingDecision } from "../ai-assistant/policy.ts";
import { TaskAccess } from "./access.ts";
import { dispatchExternal, externalGate, type ExternalChannel, type NotificationChannelAdapter } from "./channels.ts";
import { TASK_EXTRACT_PROMPT_VERSION, type TaskEngineConfig } from "./config.ts";
import { detectCandidate, detectMentions, REMINDER_MARKER, type ScannedMessage } from "./detect.ts";
import { buildExtractionPrompt, EXTRACTION_JSON_SCHEMA, rulesExtraction, validateExtraction, type ExtractionInput, type ExtractionOutcome } from "./extractor.ts";
import { confirmationText, mentionNotification, morningDigest, overdueDigest, proposalText, reminderNotification, type InboxNotification } from "./messages.ts";
import { backoffMs, decideDelivery, morningSlot, type ClaimedOccurrence } from "./reminders.ts";
import type { CandidateResult, ClaimedCandidate, ProposalPayload, ResolveItem, StoredTaskPayload, TaskEngineStore } from "./store.ts";
import { DAY_MS, vnDateKey, vnParts, vnStartOfDay } from "./time.ts";

export interface EngineDeps {
  store: TaskEngineStore;
  config: TaskEngineConfig;
  aiConfig: AiConfig;
  provider: () => AiTextProvider;
  adapters: Record<ExternalChannel, NotificationChannelAdapter>;
  workerId: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface TickStats {
  [k: string]: number;
}

const GROUP_MODES = new Set(["monitor", "mention_only", "interactive"]);

/** May the task extractor call the model at all? (data policy is checked separately) */
export function extractorModelReady(c: AiConfig, cfg: TaskEngineConfig): { ready: true } | { ready: false; reason: string } {
  if (!cfg.aiExtractionEnabled) return { ready: false, reason: "extraction_ai_disabled" };
  if (!c.enabled) return { ready: false, reason: "ai_disabled" };
  if (c.provider === "fake") return { ready: true };
  if (!c.apiKeyConfigured || c.model === null) return { ready: false, reason: "config_missing" };
  if (!c.modelValid) return { ready: false, reason: "model_invalid" };
  return { ready: true };
}

export async function runTick(deps: EngineDeps): Promise<{ status: "ok" | "partial" | "error"; stats: TickStats }> {
  const clock = deps.now ?? (() => new Date());
  const started = clock();
  const until = started.getTime() + deps.config.tickBudgetMs;
  const stats: TickStats = {};
  const add = (k: string, n = 1) => (stats[k] = (stats[k] ?? 0) + n);
  const out = () => deps.signal?.aborted || clock().getTime() >= until;
  const log = deps.log ?? (() => {});
  const access = new TaskAccess(deps.store);
  let status: "ok" | "partial" | "error" = "ok";
  let category: string | null = null;
  const runId = await deps.store.startRun(deps.workerId);
  try {
    await scanPhase(deps, access, clock, out, add);
    if (!out()) await extractPhase(deps, access, clock, out, add);
    if (!out()) add("overdue_marked", await deps.store.markOverdue(Math.round(deps.config.reminders.overdueDelayMs / 1000)));
    if (!out()) await morningPhase(deps, clock, add);
    if (!out()) await reminderPhase(deps, access, clock, out, add);
    if (out()) status = "partial";
  } catch (err) {
    status = "error";
    const own = (err as { category?: unknown } | null)?.category;
    category = err instanceof AiProviderError ? err.category : typeof own === "string" && /^[a-z0-9_]{1,64}$/.test(own) ? own : "unexpected";
    log("tick_error", { category });
  } finally {
    await deps.store.finishRun(runId, status, stats, category).catch(() => {});
    await deps.store.pruneRuns(new Date(started.getTime() - 14 * DAY_MS)).catch(() => {});
  }
  log("tick", { status, ms: clock().getTime() - started.getTime(), ...stats });
  return { status, stats };
}

// ------------------------------------------------------------------ 1. scan

async function scanPhase(deps: EngineDeps, access: TaskAccess, clock: () => Date, out: () => boolean, add: (k: string, n?: number) => void) {
  const cfg = deps.config;
  const conns = await deps.store.claimScan(deps.workerId, 120, cfg.backfillMinutes, 10);
  for (const conn of conns) {
    try {
      if (out()) continue;
      const identities = await deps.store.identities(conn.connectionId);
      const ctx = { accountId: conn.accountId, ownerUserId: conn.ownerUserId, identities };
      let cursor = { at: conn.cursorAt, id: conn.cursorId };
      for (let round = 0; round < 5 && !out(); round++) {
        const now = clock();
        const rows = await deps.store.scanMessages(conn.connectionId, cursor, new Date(now.getTime() - cfg.scanSettleMs), cfg.scanBatch);
        if (!rows.length) break;
        const commit = await analyseBatch(deps, access, conn.connectionId, ctx, rows);
        const last = rows[rows.length - 1]!;
        cursor = { at: last.ingestedAt, id: last.id };
        const res = await deps.store.commitScan({
          connectionId: conn.connectionId,
          worker: deps.workerId,
          cursorAt: cursor.at,
          cursorId: cursor.id,
          scanned: rows.length,
          mentions: commit.mentions,
          candidates: commit.candidates,
          notifications: commit.notifications,
          dayStart: vnStartOfDay(now),
          maxCandidatesPerDay: cfg.maxCandidatesPerDay,
          release: false,
        });
        if (!res.ok) {
          add("scan_lease_lost");
          break;
        }
        add("scanned", rows.length);
        add("mentions", res.mentions);
        add("candidates", res.candidates);
        add("candidates_capped", res.capped);
        add("mention_notifications", res.notifications);
        if (rows.length < cfg.scanBatch) break;
      }
    } finally {
      await deps.store.releaseScan(conn.connectionId, deps.workerId).catch(() => {});
    }
  }
}

async function analyseBatch(deps: EngineDeps, access: TaskAccess, connectionId: string, ctx: Parameters<typeof detectMentions>[1], rows: ScannedMessage[]) {
  const mentions: Parameters<TaskEngineStore["commitScan"]>[0]["mentions"] = [];
  const candidates: Parameters<TaskEngineStore["commitScan"]>[0]["candidates"] = [];
  const notifications: InboxNotification[] = [];
  const recipients = new Set<string>();
  const detections = rows.map((m) => ({ m, det: detectMentions(m, ctx) }));
  for (const { m, det } of detections) {
    for (const x of det.mentions) {
      mentions.push(x);
      if (x.internalUserId) recipients.add(x.internalUserId);
    }
    const c = detectCandidate(m, det);
    if (c.candidate) candidates.push({ messageId: m.id, score: c.score, reasons: c.reasons });
  }
  const prefs = await deps.store.prefs([...recipients]);
  for (const { m, det } of detections) {
    for (const x of det.mentions) {
      if (!x.internalUserId) continue; // unlinked UID: recorded, nobody to tell
      if (m.isSelf && x.target === "self") continue; // the owner's own message
      if (!(prefs.get(x.internalUserId)?.mention_enabled ?? true)) continue;
      if (!(await access.canRead(x.internalUserId, { id: m.conversationId, connectionId, conversationType: m.conversationType }))) continue;
      notifications.push(mentionNotification({ userId: x.internalUserId, messageId: m.id, connectionId, conversationId: m.conversationId, groupName: m.groupName, messageAt: m.messageAt }));
    }
  }
  return { mentions, candidates, notifications };
}

// ------------------------------------------------------------------ 2. extract

function stillEligible(c: ClaimedCandidate): boolean {
  if (c.connectionStatus !== "active") return false;
  if (c.conversationType === "group") return Boolean(c.groupMode && GROUP_MODES.has(c.groupMode) && c.consentStatus === "granted");
  return c.directMessageMode === "content";
}

async function extractPhase(deps: EngineDeps, access: TaskAccess, clock: () => Date, out: () => boolean, add: (k: string, n?: number) => void) {
  const cfg = deps.config;
  const claimed = await deps.store.claimCandidates(deps.workerId, cfg.extractBatch * 2, 180);
  if (!claimed.length) return;
  const groups = new Map<string, ClaimedCandidate[]>();
  for (const c of claimed) groups.set(c.conversationId, [...(groups.get(c.conversationId) ?? []), c]);
  for (const group of groups.values()) {
    const now = clock();
    if (out()) {
      // give the rest back right away (not only by lease expiry)
      await deps.store.storeExtraction(deps.workerId, group.map((c) => ({ id: c.id, status: "pending", reason: "tick_budget", extractor: null, usageId: null, retryAt: now.toISOString() })), [], []);
      continue;
    }
    for (let i = 0; i < group.length; i += cfg.extractBatch) await extractGroup(deps, access, group.slice(i, i + cfg.extractBatch), now, add);
  }
}

async function extractGroup(deps: EngineDeps, access: TaskAccess, group: ClaimedCandidate[], now: Date, add: (k: string, n?: number) => void) {
  const c0 = group[0]!;
  const results = (status: CandidateResult["status"], reason: string | null, extractor: CandidateResult["extractor"] = null, usageId: string | null = null, retryAt: string | null = null): CandidateResult[] =>
    group.map((c) => ({ id: c.id, status, reason, extractor, usageId, retryAt }));

  if (!stillEligible(c0) || !c0.accountId) {
    await deps.store.storeExtraction(deps.workerId, results("skipped", "policy_changed"), [], []);
    add("extract_skipped_policy", group.length);
    return;
  }
  const rows = await deps.store.context(c0.conversationId, group.map((c) => c.messageId), deps.config.contextMessages);
  const candidateIds = new Set(group.map((c) => c.messageId));
  const input: ExtractionInput = {
    conversationId: c0.conversationId,
    conversationType: c0.conversationType,
    groupName: c0.groupName,
    accountId: c0.accountId,
    messages: rows.map((r) => ({ id: r.id, senderExternalId: r.senderExternalId, isSelf: r.isSelf, text: r.text, mentions: r.mentions, messageAt: r.messageAt, candidate: candidateIds.has(r.id) })),
    openTasks: await deps.store.openTasksOfConversation(c0.conversationId),
  };
  if (!input.messages.some((m) => m.candidate)) {
    await deps.store.storeExtraction(deps.workerId, results("skipped", "content_unavailable"), [], []);
    return;
  }

  const model = await tryModel(deps, input, c0.ownerUserId, now);
  let outcome: ExtractionOutcome | null = model.outcome;
  let extractor: "gemini" | "rules" | null = outcome ? "gemini" : null;
  if (!outcome) {
    add(`extract_fallback_${model.reason}`, 1);
    if (!deps.config.rulesFallback) {
      // nothing usable without the model: retry later (transient) or give up
      const transient = model.reason === "rate_limit" || model.reason === "quota_cooldown" || model.reason === "model_minute" || model.reason === "concurrent" || model.reason === "network" || model.reason === "timeout";
      const retry = transient && group.every((c) => c.attempts < 3);
      await deps.store.storeExtraction(deps.workerId, results(retry ? "pending" : "skipped", model.reason, null, model.usageId, retry ? new Date(now.getTime() + 30 * 60_000).toISOString() : null), [], []);
      return;
    }
    outcome = rulesExtraction(input);
    extractor = "rules";
  }

  // payloads
  const conversation = { id: c0.conversationId, connectionId: c0.connectionId, conversationType: c0.conversationType };
  const managers = await deps.store.connectionManagers(c0.connectionId);
  const prefs = await deps.store.prefs(managers);
  const notifyTo: string[] = [];
  for (const u of managers) if ((prefs.get(u)?.confirmation_enabled ?? true) && (await access.isManager(u, conversation))) notifyTo.push(u);
  const byMessage = new Map(group.map((c) => [c.messageId, c]));
  const tasks: StoredTaskPayload[] = [];
  for (const t of outcome.tasks) {
    const cand = byMessage.get(t.primaryMessageId);
    if (!cand) continue;
    const text = confirmationText({ title: t.title, deadlineAt: t.deadline?.at ?? null, extractor: t.extractor, groupName: c0.groupName, conversationType: c0.conversationType });
    tasks.push({
      dedupeKey: t.dedupeKey,
      candidateId: cand.id,
      conversationId: c0.conversationId,
      title: t.title,
      description: t.description,
      assignorExternalId: t.assignorExternalId,
      deadlineAt: t.deadline?.at.toISOString() ?? null,
      deadlinePrecision: t.deadline?.precision ?? "none",
      deadlinePhrase: t.deadline?.phrase ?? t.unresolvedDeadlinePhrase,
      deadlineAssumed: t.deadline?.assumed ?? false,
      priority: t.priority,
      confidence: t.confidence,
      missing: t.missing,
      evidence: t.evidence,
      extractor: t.extractor,
      sourceMessageAt: t.sourceMessageAt.toISOString(),
      sources: t.sourceMessageIds.map((id) => ({ messageId: id, role: id === t.primaryMessageId ? ("primary" as const) : ("context" as const) })),
      assignees: t.assigneeExternalIds.map((id) => ({ externalId: id, source: t.assigneeSource })),
      notify: notifyTo.map((userId) => ({ userId, ...text })),
    });
  }
  const proposals: ProposalPayload[] = [];
  for (const p of outcome.proposals) {
    const current = input.openTasks.find((t) => t.id === p.taskId);
    if (!current) continue;
    const text = proposalText({ title: current.title, current: current.deadlineAt, proposed: p.deadline.at });
    proposals.push({ taskId: p.taskId, conversationId: c0.conversationId, deadlineAt: p.deadline.at.toISOString(), phrase: p.deadline.phrase, messageId: p.messageId, notify: notifyTo.map((userId) => ({ userId, ...text })) });
  }
  const withTask = new Set(tasks.map((t) => t.candidateId));
  const candidateResults: CandidateResult[] = group.map((c) => ({
    id: c.id,
    status: withTask.has(c.id) ? "task_created" : outcome!.status === "needs_clarification" ? "needs_clarification" : "no_task",
    reason: extractor === "rules" ? `rules_${model.reason}` : null,
    extractor,
    usageId: model.usageId,
    retryAt: null,
  }));
  const res = await deps.store.storeExtraction(deps.workerId, candidateResults, tasks, proposals);
  add("tasks_proposed", res.created.length);
  add("tasks_duplicate", res.duplicates);
  add("tasks_invalid", res.invalid);
  add("deadline_proposals", res.proposals);
  add(`extracted_${extractor}`, group.length);
}

/** Model call with every guard; null outcome + reason when it may not / could not be used. */
async function tryModel(deps: EngineDeps, input: ExtractionInput, billedUserId: string, now: Date): Promise<{ outcome: ExtractionOutcome | null; reason: string; usageId: string | null }> {
  const ready = extractorModelReady(deps.aiConfig, deps.config);
  if (!ready.ready) return { outcome: null, reason: ready.reason, usageId: null };
  const sharing = sharingDecision(deps.aiConfig);
  if (!sharing.allowed) return { outcome: null, reason: sharing.reason, usageId: null };
  const dayStart = vnStartOfDay(now);
  if ((await deps.store.extractionsSince(dayStart)) >= deps.config.maxExtractionsPerDay) return { outcome: null, reason: "daily_cap", usageId: null };

  let provider: AiTextProvider;
  try {
    provider = deps.provider();
  } catch (err) {
    return { outcome: null, reason: err instanceof AiProviderError ? err.category : "config_missing", usageId: null };
  }
  const prompt = buildExtractionPrompt(input, { redact: sharing.redact });
  const estimated = estimateTokens(prompt.system + prompt.user);
  if (estimated > deps.aiConfig.limits.maxInputTokens) return { outcome: null, reason: "too_large", usageId: null };
  const reservation = await deps.store.reserve(billedUserId, provider.name, provider.model, estimated, dayStart, deps.aiConfig.limits);
  if (!reservation.ok) return { outcome: null, reason: reservation.reason, usageId: null };
  const t0 = Date.now();
  let attempts = 0;
  try {
    const { result, attempts: a } = await generateWithRetry(
      provider,
      { system: prompt.system, user: prompt.user, responseSchema: EXTRACTION_JSON_SCHEMA, maxOutputTokens: Math.min(deps.aiConfig.limits.maxOutputTokens, 1_500), timeoutMs: deps.aiConfig.limits.timeoutMs, signal: deps.signal },
      deps.aiConfig.limits.maxRetries,
      deps.sleep,
    );
    attempts = a;
    const v = validateExtraction(result.text, prompt, input);
    await deps.store.finishUsage(reservation.id, { status: v.ok ? "completed" : "failed", reason: v.ok ? null : "invalid_response", inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, confirmed: result.usage.confirmed, attempts, redactions: prompt.redactions, durationMs: Date.now() - t0 });
    deps.log?.("extract", { promptVersion: TASK_EXTRACT_PROMPT_VERSION, ok: v.ok, tasks: v.ok ? v.outcome.tasks.length : 0, ...(v.ok ? v.outcome.dropped : {}) });
    return v.ok ? { outcome: v.outcome, reason: "model", usageId: reservation.id } : { outcome: null, reason: "invalid_response", usageId: reservation.id };
  } catch (err) {
    const category = err instanceof AiProviderError ? err.category : "provider_error";
    await deps.store.finishUsage(reservation.id, { status: "failed", reason: category, inputTokens: 0, outputTokens: 0, confirmed: false, attempts: Math.max(attempts, 1), redactions: prompt.redactions, durationMs: Date.now() - t0 });
    return { outcome: null, reason: category, usageId: reservation.id };
  }
}

// ------------------------------------------------------------------ 4. morning

async function morningPhase(deps: EngineDeps, clock: () => Date, add: (k: string, n?: number) => void) {
  const w = deps.config.reminders;
  const now = clock();
  const hour = vnParts(now).hour;
  if (hour < w.morningCutoffHour) {
    const slot = morningSlot(now, w);
    add("morning_planned", await deps.store.ensureMorning(slot.localDate, slot.scheduledFor));
  }
  if (hour >= 18) {
    const slot = morningSlot(new Date(now.getTime() + DAY_MS), w);
    add("morning_planned", await deps.store.ensureMorning(slot.localDate, slot.scheduledFor));
  }
}

// ------------------------------------------------------------------ 5. reminders

async function reminderPhase(deps: EngineDeps, access: TaskAccess, clock: () => Date, out: () => boolean, add: (k: string, n?: number) => void) {
  const w = deps.config.reminders;
  for (let round = 0; round < 10 && !out(); round++) {
    const claimed = await deps.store.claimReminders(deps.workerId, 50, w.leaseSeconds);
    if (!claimed.length) break;
    const now = clock();
    const skips: ResolveItem[] = [];
    const single: Array<{ o: ClaimedOccurrence; late: boolean }> = [];
    const aggregate = new Map<string, ClaimedOccurrence[]>(); // OVERDUE digests per user
    const mornings: Array<{ o: ClaimedOccurrence; late: boolean }> = [];
    for (const o of claimed) {
      const canRead = o.task ? await access.canRead(o.userId, { id: o.task.conversationId, connectionId: o.task.connectionId, conversationType: o.task.conversationType }) : true;
      const d = decideDelivery(o, now, w, canRead);
      if (d.action === "resolve") {
        skips.push({ id: o.id, status: d.status, reason: d.reason });
        add(`reminder_${d.status}`);
      } else if (o.kind === "MORNING") mornings.push({ o, late: d.late });
      else if (o.kind === "OVERDUE" && d.aggregate) aggregate.set(o.userId, [...(aggregate.get(o.userId) ?? []), o]);
      else single.push({ o, late: d.late });
    }
    if (skips.length) await safeResolve(deps, skips, null, add);

    for (const { o, late } of single) {
      const t = o.task!;
      const n = reminderNotification(o.kind as "DAY" | "HOUR" | "OVERDUE", { userId: o.userId, occurrenceId: o.id, taskId: o.taskId!, title: t.title, deadlineAt: t.deadlineAt!, late, connectionId: t.connectionId, conversationId: t.conversationId });
      await safeResolve(deps, [{ id: o.id, status: late ? "sent_late" : "sent", reason: null }], n, add, o);
    }
    for (const [userId, items] of aggregate) {
      const open = await visibleOpen(deps, access, userId);
      const overdue = open.filter((t) => t.status === "overdue" || (t.deadlineAt && t.deadlineAt.getTime() < now.getTime()));
      const n = overdue.length ? overdueDigest({ userId, dayKey: vnDateKey(now), tasks: overdue }) : null;
      await safeResolve(deps, items.map((o) => ({ id: o.id, status: n ? ("sent_late" as const) : ("skipped" as const), reason: n ? "aggregated" : "nothing_overdue" })), n, add, items[0]);
    }
    for (const { o, late } of mornings) {
      const open = await visibleOpen(deps, access, o.userId);
      const dayEnd = vnStartOfDay(now).getTime() + DAY_MS;
      const isOver = (t: (typeof open)[number]) => t.status === "overdue" || Boolean(t.deadlineAt && t.deadlineAt.getTime() < now.getTime());
      const overdue = open.filter(isOver);
      const today = open.filter((t) => !isOver(t) && t.deadlineAt && t.deadlineAt.getTime() < dayEnd);
      const n = morningDigest({ userId: o.userId, dayKey: o.localDate, overdue, today, other: open.length - overdue.length - today.length, late });
      await safeResolve(deps, [{ id: o.id, status: n ? (late ? "sent_late" : "sent") : "skipped", reason: n ? null : "nothing_to_report" }], n, add, o);
    }
  }
}

/** Open tasks the user is reminded about AND may still read (digest content is re-checked per task). */
async function visibleOpen(deps: EngineDeps, access: TaskAccess, userId: string) {
  const rows = await deps.store.openTasksForUser(userId);
  const out: typeof rows = [];
  for (const r of rows) if (await access.canRead(userId, { id: r.conversationId, connectionId: r.connectionId, conversationType: r.conversationType })) out.push(r);
  return out;
}

async function safeResolve(deps: EngineDeps, items: ResolveItem[], n: InboxNotification | null, add: (k: string, n?: number) => void, source?: ClaimedOccurrence) {
  try {
    const res = await deps.store.resolveReminders(deps.workerId, items, n);
    for (const i of res.items) add(`reminder_${i.status}`);
    add("reminder_lease_lost", res.lost);
    if (res.created && res.notificationId && source) await external(deps, res.notificationId, source, n!);
  } catch {
    // nothing was written (one transaction): retry with backoff, else the lease expires
    for (const i of items) {
      const attempt = (source?.attempts ?? 0) + 1;
      await deps.store.retryReminder(i.id, deps.workerId, "store_error", Math.round(backoffMs(attempt, deps.config.reminders) / 1000)).catch(() => {});
    }
    add("reminder_retry", items.length);
  }
}

/** External channels: nothing happens unless the kill switch is off AND a channel flag is on. */
async function external(deps: EngineDeps, notificationId: string, o: ClaimedOccurrence, n: InboxNotification) {
  const cfg = deps.config.external;
  if (cfg.killSwitch) return;
  for (const channel of ["zalo_personal", "zalo_oa"] as const) {
    if (channel === "zalo_personal" ? !cfg.zaloPersonalEnabled : !cfg.zaloOaEnabled) continue;
    const adapter = deps.adapters[channel];
    const gate = externalGate(channel, cfg, o.prefs, adapter, {
      recipientRef: adapter.available ? await deps.store.externalRecipient(o.userId, channel, o.task?.connectionId ?? null) : null,
      sentLastHour: adapter.available ? await deps.store.externalSentLastHour(o.userId, channel) : 0,
      // a reminder is never posted into a group the engine reads (only to the user's own 1-1)
      wouldLoop: false,
    });
    const record = await dispatchExternal(adapter, gate, { notificationId, userId: o.userId, text: `${REMINDER_MARKER} ${n.title}`, idempotencyKey: `${notificationId}:${channel}` });
    await deps.store.recordDelivery(notificationId, channel, record).catch(() => {});
  }
}
