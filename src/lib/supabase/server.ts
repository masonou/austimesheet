import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseConfig } from "./config";

export async function serverClient() {
  const jar = await cookies();
  const { url, key } = supabaseConfig();
  return createServerClient(url, key, {
    global: {
      fetch: (url, init) => fetch(url, { ...init, cache: "no-store" }),
    },
    cookies: {
      getAll: () => jar.getAll(),
      setAll(updates) {
        try {
          for (const { name, value, options } of updates)
            jar.set(name, value, options);
        } catch {
          // Server Components cannot write cookies. Proxy refreshes before rendering.
        }
      },
    },
  });
}
