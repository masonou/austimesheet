"use server";

import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/workspace";
import {
  newPin,
  openPin,
  sealPin,
  pinVerifier,
  validPin,
} from "@/lib/kiosk/crypto";
import {
  encryptionKey,
  pinKey,
  sameOrigin,
  validUuid,
} from "@/lib/kiosk/server";

export async function assignPin(
  org: string,
  employee: string,
  choice: string | null,
): Promise<{ error?: string }> {
  if (!(await sameOrigin()) || !validUuid(org) || !validUuid(employee))
    return { error: "Request unavailable." };
  const { client } = await requireWorkspace(org, "admin");
  if (choice !== null && !validPin(choice))
    return { error: "Enter exactly six digits." };
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const pin = choice ?? newPin();
      const { error } = await client.rpc("set_employee_pin", {
        org,
        employee,
        pin_verifier: await pinVerifier(org, pin, pinKey()),
        envelope: sealPin(org, employee, pin, encryptionKey()),
      });
      if (!error) {
        revalidatePath("/workspace/" + org + "/admin");
        return {};
      }
      if (error.code !== "23505") break;
      if (choice !== null)
        return { error: "That PIN is already assigned. Choose another." };
    }
  } catch {
    /* Never include input or upstream error details in the response. */
  }
  return {
    error:
      "PIN assignment could not be confirmed. Check the employee and kiosk configuration before retrying.",
  };
}

export async function revealPin(
  org: string,
  employee: string,
): Promise<{ pin?: string; error?: string }> {
  if (!(await sameOrigin()) || !validUuid(org) || !validUuid(employee))
    return { error: "Request unavailable." };
  const { client, userId } = await requireWorkspace(org, "admin");
  try {
    const { data: user, error: authError } = await client.auth.getUser();
    if (authError || user.user?.id !== userId)
      return { error: "Sign in again to reveal a PIN." };
    const key = encryptionKey();
    const { data, error } = await client.rpc("read_employee_pin", {
      org,
      employee,
    });
    if (error || !data) throw new Error();
    return { pin: openPin(org, employee, data, key) };
  } catch {
    return {
      error:
        "PIN unavailable. Check the encryption key or reset this employee’s PIN.",
    };
  }
}

export async function renameEmployee(
  org: string,
  employee: string,
  name: string,
) {
  if (
    !(await sameOrigin()) ||
    !validUuid(org) ||
    !validUuid(employee) ||
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 120
  )
    return { error: "Enter a name of up to 120 characters." };
  const { client } = await requireWorkspace(org, "admin");
  const { error } = await client.rpc("rename_employee", {
    org,
    employee,
    new_name: name.trim(),
  });
  if (error) return { error: "Could not update the employee name." };
  revalidatePath("/workspace/" + org + "/admin");
  return { error: "" };
}

export async function revokeDevice(org: string, device: string) {
  if (!(await sameOrigin()) || !validUuid(org) || !validUuid(device))
    return { error: "Request unavailable." };
  const { client } = await requireWorkspace(org, "admin");
  const { error } = await client.rpc("revoke_kiosk", { org, device });
  if (error)
    return {
      error:
        "Revocation could not be confirmed. Refresh the list before retrying.",
    };
  revalidatePath("/workspace/" + org + "/admin");
  return { error: "" };
}

export async function renameDevice(org: string, device: string, label: string) {
  if (
    !(await sameOrigin()) ||
    !validUuid(org) ||
    !validUuid(device) ||
    typeof label !== "string" ||
    !label.trim() ||
    label.trim().length > 80
  )
    return { error: "Enter a kiosk name of up to 80 characters." };
  const { client } = await requireWorkspace(org, "admin");
  const { error } = await client.rpc("rename_kiosk", {
    org,
    device,
    label: label.trim(),
  });
  if (error) return { error: "Could not rename this kiosk." };
  revalidatePath("/workspace/" + org + "/admin");
  return { error: "" };
}
