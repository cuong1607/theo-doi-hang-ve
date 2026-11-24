// ============================================================
// Encryption-at-rest for the Zalo session (ZP-03).
//
//   dpapi    Windows Data Protection API, scope CurrentUser, with a fixed
//            application entropy. Only the same Windows user on the same
//            machine can decrypt. Called through powershell.exe
//            (System.Security.Cryptography.ProtectedData) so there is no
//            native addon; the data goes through STDIN/STDOUT as base64,
//            never through the command line (visible to other processes).
//   aes-key  AES-256-GCM with a 32-byte key from ZP_SESSION_KEY (for the
//            future Linux VPS, where the key comes from the service's secret
//            store / systemd credential). Additional authenticated data binds
//            the ciphertext to its purpose.
// ============================================================
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SessionProtector {
  readonly name: "dpapi" | "aes-key";
  protect(plaintext: Buffer): Promise<Buffer>;
  unprotect(ciphertext: Buffer): Promise<Buffer>;
}

export class SessionDecryptError extends Error {
  constructor() {
    super("Không giải mã được phiên đã lưu (sai khóa, sai người dùng Windows hoặc dữ liệu bị sửa).");
    this.name = "SessionDecryptError";
  }
}

// ------------------------------------------------------------ AES-256-GCM
const AAD = Buffer.from("congtrangbedding:zalo-personal:session:v1", "utf8");

export class AesKeyProtector implements SessionProtector {
  readonly name = "aes-key" as const;
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, "base64");
    if (key.length !== 32) throw new Error("ZP_SESSION_KEY phải là 32 byte base64.");
    this.key = key;
  }

  async protect(plaintext: Buffer): Promise<Buffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  async unprotect(data: Buffer): Promise<Buffer> {
    if (data.length < 12 + 16 + 1) throw new SessionDecryptError();
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
      decipher.setAAD(AAD);
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
    } catch {
      throw new SessionDecryptError();
    }
  }
}

// ------------------------------------------------------------ Windows DPAPI
export const DPAPI_ENTROPY = "CongTrangBedding.ZaloPersonal.Session.v1";

function dpapiScript(op: "Protect" | "Unprotect", entropy: string): string {
  // entropy is a constant from this file (no user input reaches the script text)
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$raw = [Console]::In.ReadToEnd().Trim()",
    "$bytes = [Convert]::FromBase64String($raw)",
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${entropy.replace(/'/g, "''")}')`,
    `$out = [Security.Cryptography.ProtectedData]::${op}($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("; ");
}

export type ProcessRunner = (command: string, args: string[], stdin: string) => Promise<{ code: number | null; stdout: string }>;

const runProcess: ProcessRunner = (command, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    // stderr is drained but never surfaced: it could echo input on some failures
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });

export class DpapiProtector implements SessionProtector {
  readonly name = "dpapi" as const;
  private readonly run: ProcessRunner;
  private readonly entropy: string;

  constructor(options: { run?: ProcessRunner; entropy?: string } = {}) {
    this.run = options.run ?? runProcess;
    this.entropy = options.entropy ?? DPAPI_ENTROPY;
  }

  private async call(op: "Protect" | "Unprotect", data: Buffer): Promise<Buffer> {
    const { code, stdout } = await this.run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", dpapiScript(op, this.entropy)],
      data.toString("base64"),
    );
    const out = stdout.trim();
    if (code !== 0 || !out || !/^[A-Za-z0-9+/=]+$/.test(out)) {
      if (op === "Unprotect") throw new SessionDecryptError();
      throw new Error("DPAPI Protect thất bại.");
    }
    return Buffer.from(out, "base64");
  }

  protect(plaintext: Buffer): Promise<Buffer> {
    return this.call("Protect", plaintext);
  }

  unprotect(ciphertext: Buffer): Promise<Buffer> {
    return this.call("Unprotect", ciphertext);
  }
}

export function createProtector(config: { sessionProtection: "dpapi" | "aes-key"; sessionKey: string | null }): SessionProtector {
  if (config.sessionProtection === "dpapi") return new DpapiProtector();
  if (!config.sessionKey) throw new Error("Thiếu ZP_SESSION_KEY.");
  return new AesKeyProtector(config.sessionKey);
}
