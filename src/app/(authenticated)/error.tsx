"use client";

// UIUX-1: one error boundary for every signed-in page without its own —
// the sidebar/header stay, only the page area shows a friendly error with
// "Thử lại" (Next 16 `retry` re-fetches the segment) and the digest as a
// reference. The raw error is logged to the console, never rendered.
import { useEffect } from "react";

import { ErrorState } from "@/components/patterns/error-state";

export default function AuthenticatedError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return <ErrorState retry={retry} reference={error.digest} />;
}
