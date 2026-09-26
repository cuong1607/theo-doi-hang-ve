import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// ============================================================
// First line of defense, on every request (pages, RSC navigations, API):
//   1. refresh the Supabase session cookie (required for Server Components),
//   2. keep anonymous visitors out of business routes,
//   3. keep disabled accounts out, even with a still-valid session.
// It is NOT the only check: every page, server action and route handler
// authorizes again through src/lib/auth/session.ts (role + permission).
// ============================================================

// Reachable without a session. Everything else is protected.
const PUBLIC_PATHS = ["/login"];
const PUBLIC_PREFIXES = [
  "/api/cron/", // Vercel Cron — own CRON_SECRET check, no user session
  "/api/health", // technical health check
];
// "/" stays public on purpose: it's a plain HTML page (see app/page.tsx,
// Zalo site-verification meta tag) that client-redirects to /dashboard,
// which is protected.
const ROOT_PATH = "/";

// Signed-in users only, but allowed while the account is disabled (it's
// where disabled users are sent, and it offers a logout button).
const INACTIVE_ALLOWED_PATHS = ["/account-disabled"];

function isPublic(pathname: string) {
  return (
    pathname === ROOT_PATH ||
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))
  );
}

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: Do NOT run any logic between createServerClient and
  // supabase.auth.getUser(). getUser() validates the JWT with the Auth
  // server and refreshes an expired session (writing new cookies above).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");
  // Server Actions POST to the page URL. Never redirect them — a redirect
  // response can't be consumed as an action result. They authorize
  // themselves (authorizeAction) and return a friendly error instead.
  const isServerAction = request.headers.has("next-action");

  // Carry refreshed session cookies over to any redirect we return.
  const withCookies = (response: NextResponse) => {
    supabaseResponse.cookies.getAll().forEach((c) => response.cookies.set(c));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
  const redirectTo = (path: string, params?: Record<string, string>) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = "";
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    return withCookies(NextResponse.redirect(url));
  };
  const deny = (status: 401 | 403, message: string) =>
    withCookies(NextResponse.json({ success: false, errorMessage: message }, { status }));

  if (isPublic(pathname)) {
    // Already signed in? Skip the login form.
    if (pathname === "/login" && user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("is_active")
        .eq("id", user.id)
        .maybeSingle();
      if (profile?.is_active) return redirectTo("/dashboard");
    }
    return supabaseResponse;
  }

  if (!user) {
    if (isServerAction) return supabaseResponse;
    if (isApi) return deny(401, "Bạn cần đăng nhập để thực hiện thao tác này.");
    return redirectTo("/login", { next: `${pathname}${search}` });
  }

  if (INACTIVE_ALLOWED_PATHS.includes(pathname)) return supabaseResponse;

  // Own profile row is readable with the user's own JWT (RLS policy
  // own_or_admin_select). One small indexed lookup per request — the price
  // of cutting off a disabled account on its very next request.
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.is_active) {
    if (isServerAction) return supabaseResponse;
    if (isApi) return deny(403, "Tài khoản đã bị vô hiệu hóa.");
    return redirectTo("/account-disabled");
  }

  // Protected content must not be served from shared caches.
  supabaseResponse.headers.set("Cache-Control", "private, no-store");
  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - static image files
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
