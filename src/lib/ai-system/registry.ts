// ============================================================
// PHASE 05 — SystemToolRegistry: the ONLY tools the model may name.
//
// A tool is data + a typed run(): name, description, strict Zod input,
// required permissions, sensitivity, timeout, row limit, freshness and
// examples. The model never gets SQL, URLs or shell — it picks a registered
// name and proposes arguments, which are re-validated here.
// Pure (no "@/" imports).
// ============================================================
import { z } from "zod";

import type { SystemToolDefinition } from "./types.ts";

const NAME = /^[a-z][a-z_]{2,63}$/;

export class SystemToolRegistry {
  private readonly tools = new Map<string, SystemToolDefinition<unknown>>();

  register<A>(def: SystemToolDefinition<A>): this {
    if (!NAME.test(def.name)) throw new Error(`invalid tool name: ${def.name}`);
    if (this.tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
    if (!(def.timeoutMs >= 500 && def.timeoutMs <= 30_000)) throw new Error(`timeout out of range: ${def.name}`);
    if (!(def.maxRows >= 1 && def.maxRows <= 100)) throw new Error(`maxRows out of range: ${def.name}`);
    if (!def.description.trim() || !def.title.trim()) throw new Error(`missing description: ${def.name}`);
    this.tools.set(def.name, def as SystemToolDefinition<unknown>);
    return this;
  }

  get(name: string): SystemToolDefinition<unknown> | null {
    return this.tools.get(name) ?? null;
  }

  list(): SystemToolDefinition<unknown>[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}

/** JSON schema of a tool's arguments, for the model's catalogue (derived from the Zod schema: one source of truth). */
export function argsJsonSchema(def: SystemToolDefinition<unknown>): Record<string, unknown> {
  try {
    const s = z.toJSONSchema(def.input as z.ZodType, { unrepresentable: "any" }) as Record<string, unknown>;
    delete s.$schema;
    return s;
  } catch {
    return { type: "object" };
  }
}

export type ArgsValidation<A> = { ok: true; args: A } | { ok: false; issues: string[] };

/** Strict validation of model-proposed arguments (unknown keys, wrong types and out-of-range values are refused). */
export function validateArgs<A>(def: SystemToolDefinition<A>, raw: unknown): ArgsValidation<A> {
  const parsed = def.input.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, args: parsed.data };
  return { ok: false, issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`) };
}
