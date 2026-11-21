"use server";

import { createClient } from "@supabase/supabase-js";
import { supabaseConfig } from "@/lib/supabase/config";
import {
  currentKiosk,
  deviceDigest,
  deviceToken,
  kioskClient,
  pinKey,
  requestRestaurant,
  saveDevice,
  validUuid,
  clearKioskCookie,
  setupToken,
  saveSetup,
} from "@/lib/kiosk/server";
import {
  newToken,
  nextToken,
  pinVerifier,
  tokenDigest,
  validPin,
} from "@/lib/kiosk/crypto";

type Connection =
  | {
      status: "active";
      name: string;
      zone: string;
      challenge: string;
      locked: boolean;
    }
  | { status: "setup"; reason: string }
  | { status: "mismatch" }
  | { status: "offline" };
type Recorded = {
  status: "recorded";
  firstName: string;
  action: "in" | "out";
  at: string;
};
type Result =
  | Recorded
  | { status: "error"; message: string; challenge?: string }
  | { status: "uncertain" };

export async function connectKiosk(): Promise<Connection> {
  try {
    const workplace = await requestRestaurant();
    if (!workplace) return { status: "mismatch" };
    const token = await deviceToken();
    let reason =
      "Sign in as a workplace administrator to activate this browser.";
    if (token) {
      const current = await currentKiosk(tokenDigest(token));
      if (current && current.org !== workplace.id)
        return { status: "mismatch" };
      const successor = nextToken(token, pinKey());
      const { data, error } = await kioskClient().rpc("kiosk_heartbeat", {
        credential_digest: tokenDigest(token),
        successor: tokenDigest(successor),
      });
      if (error || !data) throw new Error();
      if (data.status === "active") {
        if (data.org !== workplace.id) return { status: "mismatch" };
        await saveDevice(data.renewed ? successor : token);
        return {
          status: "active",
          name: data.name,
          zone: data.zone,
          challenge: data.challenge,
          locked: !!data.locked,
        };
      } else if (data.status === "retired")
        reason =
          "This kiosk was revoked or expired. An administrator can activate it again.";
    }
    if (!(await setupToken())) await saveSetup(newToken());
    return { status: "setup", reason };
  } catch {
    return { status: "offline" };
  }
}

type Authorisation = {
  error?: string;
};
export async function authoriseKiosk(
  mode: "activate" | "exit",
  form: FormData,
): Promise<Authorisation> {
  const workplace = await requestRestaurant();
  if (!workplace || !["activate", "exit"].includes(mode))
    return { error: "Request unavailable." };
  const email = form.get("email"),
    password = form.get("password"),
    label = form.get("name") ?? "Workplace kiosk";
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !email.trim() ||
    !password ||
    typeof label !== "string" ||
    !label.trim() ||
    label.trim().length > 80
  )
    return { error: "Check your email, password and kiosk name." };
  const { url, key } = supabaseConfig();
  // Fresh password proof lives only in this request, never in the browser cookie jar.
  const proof = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  try {
    const { data, error } = await proof.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error || !data.user)
      return { error: "Sign-in failed. Check your administrator credentials." };
    const digest = await deviceDigest();
    const memberships = await proof
      .from("organisation_memberships")
      .select("role,organisations!inner(id,name)")
      .eq("user_id", data.user.id)
      .eq("active", true)
      .eq("role", "admin")
      .eq("organisation_id", workplace.id)
      .returns<
        { role: string; organisations: { id: string; name: string } }[]
      >();
    if (memberships.error) throw new Error();
    if (
      !memberships.data.some(
        (m) => m.role === "admin" && m.organisations.id === workplace.id,
      )
    )
      return {
        error: "An active workplace administrator account is required.",
      };
    if (mode === "exit") {
      const kiosk = digest && (await currentKiosk(digest));
      if (!kiosk || workplace.id !== kiosk.org)
        return {
          error:
            "An administrator of this kiosk’s workplace must authorise exit.",
        };
      const reply = await proof.rpc("exit_workplace_kiosk", {
        browser_digest: digest,
      });
      if (reply.error) throw new Error();
      await clearKioskCookie();
      return {};
    }
    const seed = await setupToken();
    if (!seed)
      return {
        error: "Activation form expired. Refresh this page and try again.",
      };
    const credential = nextToken(seed, pinKey());
    const reply = await proof.rpc("register_workplace_kiosk", {
      org: workplace.id,
      label: label.trim(),
      new_digest: tokenDigest(credential),
      old_digest: digest,
    });
    if (reply.error) throw new Error();
    await saveDevice(credential);
    await clearKioskCookie(true);
    return {};
  } catch {
    return {
      error:
        "Kiosk authorisation could not be confirmed. Refresh to check its status.",
    };
  } finally {
    await proof.auth.signOut({ scope: "local" });
  }
}

export async function clockWithPin(
  pin: string,
  attempt: string,
  submission: string,
): Promise<Result> {
  if (!validPin(pin) || !validUuid(attempt) || !validUuid(submission))
    return { status: "error", message: "Enter six digits on an active kiosk." };
  const digest = await deviceDigest();
  try {
    const workplace = await requestRestaurant();
    const context = workplace && digest && (await currentKiosk(digest));
    if (!context || context.org !== workplace.id)
      return {
        status: "error",
        message: "Kiosk access has ended. Check the device registration.",
      };
    if (context.locked)
      return {
        status: "error",
        message: "Too many incorrect PINs. Try again in ten minutes.",
      };
    const { data, error } = await kioskClient()
      .rpc("clock_with_pin", {
        credential_digest: digest,
        attempt_id: attempt,
        submission,
        pin_verifier: await pinVerifier(context.org, pin, pinKey()),
      })
      .retry(false);
    if (error || !data) return { status: "uncertain" };
    if (data.status === "recorded")
      return {
        status: "recorded",
        firstName: data.firstName,
        action: data.action,
        at: data.at,
      };
    const messages: Record<string, string> = {
      invalid: "PIN not recognised. Try again.",
      locked: "Too many incorrect PINs. Try again in ten minutes.",
      recent:
        "An attendance change was just recorded. No additional change was made.",
      stale:
        "This PIN screen was already used. Refresh it before entering another PIN.",
      unauthorised: "Kiosk access has ended. Contact your administrator.",
    };
    return {
      status: "error",
      message: messages[data.status] ?? "Please refresh the kiosk.",
      challenge: data.status === "invalid" ? data.challenge : undefined,
    };
  } catch {
    return { status: "uncertain" };
  }
}

export async function checkClockResult(
  attempt: string,
  submission: string,
): Promise<Recorded | null> {
  if (!validUuid(attempt) || !validUuid(submission)) return null;
  const digest = await deviceDigest();
  const workplace = await requestRestaurant();
  if (
    !workplace ||
    !digest ||
    (await currentKiosk(digest))?.org !== workplace.id
  )
    return null;
  const { data, error } = await kioskClient().rpc("kiosk_receipt", {
    credential_digest: digest,
    attempt_id: attempt,
    submission,
  });
  if (error) throw new Error("Receipt lookup unavailable.");
  return data;
}
