# Theo Dõi Hàng Về

## Mục tiêu

Hệ thống quản lý và theo dõi hàng về — giúp người dùng theo dõi trạng thái đơn hàng, lô hàng nhập về từ các nguồn cung cấp.

## Tech Stack

| Layer       | Technology          |
| ----------- | ------------------- |
| Framework   | Next.js 16 (App Router) |
| Language    | TypeScript          |
| Styling     | Tailwind CSS 4      |
| Linting     | ESLint 9            |
| Runtime     | Node.js             |
| Package Mgr | npm                 |

## Cấu trúc thư mục

```
theo-doi-hang-ve/
├── src/
│   └── app/
│       ├── layout.tsx      # Root layout
│       ├── page.tsx         # Trang chủ
│       ├── globals.css      # Global styles + Tailwind
│       └── favicon.ico
├── public/                  # Static assets
├── package.json
├── tsconfig.json
├── next.config.ts
├── eslint.config.mjs
└── postcss.config.mjs
```

## Chạy local

```bash
# Cài dependencies
npm install

# Chạy development server
npm run dev

# Mở trình duyệt tại http://localhost:3000
```

## Scripts

| Script          | Mô tả                    |
| --------------- | ------------------------- |
| `npm run dev`   | Chạy dev server           |
| `npm run build` | Build production          |
| `npm run start` | Chạy production server    |
| `npm run lint`  | Kiểm tra linting (ESLint) |
