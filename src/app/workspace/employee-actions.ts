"use server";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/workspace";
import { sameOrigin, validUuid, employeePinValues } from "@/lib/kiosk/server";
import { newPin, validPin } from "@/lib/kiosk/crypto";
import { origins } from "@/lib/hosts";
import { serviceClient } from "@/lib/supabase/service";
import { supabaseConfig } from "@/lib/supabase/config";

const validEmail = (email: string) =>
  email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const refresh = (org: string) => revalidatePath("/workspace/" + org + "/admin");

async function sendInvitation(
  client: SupabaseClient,
  org: string,
  employee: string,
  address: string,
) {
  const { data: claim, error } = await client
    .rpc("prepare_employee_invite", { org, employee, address })
    .retry(false);
  if (error || !claim)
    return "Check that the employee is active, unlinked and has a unique workplace email.";
  const redirectTo = new URL("/auth/employee-invite/" + claim, origins().app)
    .href;
  const service = serviceClient();
  let delivered = false;
  let invitedUser: string | null = null;
  try {
    const invitation = await service.auth.admin.inviteUserByEmail(address, {
      redirectTo,
    });
    if (
      invitation.error?.code === "email_exists" ||
      invitation.error?.code === "user_already_exists"
    ) {
      const { url, key } = supabaseConfig();
      const auth = createClient(url, key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
      const existing = await auth.auth.signInWithOtp({
        email: address,
        options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
      });
      delivered = !existing.error;
    } else if (!invitation.error && invitation.data.user) {
      invitedUser = invitation.data.user.id;
      delivered = true;
    }
  } finally {
    const result = await service
      .rpc("finish_employee_invite", {
        claim,
        delivered,
        invited_user: invitedUser,
      })
      .retry(false);
    if (result.error || !result.data) delivered = false;
  }
  return delivered
    ? ""
    : "Invitation delivery could not be confirmed. Retry from this profile.";
}

export async function createEmployee(
  org: string,
  id: string,
  fields: FormData,
) {
  if (!(await sameOrigin()) || !validUuid(org) || !validUuid(id))
    return { error: "Request unavailable." };
  const { client } = await requireWorkspace(org, "admin");
  const name = String(fields.get("name") ?? "").trim(),
    email = String(fields.get("email") ?? "")
      .trim()
      .toLowerCase();
  const manual = fields.has("pin"),
    chosen = String(fields.get("pin") ?? ""),
    invite = fields.get("invite") === "on";
  if (
    !name ||
    name.length > 120 ||
    ((email || invite) && !validEmail(email)) ||
    (manual && !validPin(chosen))
  )
    return { error: "Check the name, email address and six-digit PIN." };
  for (let attempt = 0; attempt < 5; attempt++) {
    const pin = manual ? chosen : newPin();
    const { error, data: created } = await client
      .rpc("create_employee", {
        org,
        employee: id,
        full_name: name,
        address: email || null,
        ...(await employeePinValues(org, id, pin)),
      })
      .retry(false);
    if (!error) {
      let message = created ? "Employee added." : "Employee already added.";
      if (invite && created) {
        try {
          message +=
            " " +
            ((await sendInvitation(client, org, id, email)) ||
              "Invitation sent.");
        } catch {
          message += " Check the invitation status in the employee profile.";
        }
      }
      refresh(org);
      return { message };
    }
    if (
      error.code === "23505" &&
      error.message.includes("employee_pins_organisation_id_verifier_key")
    ) {
      if (!manual) continue;
      return { error: "That PIN is already in use at this workplace." };
    }
    if (
      error.code === "23505" ||
      error.message === "Email already in directory"
    )
      return { error: "This employee or email is already in the directory." };
    return {
      error:
        "Employee creation could not be confirmed. Check the directory before retrying.",
    };
  }
  return { error: "Could not allocate a unique PIN. Try again." };
}

export async function inviteEmployee(
  org: string,
  employee: string,
  email: string,
) {
  if (
    !(await sameOrigin()) ||
    !validUuid(org) ||
    !validUuid(employee) ||
    typeof email !== "string" ||
    !validEmail(email.trim())
  )
    return { error: "Enter a valid email address." };
  const { client } = await requireWorkspace(org, "admin");
  try {
    return {
      error: await sendInvitation(
        client,
        org,
        employee,
        email.trim().toLowerCase(),
      ),
    };
  } finally {
    refresh(org);
  }
}

export async function setEmployeeActive(
  org: string,
  employee: string,
  enabled: boolean,
) {
  if (
    !(await sameOrigin()) ||
    !validUuid(org) ||
    !validUuid(employee) ||
    typeof enabled !== "boolean"
  )
    return { error: "Request unavailable." };
  const { client } = await requireWorkspace(org, "admin");
  const { error } = await client.rpc("set_employee_active", {
    org,
    employee,
    enabled,
  });
  if (error) return { error: "Could not change employee status." };
  refresh(org);
  revalidatePath("/workspace/" + org + "/employee");
  return { error: "" };
}
