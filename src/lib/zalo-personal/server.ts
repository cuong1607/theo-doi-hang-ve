// ZALO PERSONAL Phase 02 — server wiring of the ingestion endpoints:
// service-role store + worker-secret decryption (APP_ENCRYPTION_KEY, AAD
// bound to the worker id). The service-role key stays on the server; the
// worker only ever holds its own HMAC secret.
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, parseEncryptionKey } from "@/lib/security/secrets";

import { getZaloPersonalIngestConfig, workerSecretContext } from "./config.ts";
import type { IngestDeps } from "./ingest.ts";
import { secretKeyBytes } from "./signing.ts";
import { SupabaseZaloPersonalStore } from "./supabase-store.ts";

export function getZaloPersonalIngestDeps(): IngestDeps {
  const config = getZaloPersonalIngestConfig();
  return {
    config,
    store: new SupabaseZaloPersonalStore(createAdminClient()),
    secretKey: (worker) => secretKeyBytes(decryptSecret(worker.secretEncrypted, parseEncryptionKey(process.env.APP_ENCRYPTION_KEY), workerSecretContext(worker.id))),
  };
}
