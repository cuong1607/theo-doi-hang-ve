// ============================================================
// PHASE AUTHENTICATION AND AUTHORIZATION — database-level tests against the
// real Supabase cloud project, using REAL user sessions (anon key + the
// user's JWT, exactly what a browser could send directly to PostgREST):
//
//   node --env-file=.env.local --test src/lib/auth/auth.integration.test.ts
//
// Creates throwaway auth users (authtest+<tag>-*@example.com, confirmed via
// the admin API — no email is sent) and deletes them in `after`.
// Admin-specific cases only run when a real active admin already exists,
// because the last-active-admin guard (correctly) makes a sole test admin
// impossible to delete afterwards.
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) {
  throw new Error("Thiếu biến môi trường Supabase. Chạy với `node --env-file=.env.local --test ...`.");
}
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(url, serviceKey, opts);
const anon = createClient(url, anonKey, opts);

const TAG = `${Date.now()}`;
const PASSWORD = `T3st-${TAG}-pw!`;
const created: string[] = [];
const users: Record<string, { id: string; client: SupabaseClient }> = {};
let realAdminExists = false;

async function makeUser(name: string, opts2: { provisioned: boolean; role?: "admin" | "staff" | "viewer" }) {
  const email = `authtest+${TAG}-${name}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: `Auth test ${name}` },
    app_metadata: opts2.provisioned ? { provisioned_by_admin: true } : {},
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  created.push(data.user.id);
  // Same as the /users createUser action: the trigger makes an inactive
  // viewer, the admin path activates it with the chosen role.
  if (opts2.provisioned) {
    const { error: e } = await admin
      .from("profiles")
      .update({ role: opts2.role ?? "viewer", is_active: true })
      .eq("id", data.user.id);
    if (e) throw e;
  }
  const client = createClient(url!, anonKey!, opts);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw signInError;
  users[name] = { id: data.user.id, client };
}

before(async () => {
  const { count } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin")
    .eq("is_active", true);
  realAdminExists = (count ?? 0) > 0;

  await makeUser("viewer", { provisioned: true });
  await makeUser("staff", { provisioned: true, role: "staff" });
  await makeUser("selfsignup", { provisioned: false });
  if (realAdminExists) await makeUser("admin", { provisioned: true, role: "admin" });
});

after(async () => {
  for (const id of created) {
    await admin.auth.admin.deleteUser(id);
  }
});

test("admin-provisioned user: profile active with the chosen role, full_name from metadata", async () => {
  const { data } = await admin.from("profiles").select("role, is_active, full_name").eq("id", users.viewer.id).single();
  assert.deepEqual(data, { role: "viewer", is_active: true, full_name: "Auth test viewer" });
});

test("profile auto-created for ANY new auth user (signup/dashboard) => inactive viewer, never admin", async () => {
  const { data } = await admin.from("profiles").select("role, is_active").eq("id", users.selfsignup.id).single();
  assert.deepEqual(data, { role: "viewer", is_active: false });
});

test("active viewer JWT: can read business tables, cannot write any of them", async () => {
  const c = users.viewer.client;
  const { data: suppliers, error } = await c.from("suppliers").select("id").limit(1);
  assert.equal(error, null);
  assert.equal(suppliers!.length, 1, "active user reads business data");

  const ins = await c.from("suppliers").insert({ code: `AUTHTEST_${TAG}`, name: "x", supplier_type: "company" });
  assert.ok(ins.error, "insert denied");
  const upd = await c.from("receipts").update({ note: "hack" }).neq("id", "00000000-0000-0000-0000-000000000000");
  assert.ok(upd.error, "update denied");
  const del = await c.from("invoice_items").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  assert.ok(del.error, "delete denied");
});

test("viewer/staff cannot call mutation RPCs directly (service_role only)", async () => {
  for (const name of ["viewer", "staff"]) {
    const { error } = await users[name].client.rpc("create_receipt", {
      p_receipt_date: "2031-01-01", p_shift: "morning", p_supplier_id: "00000000-0000-0000-0000-000000000000",
      p_receiver_name: "x", p_note: null, p_created_by: null, p_items: [],
    });
    assert.ok(error, `${name}: create_receipt denied`);
  }
});

test("user cannot change their own role or re-activate their own account", async () => {
  const promote = await users.viewer.client.from("profiles").update({ role: "admin" }).eq("id", users.viewer.id);
  assert.ok(promote.error, "self-promotion denied");
  const reactivate = await users.selfsignup.client
    .from("profiles")
    .update({ is_active: true })
    .eq("id", users.selfsignup.id);
  assert.ok(reactivate.error, "self re-activation denied");
  const { data } = await admin.from("profiles").select("role, is_active").in("id", [users.viewer.id, users.selfsignup.id]);
  assert.ok(data!.every((p) => p.role === "viewer"));
  assert.equal(data!.find((p) => p.role && p.is_active === false) !== undefined, true);
});

test("inactive user's JWT sees no business data, but can read their own profile", async () => {
  const c = users.selfsignup.client;
  const { data: suppliers } = await c.from("suppliers").select("id").limit(5);
  assert.equal(suppliers?.length ?? 0, 0);
  const { data: outstanding } = await c.from("v_outstanding").select("invoice_item_id").limit(5);
  assert.equal(outstanding?.length ?? 0, 0, "views respect RLS (security_invoker)");
  const { data: own } = await c.from("profiles").select("is_active").eq("id", users.selfsignup.id).single();
  assert.equal(own!.is_active, false);
});

test("deactivating an account cuts off data access on the very next request", async () => {
  await admin.from("profiles").update({ is_active: false }).eq("id", users.staff.id);
  try {
    const { data } = await users.staff.client.from("receipts").select("id").limit(1);
    assert.equal(data?.length ?? 0, 0);
  } finally {
    await admin.from("profiles").update({ is_active: true }).eq("id", users.staff.id);
  }
});

test("anon key alone: no table or view readable", async () => {
  for (const rel of ["suppliers", "receipts", "profiles", "v_outstanding", "v_invoice_debt", "notification_recipients"]) {
    const { data, error } = await anon.from(rel).select("*").limit(1);
    assert.ok(error || (data ?? []).length === 0, rel);
  }
});

test("profiles: non-admin sees only their own row; notification tables are admin-only", async () => {
  const { data: profiles } = await users.staff.client.from("profiles").select("id");
  assert.deepEqual(profiles!.map((p) => p.id), [users.staff.id]);
  const { data: recipients } = await users.staff.client.from("notification_recipients").select("id");
  assert.equal(recipients!.length, 0);
});

test("admin JWT: reads all profiles and notification recipients (needs a real admin to exist)", async (t) => {
  if (!realAdminExists) return t.skip("no real active admin yet (run npm run auth:create-admin)");
  const { data: profiles } = await users.admin.client.from("profiles").select("id");
  assert.ok(profiles!.length >= 4);
  const { error } = await users.admin.client.from("notification_recipients").select("id");
  assert.equal(error, null);
  // Even an admin can't write through PostgREST — only via server actions.
  const { error: writeError } = await users.admin.client.from("profiles").update({ full_name: "x" }).eq("id", users.viewer.id);
  assert.ok(writeError);
});

test("last-active-admin guard allows demoting an admin while another active admin remains", async (t) => {
  if (!realAdminExists) return t.skip("no real active admin yet");
  const { error } = await admin.from("profiles").update({ role: "staff" }).eq("id", users.admin.id);
  assert.equal(error, null);
});
