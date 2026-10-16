// ============================================================
// PHASE UIUX-1: toast store (framework-free — unit tested). The React
// <Toaster/> subscribes to it; `toast.success(...)` etc. can be called from
// any client code. Short, plain messages only — callers never pass raw
// errors / stacks (see runAction).
// ============================================================

export type ToastTone = "success" | "error" | "warning" | "info";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  description?: string;
}

type Listener = () => void;

/** Errors stay a little longer; at most MAX_VISIBLE at once (oldest dropped). */
export const TOAST_DURATION_MS: Record<ToastTone, number> = { success: 4000, info: 4000, warning: 6000, error: 7000 };
export const MAX_VISIBLE_TOASTS = 4;
const MAX_MESSAGE = 200;

export function createToastStore(schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms)) {
  let items: ToastItem[] = [];
  let nextId = 1;
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((l) => l());

  function dismiss(id: number) {
    const before = items.length;
    items = items.filter((t) => t.id !== id);
    if (items.length !== before) emit();
  }

  function add(tone: ToastTone, message: string, description?: string): number {
    const id = nextId++;
    const item: ToastItem = { id, tone, message: message.slice(0, MAX_MESSAGE), ...(description ? { description: description.slice(0, MAX_MESSAGE) } : {}) };
    items = [...items, item].slice(-MAX_VISIBLE_TOASTS);
    emit();
    schedule(() => dismiss(id), TOAST_DURATION_MS[tone]);
    return id;
  }

  return {
    add,
    dismiss,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => items,
  };
}

export type ToastStore = ReturnType<typeof createToastStore>;
