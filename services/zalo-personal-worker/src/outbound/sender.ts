// ============================================================
// Phase 04.5 — one send attempt and how its result is classified. Pure
// except for the injected session.
//
// zca-js sendMessage has NO idempotency key and NO timeout, so the worker
// never guesses: anything that may have reached Zalo is "unknown" and is
// NEVER retried automatically (an operator confirms it on the phone).
//
//   resolved with a msgId              → sent
//   timeout (our race)                 → unknown   (the request may still land)
//   ZaloApiError with Zalo error_code  → failed    (Zalo refused: the backend
//                                                  pauses sending for the account)
//   ZaloApiError "status code 5xx"     → unknown   ;  4xx → failed
//   ZaloApiError "parse response"      → unknown   (Zalo answered, unreadable)
//   other ZaloApiError (validation /   → not_sent  (thrown before any request)
//     encryption / missing cookie)
//   DNS / connection refused           → not_sent  (no request left the machine)
//   any other network error            → unknown
// ============================================================
import { sendErrorInfo, type SendErrorInfo, type ZaloSession } from "../zalo-client.ts";

export type SendOutcome = { outcome: "sent"; zaloMsgId: string | null; category: null } | { outcome: "not_sent" | "failed" | "unknown"; zaloMsgId: null; category: string };

const PRE_CONNECT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

export function classifySendError(info: SendErrorInfo): SendOutcome {
  const no = (outcome: "not_sent" | "failed" | "unknown", category: string): SendOutcome => ({ outcome, zaloMsgId: null, category });
  if (info.zaloApi) {
    if (info.code !== null) return no("failed", "zalo_rejected");
    const http = /status code (\d{3})/i.exec(info.message);
    if (http) return Number(http[1]) >= 500 ? no("unknown", "http_error") : no("failed", "http_error");
    if (/parse response/i.test(info.message)) return no("unknown", "response_unreadable");
    return no("not_sent", "invalid_message");
  }
  if (info.name === "AbortError" || info.name === "TimeoutError") return no("unknown", "timeout");
  if (info.networkCode && PRE_CONNECT.has(info.networkCode)) return no("not_sent", "network");
  return no("unknown", "network_after_send");
}

export interface SendAttempt {
  /** settles with the classified outcome within timeoutMs */
  result: Promise<SendOutcome>;
  /** settles when zca-js finally answers (also after a timeout): a late success is still reported */
  late: Promise<SendOutcome>;
}

export function attemptSend(session: ZaloSession, job: { threadId: string; threadType: "user" | "group"; text: string }, timeoutMs: number): SendAttempt {
  const late: Promise<SendOutcome> = session.sendText(job.threadId, job.threadType, job.text).then(
    (r) => ({ outcome: "sent" as const, zaloMsgId: r.msgId && /^[0-9A-Za-z_-]{1,64}$/.test(r.msgId) ? r.msgId : null, category: null }),
    (err: unknown) => classifySendError(sendErrorInfo(err)),
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<SendOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "unknown", zaloMsgId: null, category: "timeout" }), timeoutMs);
    timer.unref?.();
  });
  const result = Promise.race([late, timeout]).finally(() => clearTimeout(timer));
  return { result, late };
}
