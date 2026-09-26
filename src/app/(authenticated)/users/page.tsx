import { requirePermission } from "@/lib/auth/session";
import { ROLE_LABELS, isRole, type Role } from "@/lib/auth/permissions";
import { displayLogin } from "@/lib/auth/login-identifier";
import { createAdminClient } from "@/lib/supabase/admin";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { CreateUserButton } from "./create-user-button";
import { UserRowActions } from "./user-row-actions";

export const dynamic = "force-dynamic";

type UserRow = {
  id: string;
  email: string;
  fullName: string | null;
  role: Role;
  isActive: boolean;
  createdAt: string;
  lastSignInAt: string | null;
};

function formatDateVN(iso: string) {
  return new Date(iso).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

// Internal tool: a handful of accounts. One page of listUsers (up to 1000)
// + all profiles, merged in memory — no N+1.
async function getUsers(): Promise<{ rows: UserRow[]; error: boolean }> {
  const supabase = createAdminClient();
  const [{ data: authData, error: authError }, { data: profiles, error: profileError }] = await Promise.all([
    supabase.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    supabase.from("profiles").select("id, full_name, role, is_active, created_at"),
  ]);
  if (authError || profileError) return { rows: [], error: true };

  const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]));
  const rows = authData.users.map((u) => {
    const p = byId.get(u.id);
    return {
      id: u.id,
      email: u.email ? displayLogin(u.email) : "—",
      fullName: (p?.full_name as string | null) ?? null,
      role: isRole(p?.role) ? p.role : "viewer",
      isActive: !!p?.is_active,
      createdAt: (p?.created_at as string | undefined) ?? u.created_at,
      lastSignInAt: u.last_sign_in_at ?? null,
    } satisfies UserRow;
  });
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { rows, error: false };
}

export default async function UsersPage() {
  const auth = await requirePermission("user:manage");
  const { rows, error } = await getUsers();
  const activeAdminCount = rows.filter((r) => r.role === "admin" && r.isActive).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Người dùng</h2>
          <p className="text-muted-foreground">
            Quản lý tài khoản, vai trò và trạng thái. Hệ thống nội bộ — tài khoản do quản trị viên tạo.
          </p>
        </div>
        <CreateUserButton />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Danh sách người dùng
            <Badge variant="secondary">{rows.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="py-8 text-center text-sm text-destructive">Đã xảy ra lỗi khi tải danh sách người dùng.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Họ tên</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Vai trò</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Ngày tạo</TableHead>
                  <TableHead className="text-right">Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      Chưa có dữ liệu.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((u) => {
                    const isSelf = u.id === auth.user.id;
                    const isLastActiveAdmin = u.role === "admin" && u.isActive && activeAdminCount <= 1;
                    return (
                      <TableRow key={u.id}>
                        <TableCell className="font-medium">
                          {u.fullName || "—"}
                          {isSelf && <span className="ml-1 text-xs text-muted-foreground">(bạn)</span>}
                        </TableCell>
                        <TableCell>{u.email}</TableCell>
                        <TableCell>
                          <Badge variant={u.role === "admin" ? "default" : "outline"}>{ROLE_LABELS[u.role]}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={u.isActive ? "secondary" : "destructive"}>
                            {u.isActive ? "Hoạt động" : "Đã vô hiệu hóa"}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatDateVN(u.createdAt)}</TableCell>
                        <TableCell className="text-right">
                          <UserRowActions
                            user={{ id: u.id, email: u.email, role: u.role, isActive: u.isActive }}
                            isLastActiveAdmin={isLastActiveAdmin}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
