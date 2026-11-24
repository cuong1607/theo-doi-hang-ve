// ============================================================
// ZP-02: QR login.
//
// The QR image is written ONLY to <dataDir>/qr/login-qr.png (per-user folder,
// outside Git) so the owner can scan it, optionally opened with the default
// Windows image viewer, and DELETED as soon as the QR is scanned, expires,
// is declined, or the login ends — success or failure. It is never logged.
//
// Bounded: at most `maxAttempts` QR codes are generated (each lives ~100 s in
// zca-js); after that the login is aborted. Nothing tries to get around
// Zalo's own checks (no captcha solving, no automatic confirmation).
// ============================================================
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "./logger.ts";
import { safeError } from "./logger.ts";
import type { SessionCredentials } from "./session-manager.ts";
import type { QrEvent, ZaloConnector, ZaloSession } from "./zalo-client.ts";

export type QrLoginFailure = "qr_expired" | "qr_declined" | "qr_failed";

export class QrLoginError extends Error {
  readonly reason: QrLoginFailure;
  constructor(reason: QrLoginFailure) {
    super(reason === "qr_expired" ? "Mã QR đã hết hạn quá số lần cho phép." : reason === "qr_declined" ? "Đăng nhập đã bị từ chối trên điện thoại." : "Đăng nhập QR thất bại.");
    this.name = "QrLoginError";
    this.reason = reason;
  }
}

export type QrPhase = "qr_pending" | "scanned";

export interface QrLoginDeps {
  connector: ZaloConnector;
  qrDir: string;
  maxAttempts: number;
  autoOpen: boolean;
  logger: Logger;
  /** Human-readable instructions (console). Never receives QR data. */
  print: (line: string) => void;
  onPhase?: (phase: QrPhase) => void;
  openFile?: (file: string) => void;
}

export const QR_FILE_NAME = "login-qr.png";

export function openWithDefaultViewer(file: string): void {
  if (process.platform !== "win32") return;
  const child = spawn("explorer.exe", [file], { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => {});
  child.unref();
}

export async function runQrLogin(deps: QrLoginDeps): Promise<{ session: ZaloSession; credentials: SessionCredentials }> {
  const qrFile = path.join(deps.qrDir, QR_FILE_NAME);
  const open = deps.openFile ?? openWithDefaultViewer;
  let generated = 0;
  let failure: QrLoginFailure | null = null;
  let credentials: SessionCredentials | null = null;
  const pending: Promise<unknown>[] = [];

  const removeQr = () => rm(qrFile, { force: true }).catch(() => {});

  const onEvent = (event: QrEvent) => {
    try {
      switch (event.type) {
        case "generated": {
          generated++;
          if (generated > deps.maxAttempts) {
            failure = "qr_expired";
            event.abort();
            return;
          }
          deps.onPhase?.("qr_pending");
          pending.push(
            (async () => {
              await mkdir(deps.qrDir, { recursive: true, mode: 0o700 });
              await writeFile(qrFile, Buffer.from(event.imageBase64, "base64"), { mode: 0o600 });
              deps.logger.info("qr_generated", { attempt: generated, maxAttempts: deps.maxAttempts });
              deps.print("");
              deps.print(`=== ĐĂNG NHẬP ZALO (lần ${generated}/${deps.maxAttempts}) ===`);
              deps.print(`Mở ảnh QR tại: ${qrFile}`);
              deps.print("Trên điện thoại: Zalo > biểu tượng QR (góc trên) > quét mã, rồi bấm XÁC NHẬN trên điện thoại.");
              deps.print("Mã có hiệu lực khoảng 100 giây. Không chia sẻ ảnh này cho ai.");
              if (deps.autoOpen) open(qrFile);
            })().catch((err) => {
              deps.logger.error("qr_write_failed", { error: safeError(err) });
              failure = "qr_failed";
              event.abort();
            }),
          );
          return;
        }
        case "expired":
          pending.push(removeQr());
          deps.logger.info("qr_expired", { attempt: generated });
          if (generated >= deps.maxAttempts) {
            failure = "qr_expired";
            event.abort();
          } else {
            deps.print("Mã QR đã hết hạn — đang tạo mã mới…");
            event.retry();
          }
          return;
        case "scanned":
          pending.push(removeQr());
          deps.onPhase?.("scanned");
          deps.logger.info("qr_scanned");
          deps.print("Đã quét mã. Hãy bấm XÁC NHẬN trên điện thoại.");
          return;
        case "declined":
          pending.push(removeQr());
          deps.logger.warn("qr_declined");
          failure = "qr_declined";
          event.abort();
          return;
        case "credentials":
          credentials = event.credentials;
          return;
      }
    } catch (err) {
      deps.logger.error("qr_callback_failed", { error: safeError(err) });
    }
  };

  try {
    const session = await deps.connector.loginWithQR(onEvent);
    await Promise.allSettled(pending);
    if (!credentials) throw new QrLoginError("qr_failed");
    return { session, credentials };
  } catch (err) {
    await Promise.allSettled(pending);
    if (err instanceof QrLoginError) throw err;
    deps.logger.error("qr_login_failed", { error: safeError(err), reason: failure ?? "qr_failed" });
    throw new QrLoginError(failure ?? "qr_failed");
  } finally {
    await removeQr();
  }
}
