// ZALO PERSONAL Phase 03 — tiny fetch helper for the dashboard client components.
// Same-origin only; the session cookie authenticates; the server re-authorizes everything.
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; message: string };

export async function callApi<T>(url: string, init?: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown }): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; data?: T; error?: string; errorMessage?: string } | null;
    if (res.ok && json?.success) return { ok: true, data: json.data as T };
    return { ok: false, status: res.status, error: json?.error ?? "server_error", message: json?.errorMessage ?? "Có lỗi khi kết nối máy chủ. Vui lòng thử lại." };
  } catch {
    return { ok: false, status: 0, error: "network", message: "Không kết nối được máy chủ. Kiểm tra mạng và thử lại." };
  }
}
