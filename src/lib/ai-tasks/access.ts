// ============================================================
// PHASE 06 — task access, built ONLY from the Phase 03 scope (access.ts):
// a task belongs to its SOURCE conversation; whoever may read that
// conversation (owner / grant, role zalo_personal:use, active profile) may see
// the task, nobody else — admin included. Being in the Zalo group, or being
// named in a message, never grants anything.
// Cached per request / per tick (a fresh resolver every time: revocations take
// effect at the next check).
// ============================================================
import { hasPermission, isRole, type Role } from "../auth/permissions.ts";
import { buildScope, can, canReadConversation, type AccessScope } from "../zalo-personal/dashboard/access.ts";
import type { TaskRole } from "./lifecycle.ts";
import type { AccessStore, ProfileInfo } from "./store.ts";

export class TaskAccess {
  private readonly store: AccessStore;
  private readonly scopes = new Map<string, Promise<AccessScope | null>>();
  private readonly profileCache = new Map<string, Promise<ProfileInfo | null>>();

  constructor(store: AccessStore) {
    this.store = store;
  }

  profile(userId: string): Promise<ProfileInfo | null> {
    let p = this.profileCache.get(userId);
    if (!p) {
      p = this.store.profiles([userId]).then((r) => r[0] ?? null);
      this.profileCache.set(userId, p);
    }
    return p;
  }

  /** null = inactive profile or a role without the module */
  scope(userId: string): Promise<AccessScope | null> {
    let s = this.scopes.get(userId);
    if (!s) {
      s = (async () => {
        const p = await this.profile(userId);
        if (!p || !p.isActive || !isRole(p.role) || !hasPermission(p.role, "zalo_personal:use")) return null;
        const { connections, grants } = await this.store.loadAccess(userId);
        return buildScope({ userId, role: p.role as Role }, connections, grants);
      })();
      this.scopes.set(userId, s);
    }
    return s;
  }

  async canRead(userId: string, c: { id: string; connectionId: string; conversationType: "user" | "group" }): Promise<boolean> {
    const s = await this.scope(userId);
    return Boolean(s && canReadConversation(s, c));
  }

  /** owner or connection-wide manage grant — AND able to read this conversation */
  async isManager(userId: string, c: { id: string; connectionId: string; conversationType: "user" | "group" }): Promise<boolean> {
    const s = await this.scope(userId);
    return Boolean(s && canReadConversation(s, c) && can(s, c.connectionId, "manage_groups"));
  }

  async roleFor(userId: string, c: { id: string; connectionId: string; conversationType: "user" | "group" }, assigneeUserIds: readonly string[]): Promise<TaskRole> {
    if (!(await this.canRead(userId, c))) return "none";
    if (await this.isManager(userId, c)) return "manager";
    return assigneeUserIds.includes(userId) ? "assignee" : "reader";
  }
}
