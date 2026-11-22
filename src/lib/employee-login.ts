import "server-only";
import { randomInt } from "node:crypto";
import { serviceClient } from "./supabase/service";

export type IssuedCredentials = { email: string; password: string };
type Result = { error?: string; credentials?: IssuedCredentials };

// Generate the entire password randomly; require each commonly configured
// Supabase character class without placing them at predictable positions.
function generatePassword() {
  const classes = [
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "abcdefghijkmnopqrstuvwxyz",
    "23456789",
    "!@#$%&*",
  ];
  const alphabet = classes.join("");
  let password: string;
  do {
    password = Array.from(
      { length: 24 },
      () => alphabet[randomInt(alphabet.length)],
    ).join("");
  } while (
    !classes.every((group) =>
      [...password].some((char) => group.includes(char)),
    )
  );
  return password;
}

export async function changeLogin(
  org: string,
  employee: string,
  actor: string,
  operation: "enable" | "reset" | "email",
  address: string | null,
): Promise<Result> {
  const service = serviceClient();
  const { data, error } = await service
    .rpc("prepare_dashboard_login", {
      org,
      employee,
      actor,
      operation,
      address,
    })
    .retry(false);
  if (error || !data)
    return {
      error:
        error?.message === "Login email unavailable"
          ? "That login email is unavailable. Choose another address."
          : "This login cannot be managed here. Check the employee’s status and workplace memberships.",
    };
  const password = operation === "email" ? undefined : generatePassword();
  const app_metadata = { shiftbook_dashboard_change: data.nonce };
  const auth = service.auth.admin;
  const result =
    operation === "enable"
      ? await auth.createUser({
          id: data.userId,
          email: data.address,
          password,
          email_confirm: true,
          app_metadata: {
            ...app_metadata,
            shiftbook_email_ownership: "admin_assigned",
          },
        })
      : await auth.updateUserById(
          data.userId,
          operation === "email"
            ? {
                email: data.address,
                email_confirm: true,
                app_metadata: {
                  ...app_metadata,
                  shiftbook_email_ownership: "admin_assigned",
                },
              }
            : { password, app_metadata },
        );
  if (result.error || result.data.user?.id !== data.userId) {
    if (
      ["user_already_exists", "email_exists"].includes(result.error?.code ?? "")
    )
      return {
        error: "That login email is unavailable. Choose another address.",
      };
    if (result.error?.code === "weak_password")
      return {
        error: "The project’s password policy rejected the generated password.",
      };
    return {
      error:
        "The login change could not be confirmed. Refresh the profile before retrying.",
    };
  }
  return password ? { credentials: { email: data.address, password } } : {};
}
