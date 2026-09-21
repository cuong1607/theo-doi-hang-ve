# Theo Dõi Hàng Về

## Mục tiêu

Hệ thống quản lý và theo dõi hàng về — giúp người dùng theo dõi trạng thái đơn hàng, lô hàng nhập về từ các nguồn cung cấp.

## Tech Stack

| Layer       | Technology              |
| ----------- | ----------------------- |
| Framework   | Next.js 16 (App Router) |
| Language    | TypeScript              |
| Styling     | Tailwind CSS 4          |
| UI          | shadcn/ui (base-nova)   |
| Database    | Supabase (PostgreSQL)   |
| Auth        | Supabase Auth           |
| Linting     | ESLint 9                |
| Runtime     | Node.js                 |
| Package Mgr | npm                     |

## Thiết lập môi trường

### 1. Cài dependencies

```bash
npm install
```

### 2. Tạo file `.env.local`

Copy file `.env.example` và điền thông tin Supabase project:

```bash
cp .env.example .env.local
```

Mở `.env.local` và điền giá trị:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

**Cách lấy giá trị:**
1. Truy cập [Supabase Dashboard](https://supabase.com/dashboard)
2. Chọn project của bạn
3. Vào **Settings** → **API**
4. Copy **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
5. Copy **anon public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`

> ⚠️ **Không commit file `.env.local`** vào git. File này đã được thêm trong `.gitignore`.

### 3. Kiểm tra kết nối Supabase

Chạy dev server và truy cập health check:

```bash
npm run dev
# Mở http://localhost:3000/api/health
```

Nếu thành công, bạn sẽ thấy:

```json
{
  "status": "ok",
  "message": "Supabase client khởi tạo thành công.",
  "env": {
    "NEXT_PUBLIC_SUPABASE_URL": true,
    "NEXT_PUBLIC_SUPABASE_ANON_KEY": true
  },
  "supabaseUrl": "https://your-project-id.supabase.co"
}
```

## Scripts

| Script          | Mô tả                    |
| --------------- | ------------------------- |
| `npm run dev`   | Chạy dev server           |
| `npm run build` | Build production          |
| `npm run start` | Chạy production server    |
| `npm run lint`  | Kiểm tra linting (ESLint) |
