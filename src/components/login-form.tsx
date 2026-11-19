"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { signIn } from "@/app/auth-actions";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function LoginForm() {
  const [error, submit, pending] = useActionState(signIn, "");
  const [visible, setVisible] = useState(false);
  return (
    <form action={submit} className="login-form">
      <label htmlFor="email">Work email</label>
      <Input
        id="email"
        name="email"
        type="email"
        autoComplete="username"
        placeholder="you@workplace.com.au"
        required
      />
      <label htmlFor="password">Password</label>
      <div className="password-field">
        <Input
          id="password"
          name="password"
          type={visible ? "text" : "password"}
          autoComplete="current-password"
          placeholder="Enter your password"
          required
        />
        <button
          type="button"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Button disabled={pending}>{pending ? "Signing in…" : "Sign in"}</Button>
    </form>
  );
}
