import "server-only";
import { createClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { supabaseConfig } from "@/lib/supabase/config";
import { tokenDigest } from "./crypto";

const cookieName = "__Host-shiftbook-kiosk";
export const validToken = (v: unknown): v is string =>
  typeof v === "string" && /^[\w-]{43}$/.test(v);
export const validUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(v);

export async function sameOrigin() {
  const h = await headers();
  try {
    const origin = new URL(h.get("origin") || "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    return (
      origin.host === h.get("host") &&
      (origin.protocol === "https:" || (local && origin.protocol === "http:"))
    );
  } catch {
    return false;
  }
}

export function pinKey() {
  const key = process.env.SHIFTBOOK_PIN_PEPPER;
  if (!key || !/^[a-f0-9]{64}$/i.test(key))
    throw new Error("Kiosk PIN secret is missing or invalid.");
  return key;
}

// This client never receives user session cookies. Only the three bounded kiosk
// RPCs below and in kiosk/actions.ts use it.
export function kioskClient() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("Kiosk server credential is missing.");
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

export async function saveDevice(token: string) {
  (await cookies()).set(cookieName, token, {
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 30 * 86400,
  });
}

export async function deviceDigest() {
  const token = (await cookies()).get(cookieName)?.value;
  return validToken(token) ? tokenDigest(token) : null;
}

export type KioskContext = {
  org: string;
  name: string;
  zone: string;
  challenge: string;
  locked: boolean | null;
};
export async function currentKiosk(
  digest: string,
): Promise<KioskContext | null> {
  const { data, error } = await kioskClient().rpc("kiosk_context", {
    credential_digest: digest,
  });
  if (error) throw new Error("Kiosk connection unavailable.");
  return data;
}
