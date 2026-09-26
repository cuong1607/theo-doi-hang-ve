import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const envCheck = {
    NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };

  const allEnvSet = Object.values(envCheck).every(Boolean);

  if (!allEnvSet) {
    return Response.json(
      {
        status: "error",
        message: "Thiếu biến môi trường Supabase. Kiểm tra .env.local.",
        env: envCheck,
      },
      { status: 500 }
    );
  }

  try {
    const supabase = await createClient();

    // Gọi một query đơn giản để kiểm tra kết nối
    // Dùng auth.getUser() vì nó không cần table nào tồn tại
    const { error } = await supabase.auth.getUser();

    // PGRST116 hoặc không có session đều OK — chỉ cần client khởi tạo được
    // (Public endpoint: a request without a session is the normal case.)
    if (error && error.code !== "PGRST116" && error.status !== 401 && error.name !== "AuthSessionMissingError") {
      return Response.json(
        {
          status: "error",
          message: "Supabase client khởi tạo được nhưng có lỗi kết nối.",
          error: error.message,
        },
        { status: 500 }
      );
    }

    return Response.json({
      status: "ok",
      message: "Supabase client khởi tạo thành công.",
      env: envCheck,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    });
  } catch (e) {
    return Response.json(
      {
        status: "error",
        message: "Không thể khởi tạo Supabase client.",
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
