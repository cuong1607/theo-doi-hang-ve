"use client";

// UIUX-1 useAsyncAction: the one hook for buttons that call a server
// action. idle → loading → success | error, toast on completion, no double
// submit (createActionRunner). Server actions that call revalidatePath()
// already re-render the page; pass { refresh: true } only for actions that
// don't (router.refresh after the server confirmed — nothing optimistic).
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { createActionRunner, phaseOf, type ActionOutcome } from "@/lib/ui/action-runner";

import { toast } from "./toast";

const notifier = { success: (m: string) => toast.success(m), warning: (m: string) => toast.warning(m), error: (m: string) => toast.error(m) };

export function useAsyncAction(options: { refresh?: boolean; errorMessage?: string; toast?: boolean } = {}) {
  const router = useRouter();
  const runner = useRef(createActionRunner(notifier));
  const [running, setRunning] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  async function run(fn: () => Promise<ActionOutcome>) {
    if (runner.current.busy) return null;
    setRunning(true);
    setOutcome(null);
    const result = await runner.current.run(fn, { errorMessage: options.errorMessage, toast: options.toast });
    setRunning(false);
    if (result) {
      setOutcome(result);
      if (result.ok && options.refresh) startRefresh(() => router.refresh());
    }
    return result;
  }

  const pending = running;
  return { run, pending, refreshing, outcome, phase: phaseOf(pending, outcome) };
}
