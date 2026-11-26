import type { Metadata } from "next";
import { CheckCircle2, Circle, Plug, Terminal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/patterns/callout";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer, PageHeader, SectionHeader } from "@/components/patterns/page-header";
import { AccessManager } from "@/components/zalo-personal/access-manager";
import { NewConnectionButton, OwnerConnectionActions } from "@/components/zalo-personal/connection-setup";
import { HealthBadge, HeartbeatAge, LISTENER_LABEL, SESSION_LABEL, SituationCallout } from "@/components/zalo-personal/health";
import { formatDateTime } from "@/lib/ui/format";
import { canConnect } from "@/lib/zalo-personal/dashboard/self-service";
import { requireZaloPersonal, unwrap } from "@/lib/zalo-personal/dashboard/server";
import { AUDIT_LABEL, listAudit, listConnections, listGrants, type ConnectionView } from "@/lib/zalo-personal/dashboard/service";

export const metadata: Metadata = { title: "Zalo cá nhân — Kết nối" };
export const dynamic = "force-dynamic";

const DM_LABEL = { off: "Không lưu", metadata: "Chỉ metadata (không lưu nội dung)", linked: "Chỉ lưu nội dung của người đã liên kết", content: "Lưu nội dung mọi người" } as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words sm:text-right">{children}</dd>
    </div>
  );
}

/** Setup checklist for the owner: what is done, what is next (from real signals only). */
function Checklist({ c }: { c: ConnectionView }) {
  const w = c.workers.find((x) => x.status === "active");
  const steps = [
    { done: true, text: "Tạo kết nối" },
    { done: !!w, text: "Cấp worker và cài trên máy Windows (cấu hình + secret)" },
    { done: !!w?.lastHeartbeatAt, text: "Worker gửi heartbeat đầu tiên (npm run start)" },
    { done: w?.sessionState === "authenticated", text: "Đăng nhập Zalo trên máy Windows (npm run login, quét QR)" },
    { done: w?.listenerState === "active" && !!c.accountIdMasked, text: "Listener đang nhận tin, tài khoản Zalo đã gắn" },
  ];
  const next = steps.findIndex((x) => !x.done);
  return (
    <ol className="space-y-1 text-sm" aria-label="Các bước kết nối">
      {steps.map((x, i) => (
        <li key={x.text} className={`flex items-center gap-2 ${x.done ? "text-muted-foreground" : i === next ? "font-medium" : "text-muted-foreground"}`}>
          {x.done ? <CheckCircle2 aria-hidden="true" className="size-4 text-success" /> : <Circle aria-hidden="true" className="size-4" />}
          {x.text}
          {i === next && <Badge variant="outline">Bước tiếp theo</Badge>}
        </li>
      ))}
    </ol>
  );
}

function backendText(c: ConnectionView): string {
  const w = c.workers.find((x) => x.status === "active");
  if (!w) return "—";
  const depth = w.outboxDepth ?? 0;
  const dead = w.deadLetterCount ?? 0;
  const ok = w.lastDeliveryOkAt ? `gửi thành công lúc ${formatDateTime(w.lastDeliveryOkAt)}` : "chưa gửi thành công lần nào";
  return `${ok} · outbox ${depth} · dead-letter ${dead}`;
}

// ZP-25: separate signals (worker online / Zalo session / listener / backend delivery),
// never a single "connected". No cookie, token, session or QR is ever shown. There is no
// remote command channel in Phase 01/02, so there is no disconnect button: the
// instructions for the Windows machine are shown instead.
export default async function ZaloPersonalConnectionsPage() {
  const { actor, deps, onboarding } = await requireZaloPersonal({ setupPage: true });
  const connections = onboarding ? [] : unwrap(await listConnections(deps, actor));
  const mayConnect = canConnect(actor.role);
  const owned = connections.filter((c) => c.isOwner).length;
  const extras = await Promise.all(
    connections.map(async (c) => ({
      id: c.id,
      access: c.capabilities.manageAccess ? unwrap(await listGrants(deps, actor, c.id)) : null,
      audit: c.capabilities.viewAudit ? unwrap(await listAudit(deps, actor, c.id)) : null,
    })),
  );

  return (
    <PageContainer>
      <PageHeader
        title="Kết nối Zalo cá nhân"
        description="Mỗi kết nối là một tài khoản Zalo cá nhân chạy qua worker trên máy Windows. Tạo kết nối và cấp worker ngay tại đây; đăng nhập Zalo (quét QR) làm trên máy Windows."
        actions={mayConnect && connections.length > 0 ? <NewConnectionButton variant="outline" disabled={owned >= 3} /> : undefined}
      />

      {connections.length === 0 &&
        (mayConnect ? (
          <EmptyState
            icon={Plug}
            title="Kết nối tài khoản Zalo cá nhân của bạn"
            description="1) Tạo kết nối và cấp worker tại đây → 2) cài cấu hình + secret trên máy Windows → 3) quét QR đăng nhập Zalo trên máy đó. Kết nối thuộc về bạn: người khác chỉ xem được khi bạn cấp quyền."
            action={<NewConnectionButton />}
          />
        ) : (
          <EmptyState icon={Plug} title="Chưa có kết nối nào bạn được xem" description="Chủ sở hữu kết nối có thể cấp quyền cho bạn ở trang này." />
        ))}

      {connections.map((c) => {
        const extra = extras.find((e) => e.id === c.id);
        const w = c.workers.find((x) => x.status === "active") ?? c.workers[0];
        return (
          <section key={c.id} className="space-y-4" aria-labelledby={`conn-${c.id}`}>
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle id={`conn-${c.id}`} className="flex flex-wrap items-center gap-2">
                  {c.connectionKey}
                  <Badge variant="outline">{c.accessLabel}</Badge>
                </CardTitle>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <HeartbeatAge health={c.health} />
                  <HealthBadge health={c.health} />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {c.isOwner && mayConnect && (
                  <div className="grid gap-4 rounded-lg border bg-muted/20 p-3 md:grid-cols-2">
                    <Checklist c={c} />
                    <OwnerConnectionActions connectionId={c.id} connectionKey={c.connectionKey} status={c.status} workers={c.workers.map((w) => ({ id: w.id, workerKey: w.workerKey, status: w.status }))} />
                  </div>
                )}
                <SituationCallout health={c.health} />
                <div className="grid gap-x-8 md:grid-cols-2">
                  <dl className="divide-y text-sm">
                    <Row label="Tên tài khoản Zalo">{c.accountDisplayName ?? "— (Phase 02 không lưu tên hiển thị)"}</Row>
                    <Row label="Zalo account ID">{c.accountIdMasked ?? "chưa gắn (chờ heartbeat đầu)"}</Row>
                    <Row label="Worker ID">{c.workers.length ? c.workers.map((x) => `${x.workerKey}${x.status === "revoked" ? " (đã thu hồi)" : ""}`).join(", ") : "chưa cấp worker"}</Row>
                    <Row label="Trạng thái kết nối">{c.status === "active" ? "Đang bật" : "Đã tắt"}</Row>
                    {c.ownerName && <Row label="Chủ sở hữu">{c.ownerName}</Row>}
                    {c.directMessageMode && <Row label="Tin 1-1">{DM_LABEL[c.directMessageMode]}</Row>}
                  </dl>
                  <dl className="divide-y text-sm">
                    <Row label="Phiên đăng nhập Zalo">{w ? (SESSION_LABEL[w.sessionState] ?? w.sessionState) : "—"}</Row>
                    <Row label="Listener">{w ? (LISTENER_LABEL[w.listenerState] ?? w.listenerState) : "—"}</Row>
                    <Row label="Kết nối tới backend">{backendText(c)}</Row>
                    <Row label="Heartbeat cuối">{formatDateTime(c.lastHeartbeatAt)}</Row>
                    <Row label="Lần ingest thành công cuối">{formatDateTime(c.lastIngestedAt)}</Row>
                    <Row label="Nhóm lỗi gần nhất">{c.lastErrorCategory ?? w?.lastErrorCategory ?? "—"}</Row>
                  </dl>
                </div>
                <Callout tone="neutral" icon={Terminal} title="Đăng nhập / ngắt kết nối: thao tác trên máy Windows">
                  <ul className="list-disc space-y-0.5 pl-4">
                    <li>
                      Trong <code>services/zalo-personal-worker</code>: <code>npm run status</code> (xem trạng thái), <code>npm run stop</code> (dừng an toàn), <code>npm run logout</code> (đăng xuất, xóa phiên).
                    </li>
                    <li>
                      Đăng nhập lại: <code>npm run login</code> rồi quét QR bằng điện thoại. QR không bao giờ được gửi lên dashboard.
                    </li>
                    <li>Chưa có kênh lệnh từ xa an toàn giữa dashboard và worker, nên dashboard không có nút ngắt kết nối.</li>
                  </ul>
                </Callout>
              </CardContent>
            </Card>

            {extra?.access && (
              <Card>
                <CardHeader>
                  <SectionHeader title="Quyền truy cập" description="Chỉ bạn (chủ sở hữu) quản lý. Mặc định không ai khác — kể cả quản trị viên — xem được kết nối này." />
                </CardHeader>
                <CardContent>
                  <AccessManager connectionId={c.id} grants={extra.access.grants} candidates={extra.access.candidates} conversations={extra.access.conversations} />
                </CardContent>
              </Card>
            )}

            {extra?.audit && (
              <Card>
                <CardHeader>
                  <SectionHeader title="Nhật ký thay đổi" description="Đổi chế độ nhóm, ghi nhận / rút lại đồng ý, cấp / thu hồi quyền (50 mục gần nhất, không sửa được)." />
                </CardHeader>
                <CardContent>
                  {extra.audit.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Chưa có thay đổi nào.</p>
                  ) : (
                    <ol className="divide-y text-sm">
                      {extra.audit.map((a) => (
                        <li key={a.id} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between">
                          <span>
                            <span className="font-medium">{AUDIT_LABEL[a.action] ?? a.action}</span>
                            {typeof a.details.from === "string" && typeof a.details.to === "string" && (
                              <span className="text-muted-foreground">
                                {" "}
                                ({a.details.from} → {a.details.to})
                              </span>
                            )}
                            {typeof a.details.level === "string" && <span className="text-muted-foreground"> · mức {a.details.level}</span>}
                          </span>
                          <span className="text-muted-foreground tabular-nums">
                            {a.actorName ?? "—"} · {formatDateTime(a.createdAt)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </CardContent>
              </Card>
            )}
          </section>
        );
      })}
    </PageContainer>
  );
}
