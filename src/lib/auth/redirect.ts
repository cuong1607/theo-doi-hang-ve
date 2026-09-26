// Where to send a user after login. Only same-origin, absolute paths are
// accepted ("/receipts?x=1"); anything else ("//evil.com", "https://…",
// "javascript:…", or the auth pages themselves) falls back to /dashboard,
// so the ?next= parameter can't be used as an open redirect or a loop.
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/dashboard";
  }
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/account-disabled")) {
    return "/dashboard";
  }
  return next;
}
