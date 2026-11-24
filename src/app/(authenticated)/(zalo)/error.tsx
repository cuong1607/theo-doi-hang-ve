"use client";

// ZALO PERSONAL Phase 03: friendly error inside the shell; the raw error is logged to the
// console only, never rendered (no stack, no message, no secret on screen).
import { useEffect } from "react";

import { ErrorState } from "@/components/patterns/error-state";

export default function ZaloError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return <ErrorState retry={retry} reference={error.digest} />;
}
