// ZALO PERSONAL Phase 02 — ZaloPersonalStore on Supabase (service-role
// client injected; tables + functions of migration 00073). No "server-only"
// marker so integration tests and scripts can import it.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventResult, Heartbeat, IngestEvent } from "./contracts.ts";
import type { Endpoint, StoreError, WorkerRecord, ZaloPersonalStore } from "./ingest.ts";

function check(error: { code?: string } | null, what: string): void {
  if (error) throw new Error(`zalo-personal store: ${what} failed (${error.code ?? "?"})`);
}

export class SupabaseZaloPersonalStore implements ZaloPersonalStore {
  private readonly db: SupabaseClient;

  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async findWorker(workerKey: string): Promise<WorkerRecord | null> {
    const { data, error } = await this.db
      .from("zalo_personal_workers")
      .select("id, worker_key, status, secret_encrypted, zalo_personal_connections!inner(connection_key, status)")
      .eq("worker_key", workerKey)
      .maybeSingle();
    check(error, "findWorker");
    if (!data) return null;
    const conn = data.zalo_personal_connections as unknown as { connection_key: string; status: "active" | "disabled" };
    return { id: data.id, workerKey: data.worker_key, status: data.status, secretEncrypted: data.secret_encrypted, connectionKey: conn.connection_key, connectionStatus: conn.status };
  }

  async registerRequest(workerId: string, nonce: string, endpoint: Endpoint, maxPerWindow: number, windowSeconds: number) {
    const { data, error } = await this.db.rpc("zp_register_request", { p_worker_id: workerId, p_nonce: nonce, p_endpoint: endpoint, p_max_per_window: maxPerWindow, p_window_seconds: windowSeconds });
    check(error, "registerRequest");
    return data as "ok" | "nonce_reused" | "rate_limited";
  }

  async ingest(workerId: string, accountId: string, events: IngestEvent[]) {
    const { data, error } = await this.db.rpc("zp_ingest_events", { p_worker_id: workerId, p_account_id: accountId, p_events: events });
    check(error, "ingest");
    const res = data as { ok: boolean; error?: StoreError; results?: EventResult[] };
    return res.ok ? { ok: true as const, results: res.results ?? [] } : { ok: false as const, error: res.error ?? "invalid_payload" };
  }

  async heartbeat(workerId: string, accountId: string | null, state: Omit<Heartbeat, "v" | "connectionKey" | "accountId">) {
    const { data, error } = await this.db.rpc("zp_record_heartbeat", { p_worker_id: workerId, p_account_id: accountId, p_state: state });
    check(error, "heartbeat");
    const res = data as { ok: boolean; error?: StoreError; serverTime?: string };
    return res.ok ? { ok: true as const, serverTime: res.serverTime ?? new Date().toISOString() } : { ok: false as const, error: res.error ?? "invalid_payload" };
  }
}
