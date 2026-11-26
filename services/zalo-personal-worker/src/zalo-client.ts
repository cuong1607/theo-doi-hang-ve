// ============================================================
// The ONLY module that imports zca-js. Everything else depends on the small
// interfaces below, so tests run against mocks and a future library upgrade
// touches one file.
//
// zca-js options used (verified in node_modules/zca-js@2.4.0/dist):
//   selfListen: true   receive messages sent by this account (ZP-04)
//   checkUpdate: false no call to the npm registry at login
//   logging: false     the library's own console logs are off (they print
//                      the account uid / display name and QR paths)
// Phase 04.5 adds exactly ONE write: sendText (plain text to one thread),
// used only by outbound/ for replies the backend approved. No join / history /
// friend / bulk API is exposed.
//   api.sendMessage(message: MessageContent | string, threadId: string,
//                   type: ThreadType = User) → { message: { msgId } | null, attachment }
//   (verified in node_modules/zca-js@2.4.0/dist/apis/sendMessage.{d.ts,js};
//   ThreadType.User = 0, ThreadType.Group = 1; errors are ZaloApiError with
//   `code` = Zalo error_code when Zalo answered and refused). zca-js has NO
//   idempotency key and no request timeout for sendMessage.
// ============================================================
import { LoginQRCallbackEventType, ThreadType, Zalo, ZaloApiError, type API } from "zca-js";

import type { SessionCredentials } from "./session-manager.ts";

export type ListenerEventName = "connected" | "closed" | "error" | "message" | "undo" | "reaction" | "group_event";

export interface ListenerLike {
  on(event: "connected", cb: () => void): void;
  on(event: "closed", cb: (code: number, reason: string) => void): void;
  on(event: "error", cb: (error: unknown) => void): void;
  on(event: "message" | "undo" | "reaction" | "group_event", cb: (raw: unknown) => void): void;
  /** Never with retryOnClose: reconnects are owned by connection-manager (bounded backoff). */
  start(): void;
  stop(): void;
  removeAllListeners(): void;
}

export interface ZaloSession {
  ownId(): string;
  readonly listener: ListenerLike;
  /** Invalidates the session on Zalo's side. */
  logout(): Promise<void>;
  /** Plain text to one thread (Phase 04.5 outbound only). Resolves with Zalo's message id. */
  sendText(threadId: string, threadType: "user" | "group", text: string): Promise<{ msgId: string | null }>;
}

/** Library-independent view of a send failure (see outbound/sender.ts classifySendError). */
export interface SendErrorInfo {
  /** a ZaloApiError: Zalo (or the library) produced it */
  zaloApi: boolean;
  /** Zalo's numeric error_code when Zalo answered and refused */
  code: number | null;
  message: string;
  name: string;
  networkCode: string | null;
}

export function sendErrorInfo(err: unknown): SendErrorInfo {
  if (!(err instanceof Error)) return { zaloApi: false, code: null, message: "", name: "unknown", networkCode: null };
  const raw = (err as { code?: unknown }).code;
  const causeCode = (err.cause as { code?: unknown } | undefined)?.code;
  const net = typeof raw === "string" ? raw : typeof causeCode === "string" ? causeCode : null;
  const isZalo = err instanceof ZaloApiError;
  return { zaloApi: isZalo, code: isZalo && typeof raw === "number" ? raw : isZalo && typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : null, message: err.message, name: err.name, networkCode: isZalo ? null : net };
}

export type QrEvent =
  | { type: "generated"; imageBase64: string; retry: () => void; abort: () => void }
  | { type: "expired"; retry: () => void; abort: () => void }
  | { type: "scanned"; retry: () => void; abort: () => void }
  | { type: "declined"; retry: () => void; abort: () => void }
  | { type: "credentials"; credentials: SessionCredentials };

export interface ZaloConnector {
  loginWithSession(credentials: SessionCredentials): Promise<ZaloSession>;
  /** `onEvent` is called synchronously by the library; it must not throw. */
  loginWithQR(onEvent: (event: QrEvent) => void): Promise<ZaloSession>;
}

const ZALO_OPTIONS = { selfListen: true, checkUpdate: false, logging: false } as const;

function wrap(api: API): ZaloSession {
  const l = api.listener;
  const listener: ListenerLike = {
    on: ((event: ListenerEventName, cb: (...args: never[]) => void) => {
      (l.on as (e: string, f: (...a: unknown[]) => void) => void)(event, cb as (...a: unknown[]) => void);
    }) as ListenerLike["on"],
    start: () => l.start({ retryOnClose: false }),
    stop: () => l.stop(),
    removeAllListeners: () => {
      l.removeAllListeners();
    },
  };
  return {
    ownId: () => api.getOwnId(),
    listener,
    logout: async () => {
      await api.logout();
    },
    sendText: async (threadId, threadType, text) => {
      const r = await api.sendMessage({ msg: text }, threadId, threadType === "group" ? ThreadType.Group : ThreadType.User);
      const id = r?.message?.msgId;
      return { msgId: id === undefined || id === null ? null : String(id) };
    },
  };
}

export class ZcaConnector implements ZaloConnector {
  async loginWithSession(credentials: SessionCredentials): Promise<ZaloSession> {
    const zalo = new Zalo(ZALO_OPTIONS);
    const api = await zalo.login({
      imei: credentials.imei,
      cookie: credentials.cookie as Parameters<Zalo["login"]>[0]["cookie"],
      userAgent: credentials.userAgent,
      language: credentials.language,
    });
    return wrap(api);
  }

  async loginWithQR(onEvent: (event: QrEvent) => void): Promise<ZaloSession> {
    const zalo = new Zalo(ZALO_OPTIONS);
    // A callback is ALWAYS passed: without one zca-js writes ./qr.png itself.
    const api = await zalo.loginQR({ language: "vi" }, (event) => {
      switch (event.type) {
        case LoginQRCallbackEventType.QRCodeGenerated:
          onEvent({ type: "generated", imageBase64: event.data.image, retry: () => void event.actions.retry(), abort: () => void event.actions.abort() });
          break;
        case LoginQRCallbackEventType.QRCodeExpired:
          onEvent({ type: "expired", retry: () => void event.actions.retry(), abort: () => void event.actions.abort() });
          break;
        case LoginQRCallbackEventType.QRCodeScanned:
          // event.data carries the display name / avatar: deliberately not forwarded
          onEvent({ type: "scanned", retry: () => void event.actions.retry(), abort: () => void event.actions.abort() });
          break;
        case LoginQRCallbackEventType.QRCodeDeclined:
          onEvent({ type: "declined", retry: () => void event.actions.retry(), abort: () => void event.actions.abort() });
          break;
        case LoginQRCallbackEventType.GotLoginInfo:
          onEvent({ type: "credentials", credentials: { imei: event.data.imei, cookie: event.data.cookie, userAgent: event.data.userAgent, language: "vi" } });
          break;
      }
    });
    return wrap(api);
  }
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

/**
 * "network": the request never got a definite answer → may be retried with backoff.
 * "rejected": Zalo answered and refused the session → never retried automatically.
 * Reads the error only to classify it; the message is never logged.
 */
export function classifyLoginError(err: unknown): "network" | "rejected" {
  if (!(err instanceof Error)) return "rejected";
  if (err.name === "AbortError" || err.name === "TimeoutError") return "network";
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return "network";
  if (err.name === "TypeError" && /fetch failed/i.test(err.message)) return "network";
  return "rejected";
}
