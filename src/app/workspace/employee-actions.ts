"use server";

import { changeLogin, type IssuedCredentials } from "@/lib/employee-login";
import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/workspace";
import { sameOrigin, validUuid, employeePinValues } from "@/lib/kiosk/server";
import { newPin, validPin } from "@/lib/kiosk/crypto";
const validEmail = (email: string) =>
  email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const refresh = (org: string) => revalidatePath("/workspace/" + org + "/admin");

export async function createEmployee(
  org: string,
  id: string,
  fields: FormData,
) {
  if (!(await sameOrigin()) || !validUuid(org) || !validUuid(id))
    return { error: "Request unavailable." };
  const { client, userId } = await requireWorkspace(org, "admin");
  const name = String(fields.get("name") ?? "").trim(),
    email = String(fields.get("email") ?? "")
      .trim()
      .toLowerCase();
  const manual = fields.has("pin"),
    chosen = String(fields.get("pin") ?? "");
  if (
    !name ||
    name.length > 120 ||
    (email && !validEmail(email)) ||
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
      let credentials: IssuedCredentials | undefined;
      if (email) {
        const profile = await client.rpc("employee_profile", {
          org,
          employee: id,
        });
        if (profile.error)
          message += " Open the profile to check dashboard access.";
        if (profile.data?.accountStatus === "Kiosk only") {
          try {
            const result = await changeLogin(org, id, userId, "enable", email);
            credentials = result.credentials;
            message += result.error
              ? " " +
                result.error +
                " Open the profile to check dashboard access."
              : " Dashboard access enabled.";
          } catch {
            message += " Open the profile to check dashboard access.";
          }
        }
      }
      refresh(org);
      return { message, credentials };
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

export async function manageLogin(
  org: string,
  employee: string,
  kind: "enable" | "email" | "reset",
  email: string,
) {
  if (
    !(await sameOrigin()) ||
    !validUuid(org) ||
    !validUuid(employee) ||
    !["enable", "email", "reset"].includes(kind) ||
    typeof email !== "string" ||
    (kind !== "reset" && !validEmail(email.trim()))
  )
    return { error: "Check the login email." };
  const { userId } = await requireWorkspace(org, "admin");
  try {
    return await changeLogin(
      org,
      employee,
      userId,
      kind,
      email.trim().toLowerCase(),
    );
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
