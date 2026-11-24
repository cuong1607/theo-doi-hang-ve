// ============================================================
// Emergency stop (ZP-07). The STOP file in the data dir is a persistent kill
// switch: a running worker polls it and shuts down gracefully, and no
// command that connects to Zalo starts while it exists (`npm run resume`
// removes it). ZP_ENABLED=false is the second, config-level switch.
// ============================================================
import { access, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export async function stopRequested(stopFile: string): Promise<boolean> {
  try {
    await access(stopFile);
    return true;
  } catch {
    return false;
  }
}

export async function requestStop(stopFile: string, now: Date = new Date()): Promise<void> {
  await mkdir(path.dirname(stopFile), { recursive: true, mode: 0o700 });
  await writeFile(stopFile, `stop requested at ${now.toISOString()}\n`, { mode: 0o600 });
}

export async function clearStop(stopFile: string): Promise<boolean> {
  const existed = await stopRequested(stopFile);
  await rm(stopFile, { force: true });
  return existed;
}

/** Polls the STOP file; calls `onStop` once. Returns a disposer. */
export function watchStopFile(stopFile: string, intervalMs: number, onStop: () => void): () => void {
  let fired = false;
  const timer = setInterval(() => {
    void stopRequested(stopFile).then((yes) => {
      if (yes && !fired) {
        fired = true;
        onStop();
      }
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
