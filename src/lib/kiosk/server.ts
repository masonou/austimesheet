import "server-only";
import { createClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { supabaseConfig } from "@/lib/supabase/config";
import { serverClient } from "@/lib/supabase/server";
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
export async function registeredHere() {
  const digest = await deviceDigest();
  return digest ? await currentKiosk(digest) : null;
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

async function projectAuthCookies() {
  // Includes chunked SSR auth cookies. Fail closed even if a stale staff session
  // cannot be refreshed while the shared device is being prepared.
  const prefix =
    "sb-" +
    new URL(supabaseConfig().url).hostname.split(".")[0] +
    "-auth-token";
  return (await cookies())
    .getAll()
    .filter(
      (c) =>
        (c.name === prefix ||
          (c.name.startsWith(prefix + ".") &&
            /^\d+$/.test(c.name.slice(prefix.length + 1)))) &&
        c.value,
    );
}
export async function hasStaffCookies() {
  return (await projectAuthCookies()).length > 0;
}
export async function endBrowserSession() {
  if (!(await hasStaffCookies())) return;
  const { error } = await (
    await serverClient()
  ).auth.signOut({ scope: "local" });
  if (
    error &&
    ![401, 403, 404].includes(error.status ?? 0) &&
    error.code !== "refresh_token_not_found" &&
    error.name !== "AuthSessionMissingError"
  )
    throw new Error("Local sign-out unavailable.");
  const jar = await cookies();
  for (const c of await projectAuthCookies()) jar.delete(c.name);
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
