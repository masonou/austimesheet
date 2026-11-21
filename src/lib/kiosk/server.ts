import "server-only";
import { createClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { supabaseConfig } from "@/lib/supabase/config";
import { expectedHost, restaurantPath } from "@/lib/hosts";
import { tokenDigest } from "./crypto";

const cookieName = "__Host-shiftbook-kiosk";
export const validToken = (v: unknown): v is string =>
  typeof v === "string" && /^[\w-]{43}$/.test(v);
export const validUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(v);

export async function sameOrigin() {
  return expectedHost(await headers(), "app", true);
}

export async function requestRestaurant() {
  const h = await headers();
  if (!expectedHost(h, "kiosk", true)) return null;
  const slug = restaurantPath("/" + (h.get("x-shiftbook-restaurant") ?? ""));
  return slug ? restaurant(slug) : null;
}

export async function restaurant(
  slug: string,
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await kioskClient().rpc("kiosk_restaurant", {
    restaurant_slug: slug,
  });
  if (error) throw new Error("Restaurant lookup unavailable.");
  return data;
}

export function pinKey() {
  const key = process.env.SHIFTBOOK_PIN_PEPPER;
  if (!key || !/^[a-f0-9]{64}$/i.test(key))
    throw new Error("Kiosk PIN secret is missing or invalid.");
  return key;
}

// This client never receives user session cookies. Its callers use scoped kiosk RPCs.
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
    maxAge: 90 * 86400,
  });
}

export async function deviceToken() {
  const token = (await cookies()).get(cookieName)?.value;
  return validToken(token) ? token : null;
}
const setupName = "__Host-shiftbook-setup";
export async function setupToken() {
  const token = (await cookies()).get(setupName)?.value;
  return validToken(token) ? token : null;
}
export async function saveSetup(token: string) {
  (await cookies()).set(setupName, token, {
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 900,
  });
}
export async function clearKioskCookie(setupOnly = false) {
  const jar = await cookies();
  for (const name of setupOnly ? [setupName] : [setupName, cookieName])
    jar.set(name, "", {
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });
}
export async function deviceDigest() {
  const token = await deviceToken();
  return token ? tokenDigest(token) : null;
}

export function encryptionKey() {
  const key = process.env.SHIFTBOOK_PIN_ENCRYPTION_KEY;
  if (
    !key ||
    !/^[0-9a-f]{64}$/i.test(key) ||
    key.toLowerCase() === pinKey().toLowerCase()
  )
    throw new Error("A separate PIN encryption key is required.");
  return key;
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
