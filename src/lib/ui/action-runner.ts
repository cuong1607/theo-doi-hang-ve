// ============================================================
// PHASE UIUX-1: the async action contract (framework-free — unit tested).
//
//   idle → loading → success | error
//
// runAction():
//   • one request at a time: a second call while one is in flight is
//     ignored (no double submit, even on a fast double click)
//   • a thrown error / rejected server action becomes a friendly
//     { ok: false } result — the raw error never reaches the screen
//   • the outcome is announced as a toast (success / warning / error)
// Never shows success before the server confirmed it (no optimistic
// success for sync / mapping / money actions).
// ============================================================

export interface ActionOutcome {
  ok: boolean;
  message: string;
  /** ok but with a caveat ("Đồng bộ xong, có 3 bản ghi lỗi.") */
  warning?: boolean;
}

export type ActionPhase = "idle" | "loading" | "success" | "error";

export interface Notifier {
  success(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export const DEFAULT_ACTION_ERROR = "Không thực hiện được thao tác. Vui lòng thử lại.";

export function createActionRunner(notify: Notifier | null) {
  let inFlight = false;
  return {
    get busy() {
      return inFlight;
    },
    /** Resolves to the outcome, or null when ignored because one is already running. */
    async run(fn: () => Promise<ActionOutcome>, options: { errorMessage?: string; toast?: boolean } = {}): Promise<ActionOutcome | null> {
      if (inFlight) return null;
      inFlight = true;
      let outcome: ActionOutcome;
      try {
        const r = await fn();
        outcome = r && typeof r.ok === "boolean" && typeof r.message === "string" ? r : { ok: false, message: options.errorMessage ?? DEFAULT_ACTION_ERROR };
      } catch {
        outcome = { ok: false, message: options.errorMessage ?? DEFAULT_ACTION_ERROR };
      } finally {
        inFlight = false;
      }
      if (notify && options.toast !== false) {
        if (!outcome.ok) notify.error(outcome.message);
        else if (outcome.warning) notify.warning(outcome.message);
        else notify.success(outcome.message);
      }
      return outcome;
    },
  };
}

export function phaseOf(pending: boolean, outcome: ActionOutcome | null): ActionPhase {
  if (pending) return "loading";
  if (!outcome) return "idle";
  return outcome.ok ? "success" : "error";
}
