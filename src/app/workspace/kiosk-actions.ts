"use server";

import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/workspace";
import {
  newPin,
  newToken,
  pinVerifier,
  tokenDigest,
  validPin,
} from "@/lib/kiosk/crypto";
import {
  deviceDigest,
  pinKey,
  kioskClient,
  sameOrigin,
  saveDevice,
  validUuid,
} from "@/lib/kiosk/server";

export async function assignPin(
  org: string,
  employee: string,
  choice: string | null,
): Promise<{ error?: string; pin?: string }> {
  if (!(await sameOrigin()) || !validUuid(org) || !validUuid(employee))
    return { error: "Request unavailable." };
  const { client } = await requireWorkspace(org, "admin");
  if (choice !== null && !validPin(choice))
    return { error: "Enter exactly six digits." };
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const pin = choice ?? newPin();
      const { error } = await client.rpc("assign_employee_pin", {
        org,
        employee,
        pin_verifier: await pinVerifier(org, pin, pinKey()),
      });
      if (!error) return { pin };
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

export async function activateDevice(org: string, name: string) {
  if (
    !(await sameOrigin()) ||
    !validUuid(org) ||
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 80
  )
    return { error: "Enter a kiosk name of up to 80 characters." };
  const { client } = await requireWorkspace(org, "admin");
  try {
    pinKey();
    kioskClient();
    const token = newToken();
    const { error } = await client.rpc("activate_kiosk", {
      org,
      device_name: name.trim(),
      credential_digest: tokenDigest(token),
      previous_digest: await deviceDigest(),
    });
    if (error) throw new Error();
    await saveDevice(token);
    const signedOut = await client.auth.signOut({ scope: "local" });
    if (signedOut.error)
      return {
        error:
          "Kiosk activated. Sign out before leaving this device with staff.",
      };
  } catch {
    return {
      error:
        "Activation could not be confirmed. Check the kiosk list and server configuration.",
    };
  }
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
