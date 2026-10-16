"use client";

// UIUX-1 LoadingButton: Button + spinner + loading text, disabled and
// aria-busy while loading; clicks during loading are swallowed (no double
// submit even before React re-renders the disabled state).
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

type ButtonProps = React.ComponentProps<typeof Button>;

export function LoadingButton({
  loading = false,
  loadingText,
  icon,
  children,
  disabled,
  onClick,
  ...props
}: ButtonProps & {
  loading?: boolean;
  /** Shown instead of the label while loading ("Đang gửi yêu cầu…"). */
  loadingText?: React.ReactNode;
  /** Idle icon (replaced by the spinner while loading). */
  icon?: React.ReactNode;
}) {
  return (
    <Button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {loading ? <Loader2 aria-hidden="true" className="animate-spin" /> : icon}
      {loading && loadingText ? loadingText : children}
    </Button>
  );
}
