// ============================================================
// PHASE 04.5 — REPLY-03 / REPLY-04: one inbound question → one draft (or a
// recorded skip). Pure + injected. Reuses, never rebuilds:
//   identity      Phase 05 resolvePersonalIdentity / linkPersonalIdentity
//                 (ai_channel_identities; the profile is re-read every time)
//   business data Phase 05 personalAdapter → askSystemAssistant (role +
//                 screen permissions + AUDIENCE: a group gets knowledge only)
//   chat history  Phase 04 ask(), restricted to THIS conversation and to the
//                 ASKER's own dashboard scope (sharing policy, budget, citations)
// The question runs as the ASKER — never as the owner of the bot account. A
// group membership grants nothing. Message text is data, never an instruction
// (both reused pipelines fence it as DATA).
// ============================================================
import { hasPermission } from "../auth/permissions.ts";
import { answerThroughChannel, personalAdapter } from "../ai-system/channels.ts";
import type { AssistantDeps } from "../ai-system/assistant.ts";
import { detectLinkCommand, linkPersonalIdentity, resolvePersonalIdentity, type IdentityStore } from "../ai-system/identity.ts";
import { ask, type AiDeps } from "../zalo-personal/ai/service.ts";
import type { ReplyConfig } from "./config.ts";
import { autoApproveAllowed, memoryDraft, REPLY_TEXT, routeQuestion, systemDraft, type DraftKind, type DraftPayload, type Pipeline } from "./policy.ts";
import { detectTrigger } from "./router.ts";
import type { EngineStore, InboundClaim, InboundContext, StoreResultInput } from "./store.ts";

export interface PipelineDeps {
  store: EngineStore;
  config: ReplyConfig;
  identity: IdentityStore;
  /** Phase 05 (null = not wired: the business pipeline answers "not enabled") */
  system: (AssistantDeps & { identityStore: IdentityStore }) | null;
  /** Phase 04 */
  memory: AiDeps;
  /** Phase 04 ask() (injectable for unit tests) */
  askMemory?: typeof ask;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export type PipelineOutcome = { kind: "draft"; draftKind: DraftKind; pipeline: Pipeline | "none"; auto: boolean } | { kind: "skip"; reason: string } | { kind: "retry" } | { kind: "lost" };

const draft = (kind: DraftKind, text: string, askerUserId: string | null, extra: Partial<DraftPayload> = {}): DraftPayload => ({
  kind,
  pipeline: "none",
  text,
  citations: [],
  caveats: [],
  responseStatus: null,
  model: null,
  requiredPermissions: [],
  askerUserId,
  autoApprove: false,
  ...extra,
});

/** Decides the result for one claimed inbound row (no write). Exported for tests. */
export async function decide(deps: PipelineDeps, ctx: InboundContext): Promise<StoreResultInput> {
  const s = ctx.settings;
  if (ctx.connectionStatus !== "active") return { skip: "connection_disabled" };
  if (s.replyMode === "off") return { skip: "replies_off" };
  if (ctx.blocked) return { skip: "sender_blocked" };
  // the group / 1-1 policy is re-read here (it may have changed since the scan)
  if (ctx.conversationType === "group") {
    if (ctx.groupConsent !== "granted" || !ctx.groupMode || ctx.groupMode === "disabled") return { skip: "group_disabled" };
    if (ctx.groupMode === "monitor") return { skip: "group_monitor_only" };
  } else if (!s.directEnabled) return { skip: "direct_disabled" };
  if (!ctx.text) return { skip: "content_not_stored" };
  const direct = ctx.conversationType === "user";

  // ---- LINK <mã> (1-1 only): Phase 05 identity linking
  if (ctx.trigger === "link") {
    const code = detectLinkCommand(ctx.text);
    if (!direct || !code) return { skip: "invalid_link" };
    const r = await linkPersonalIdentity(deps.identity, { connectionId: ctx.connectionId, senderId: ctx.senderExternalId, code });
    deps.log?.("link_attempt", { outcome: r.ok ? "linked" : r.reason });
    return { draft: draft("link_result", r.ok ? REPLY_TEXT.linked : r.reason === "user_inactive" ? REPLY_TEXT.linkInactive : REPLY_TEXT.linkInvalid, r.ok ? r.internalUserId : null) };
  }

  // ---- identity: the SENDER, through a verified link only
  const identity = await resolvePersonalIdentity(deps.identity, ctx.connectionId, ctx.senderExternalId);
  if (identity.status === "unlinked") return direct && s.unlinkedHelp ? { draft: draft("link_help", REPLY_TEXT.unlinkedHelp, null) } : { skip: "unlinked" };
  if (identity.status === "inactive") return direct ? { draft: draft("notice", REPLY_TEXT.inactive, null) } : { skip: "asker_inactive" };
  const actor = identity.actor;

  // the question = stored text minus the bot mention spans (metadata) / the /bot command
  const t = detectTrigger({ conversationType: ctx.conversationType, text: ctx.text, mentions: ctx.mentions, isSelf: false }, ctx.zaloAccountId);
  if (!t) return { skip: "not_triggered" };
  const question = t.question;
  if (question.length < 2) return { skip: "empty_question" };
  const audience = direct ? "private" : "group";
  const pipeline = routeQuestion(question);

  let payload: DraftPayload;
  if (pipeline === "memory") {
    if (!hasPermission(actor.role, "zalo_personal:ai")) {
      payload = draft("notice", REPLY_TEXT.memoryDenied, actor.userId, { pipeline: "memory", responseStatus: "denied" });
    } else {
      const r = await (deps.askMemory ?? ask)(deps.memory, { userId: actor.userId, role: actor.role }, { question, conversationIds: [ctx.conversationId] });
      if (!r.ok) {
        if (r.error === "rate_limited") return { skip: "ai_rate_limited" };
        if (r.error === "server_error" || r.error === "conflict") throw new Error(`memory_${r.code}`);
        payload = draft("notice", REPLY_TEXT.memoryDenied, actor.userId, { pipeline: "memory", responseStatus: "denied" });
      } else {
        const turn = r.data.turn;
        const m = memoryDraft(
          {
            status: turn.status,
            answer: turn.answer,
            points: turn.points.map((p) => ({ text: p.text, citations: p.citations.map((c) => ({ messageId: c.messageId, conversationId: c.conversationId, senderLabel: c.senderLabel, at: c.at, snippet: c.snippet, href: c.href })) })),
            warnings: r.data.coverage.warnings,
          },
          ctx.conversationId,
        );
        if (!m.ok) return { skip: "publish_blocked" };
        payload = draft("ai_answer", m.text, actor.userId, { pipeline: "memory", citations: m.citations, caveats: m.caveats, responseStatus: turn.status, model: turn.model, requiredPermissions: m.requiredPermissions });
      }
    }
  } else {
    if (!deps.system) return { skip: "channel_disabled" };
    const sys = deps.system;
    const res = await answerThroughChannel(personalAdapter, sys, { connectionId: ctx.connectionId, senderId: ctx.senderExternalId, conversationType: ctx.conversationType, conversationRef: ctx.conversationId }, question);
    if (!res.ok) return { skip: "channel_disabled" };
    const r = res.response;
    if (r.status === "rate_limited") return { skip: "ai_rate_limited" };
    const d = systemDraft(
      r,
      audience,
      (tool) => sys.registry.get(tool)?.sensitivity ?? null,
      (tool) => sys.registry.get(tool)?.requiredPermissions ?? ["__unknown_tool__"],
    );
    if (!d.ok) payload = draft("notice", REPLY_TEXT.groupDenied, actor.userId, { pipeline: "system", responseStatus: "denied" });
    else payload = draft("ai_answer", d.text, actor.userId, { pipeline: "system", citations: d.citations, caveats: d.caveats, responseStatus: r.status, model: r.meta.model, requiredPermissions: d.requiredPermissions });
  }

  payload.autoApprove = autoApproveAllowed({
    flagEnabled: deps.config.autoReplyEnabled,
    replyMode: s.replyMode,
    allowlisted: ctx.allowlisted,
    conversationType: ctx.conversationType,
    groupMode: ctx.groupMode,
    groupSendVerified: ctx.groupSendVerified,
    directVerified: ctx.directVerified,
    askerLinked: true,
    kind: payload.kind,
    responseStatus: payload.responseStatus,
  });
  return { draft: payload };
}

/** Claimed row → decision → stored atomically (lease-checked). Never throws. */
export async function processInbound(deps: PipelineDeps, claim: InboundClaim, worker: string): Promise<PipelineOutcome> {
  let result: StoreResultInput;
  try {
    const ctx = await deps.store.inboundContext(claim.id);
    result = ctx ? await decide(deps, ctx) : { skip: "not_found" };
  } catch (err) {
    deps.log?.("pipeline_error", { attempt: claim.attempts, error: err instanceof Error ? err.message.slice(0, 64) : "unknown" });
    // retried after the lease (≤ 3 attempts), then failed for good
    if (claim.attempts < 3) return { kind: "retry" };
    result = { skip: "pipeline_error", fail: true };
  }
  const stored = await deps.store.storeResult(claim.id, worker, result).catch(() => ({ ok: false as const, error: "store_failed" }));
  if (!stored.ok) return { kind: "lost" };
  if ("skip" in result) return { kind: "skip", reason: result.skip };
  return { kind: "draft", draftKind: result.draft.kind, pipeline: result.draft.pipeline, auto: stored.status === "queued" };
}
