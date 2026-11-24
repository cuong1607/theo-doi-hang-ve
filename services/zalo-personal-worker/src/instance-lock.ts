// ============================================================
// One worker process per data dir (= per Zalo account): a second listener on
// the same account makes Zalo close the first one (close code 3000) and the
// two would keep kicking each other. The lock file holds the owner's PID; a
// lock whose PID is no longer running is stale and is taken over.
// ============================================================
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

export class AlreadyRunningError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`Worker khác đang chạy cho tài khoản này (PID ${pid}). Dừng nó trước (npm run stop).`);
    this.name = "AlreadyRunningError";
    this.pid = pid;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface InstanceLock {
  release(): Promise<void>;
}

export async function acquireInstanceLock(file: string, options: { pid?: number; isAlive?: (pid: number) => boolean } = {}): Promise<InstanceLock> {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? isProcessAlive;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(String(pid), "utf8");
      await handle.close();
      return {
        async release() {
          const current = await readFile(file, "utf8").catch(() => "");
          if (current.trim() === String(pid)) await rm(file, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = Number((await readFile(file, "utf8").catch(() => "")).trim());
      if (Number.isInteger(owner) && owner > 0 && owner !== pid && isAlive(owner)) throw new AlreadyRunningError(owner);
      await rm(file, { force: true }); // stale (crashed owner) or unreadable
    }
  }
  throw new Error("Không lấy được khóa worker.");
}
