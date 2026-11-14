// Where to send a user after login. Only same-origin, absolute paths are
// accepted ("/receipts?x=1"); anything else ("//evil.com", "https://…",
// "javascript:…", or the auth pages themselves) falls back to the App Hub,
// so the ?next= parameter can't be used as an open redirect or a loop.
// APP-SHELL-1: a plain sign-in lands on the App Hub; a deep link (?next=) still returns to that page.
export const DEFAULT_AFTER_LOGIN = "/apps";

export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return DEFAULT_AFTER_LOGIN;
  }
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/account-disabled")) {
    return DEFAULT_AFTER_LOGIN;
  }
  return next;
}
