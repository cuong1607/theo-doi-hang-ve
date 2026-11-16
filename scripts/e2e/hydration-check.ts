// Hydration regression check (APP-SHELL-1 / PA-4): signs in a throw-away admin, opens
// shell pages at 390 px and 1440 px, counts React hydration errors (must be 0).
//   node --env-file=.env.local scripts/e2e/hydration-check.ts   (dev server on :3100)
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
const BASE = "http://localhost:3100";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const email = `hyd${Date.now()}@example.test`, pw = "Pw-hyd-123456!";
const { data } = await db.auth.admin.createUser({ email, password: pw, email_confirm: true });
await db.from("profiles").update({ role: "admin", is_active: true }).eq("id", data.user!.id);
const b = await chromium.launch();
const errors: string[] = [];
try {
  for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const p = await (await b.newContext({ viewport: vp, isMobile: vp.width < 500 })).newPage();
    p.on("console", (m) => { if (m.type() === "error" && /Hydration|hydrat/i.test(m.text())) errors.push(`${vp.width}: ${m.text().slice(0, 90)}`); });
    p.on("pageerror", (e) => { if (/Hydration/i.test(e.message)) errors.push(`${vp.width} pageerror: ${e.message.slice(0, 90)}`); });
    await p.goto(`${BASE}/login`); await p.fill('input[name="email"]', email); await p.fill('input[name="password"]', pw);
    await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login")), p.click('button[type="submit"]')]);
    for (const path of ["/apps/shopee", "/dashboard", "/apps"]) { await p.goto(BASE + path); await p.waitForLoadState("networkidle"); }
  }
} finally { await b.close(); await db.auth.admin.deleteUser(data.user!.id); }
console.log(JSON.stringify({ hydrationErrors: errors.length, sample: errors.slice(0, 4) }));
