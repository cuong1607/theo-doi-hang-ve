"use client";

import { useActionState } from "react";

import { login, type LoginState } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const initialState: LoginState = { status: "idle" };

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, isPending] = useActionState(login, initialState);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          Tài khoản
        </label>
        <Input
          id="email"
          name="email"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          placeholder="Tên đăng nhập hoặc email"
          defaultValue={state.email}
          aria-invalid={!!state.fieldErrors?.email}
          required
        />
        {state.fieldErrors?.email && <p className="text-xs text-destructive">{state.fieldErrors.email[0]}</p>}
      </div>
      <div className="space-y-2">
        <label htmlFor="password" className="text-sm font-medium">
          Mật khẩu
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          aria-invalid={!!state.fieldErrors?.password}
          required
        />
        {state.fieldErrors?.password && (
          <p className="text-xs text-destructive">{state.fieldErrors.password[0]}</p>
        )}
      </div>
      {state.message && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? "Đang đăng nhập..." : "Đăng nhập"}
      </Button>
    </form>
  );
}
