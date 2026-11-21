import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseConfig } from "./config";

export function serviceClient() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("Supabase server credential is missing.");
  return createClient(supabaseConfig().url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: (url, init) => fetch(url, { ...init, cache: "no-store" }),
    },
  });
}
