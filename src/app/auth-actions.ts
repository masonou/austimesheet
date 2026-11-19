"use server";

import { redirect } from "next/navigation";
import { serverClient } from "@/lib/supabase/server";

export async function signIn(_: string, form: FormData) {
  const email = form.get("email");
  const password = form.get("password");
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !email.trim() ||
    !password
  )
    return "Enter your email and password.";
  const client = await serverClient();
  const { error } = await client.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) return "Sign-in failed. Check your details and try again.";
  redirect("/workspace");
}

export async function signOut() {
  const client = await serverClient();
  const { error } = await client.auth.signOut({ scope: "local" });
  if (error) throw new Error("Could not sign out. Please try again.");
  redirect("/");
}
