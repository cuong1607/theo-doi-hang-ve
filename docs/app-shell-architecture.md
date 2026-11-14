# App shell architecture (APP-SHELL-1)

The product is a multi-app workspace. After sign-in, people land on the **App Hub** (`/apps`) and pick an app. Each app then has its own sidebar.

```
RootLayout (src/app/layout.tsx)
└── (authenticated)/layout.tsx       auth session, tooltips, toasts (no navigation)
    ├── (hub)/layout.tsx              HubShell: slim top bar, no sidebar      → /apps, /forbidden
    ├── (accounting)/layout.tsx       AppShell app="accounting"               → /dashboard, /receipts, …
    ├── (shopee)/layout.tsx           AppShell app="shopee"                   → /apps/shopee, /shopee/ads, …
    ├── (system)/layout.tsx           AppShell app="system"                   → /users, /settings/notifications
    ├── (purchasing)/layout.tsx       AppShell app="purchasing"  ("Sắp có")   → /apps/purchasing
    ├── (creative)/layout.tsx         AppShell app="creative"    ("Sắp có")   → /apps/creative
    └── (marketing)/layout.tsx        AppShell app="marketing"   ("Sắp có")   → /apps/marketing
```

**Route groups do not change URLs.** Every existing link, bookmark, `revalidatePath` and `?next=` keeps working. Phase 1 moved folders only. No page was rewritten.

## Pieces

| What | Where |
| --- | --- |
| App registry: id, name, subtitle, description, icon, accent, href, enabled, permission, `whenDenied`, status source, route prefixes | `src/lib/apps/registry.ts` (`APP_REGISTRY`, `hubApps`, `canAccessApp`, `appForPath`) |
| Per-app navigation | `src/lib/apps/nav.ts` (`APP_NAV`, `visibleNav`, `activeNavItemHref`) |
| Hub / landing status (DB only) | `src/lib/apps/status.ts` (loaders), `src/lib/apps/sync-health.ts` (pure classification) |
| Shell (server) | `src/components/app-shell/app-shell.tsx` |
| Sidebar, app switcher, header, user menu | `src/components/app-shell/{domain-sidebar,app-switcher,shell-header,user-menu}.tsx` |
| Hub card, coming-soon landing, icon map | `src/components/app-shell/{hub-card,coming-soon,app-icons}.tsx` |
| Accent tokens | `src/app/globals.css`: `[data-app]` with the `app-gradient`, `app-wash` and `app-card` utilities |

Cards, the switcher, shell identity and URL ownership all read the registry. No app is hardcoded anywhere else.

## Apps

| App | Hub name | Landing | State |
| --- | --- | --- | --- |
| accounting | Theo dõi hàng về · Kế toán & vận hành | `/dashboard` (alias `/apps/accounting`) | live |
| shopee | Phân tích Shopee · Marketplace Intelligence | `/apps/shopee` | live |
| purchasing | Gọi hàng · Purchasing | `/apps/purchasing` | Sắp có |
| creative | Thiết kế ảnh & video · Creative Studio | `/apps/creative` | Sắp có |
| marketing | Marketing · Growth & Campaigns | `/apps/marketing` | Sắp có |
| system | Quản trị hệ thống · Người dùng & thông báo | `/users` (alias `/apps/system`) | live, admin only |

"Sắp có" apps:
* **Hub card:** a `div` with `aria-disabled`. It is not focusable and has no `href`, so it never navigates.
* **Switcher:** disabled item.
* **Landing:** reachable by direct URL only. It lists the planned modules, with no data and no metrics.

## Route map: old → new

| URL | App (group) | Change |
| --- | --- | --- |
| `/` | — | client-redirects to **`/apps`** (was `/dashboard`) |
| `/login` (signed in) | — | → **`/apps`** (was `/dashboard`) |
| `/apps` | hub | **new**: launcher |
| `/apps/shopee` | shopee | **new**: Shopee landing (entry cards + sync health) |
| `/apps/accounting` | accounting | **new alias** → `/dashboard` (next.config, 307) |
| `/apps/system` | system | **new alias** → `/users` (next.config, 307) |
| `/apps/purchasing`, `/apps/creative`, `/apps/marketing` | own groups | **new**: "Sắp có" landings |
| `/dashboard`, `/receipts/**`, `/invoices/**`, `/outstanding/**`, `/debts`, `/payments/**`, `/products/**`, `/suppliers`, `/inventory/costs/**` | accounting | moved into `(accounting)`, URL unchanged |
| `/shopee/{dashboard,analytics,products,orders,returns,payouts,sync,system-health}/**` | accounting | moved, URL unchanged; **still retired** (proxy redirect / 404 while `SHOPEE_LEGACY_MODULES_ENABLED` is off) |
| `/shopee/ads/**`, `/shopee/product-analytics/**`, `/settings/shopee`, `/settings/zalo-agent` | shopee | moved, URL unchanged |
| `/users`, `/settings/notifications` | system | moved, URL unchanged |
| `/forbidden` | hub | moved; its button now says "Về trang ứng dụng" → `/apps` |

**Long-term plan, not done in phase 1:** move the Shopee pages under `/apps/shopee/...` and the accounting pages under `/apps/accounting/...`. Leave 308 redirects from the old URLs, and only after usage shows that bookmarks have moved. Then `appForPath` prefixes and `APP_NAV` hrefs are the only places to update.

## Post-login

* **Plain sign-in:** `safeNextPath()` returns `DEFAULT_AFTER_LOGIN = "/apps"`.
* **Deep links:** the proxy sends anonymous visitors to `/login?next=<path+query>`, and login returns them there. For example, `/shopee/ads` → login → `/shopee/ads`.
* **Open redirects** (`//…`, `https://…`) and the auth pages fall back to `/apps`.

## Navigation

* **Switcher:** top-left of every shell. It offers "Tất cả ứng dụng" (→ `/apps`) and then the apps this role can see. The current app is marked with a check. Soon and locked apps are disabled.
* **Sidebar** (`visibleNav`): shows only the current app's items, filtered by:
  * feature permission;
  * `flag: "shopeeAds"` (`SHOPEE_ADS_ENABLED`);
  * `flag: "legacy"`: the retired Shopee accounting modules appear only if `SHOPEE_LEGACY_MODULES_ENABLED` is ever on again. Today they are hidden.
* **Domain separation** is covered by a unit test: every live link resolves (`appForPath`) to its own app. So the Shopee sidebar can never show giá vốn, đối soát, hoàn trả or dòng tiền, and the accounting sidebar never shows Ads, product analytics or the AI assistant.
* **Active item** (`activeNavItemHref`): the URL is the source of truth (path + query). Nothing is stored in a cookie or in local storage.
  * The longest path wins.
  * An item whose query matches (`?health=ATTENTION` → "Sản phẩm cần chú ý") beats the plain item.
  * Anchors (`#suc-khoe-dong-bo`) and "Sắp có" items are never active.
* **Header:** sidebar toggle · breadcrumb **Ứng dụng › {app} › {page}** · page title (`h1`) · user menu.
* **Mobile:** below `md` the sidebar is a sheet, and it closes after each navigation.
* **Accent:** each app sets only two hues on `[data-app]`. Every shade, in light and dark, comes from one shared formula. The active sidebar item and focus ring follow the app. There is no separate palette per app.

## Permission model

* **App level:** permissions `app:accounting | app:shopee | app:purchasing | app:creative | app:marketing | app:system` in the existing role matrix (`src/lib/auth/permissions.ts`).
  * Mapping: all roles get every app except `app:system`, which is admin only. That was already the case for `/users` and the notification settings.
  * No role lost a screen.
* **Feature level** (unchanged): each page still calls `requirePermission(<feature>)`. Examples: `receipt:create`, `channel:manage`, `user:manage`.
* **Shop scope** (unchanged): the web dashboards show the live active shops to `channel:view`. The AI agent's shop scope is `ai_user_shop_access`. Entering the Shopee app grants nothing extra.
* **Enforcement** (unchanged):
  * the proxy runs on every request (session, active account, retired modules);
  * `AppShell` calls `canAccessApp`, and on failure goes to `/forbidden`. `/forbidden` lives in the hub group, so it cannot loop;
  * every page calls its own `requirePermission`.
  * Hiding a menu link is never the protection.
* **Hub visibility:** `whenDenied: "hide"` (internal apps such as system) or `"locked"` (visible card, no access). If a role has no open app, the hub shows "Bạn chưa được cấp quyền vào khu vực nào." with no redirect.
* **Future:** roles per app (Ads viewer / analyst / admin, accountant / viewer) can map onto new `app:*` and feature keys without changing the shell.

## Data and safety

* **`/apps`** reads only the Shopee connection count (2 tiny indexed selects on `shops` and `shop_connections`). It never runs an analytics RPC.
* **`/apps/shopee`** adds the two freshness RPCs the product page already uses (`product_analytics_freshness`, `ads_sync_freshness`). A failed read hides the status; it never invents one.
* **No Shopee calls:** opening `/apps`, `/apps/shopee` or any shell makes 0 Shopee API calls.
  * Guarded statically in `src/lib/apps/apps.test.ts`: no provider, token, sync or AI import, and no write.
  * Checked live by `scripts/e2e/app-shell-1.ts`: no new job or snapshot row, and no `shopee_api_call` in the server log.
* **No DB migration.**
* **Unchanged by this phase:** Ads stays READ ONLY. Legacy flags and sync jobs are untouched. The Claude assistant stays "Sắp có" (PA-4).
* **Route analytics:** the project has no route-analytics provider, so the `app_hub_opened`, `app_selected` and `app_switched` events are not emitted. None was added just for this.

## Tests

* **`src/lib/apps/apps.test.ts`** (in `npm test`):
  * registry;
  * live links resolve to real routes;
  * every page sits in its owner's group;
  * `appForPath`;
  * role → apps;
  * post-login rules;
  * domain-only sidebars;
  * flag visibility;
  * active item;
  * sync-health wording;
  * the zero-provider / no-write guards.
* **`scripts/e2e/app-shell-1.ts`** (Playwright, `next dev` + local Supabase):
  * auth (anonymous, deep link, plain login);
  * hub cards and statuses;
  * disabled cards;
  * keyboard;
  * Shopee shell;
  * switcher Shopee → accounting → hub;
  * direct route and active item;
  * Ads and product-analytics regression, legacy redirect, aliases;
  * coming-soon shell;
  * staff and viewer limits;
  * 390 px drawer;
  * dark mode;
  * reduced motion;
  * zero provider calls.
