"use server";

import { createClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { serverClient } from "@/lib/supabase/server";
import { supabaseConfig } from "@/lib/supabase/config";
import { validUuid, sameOrigin } from "@/lib/kiosk/server";

export type Invitation = {
  organisation: string;
  email: string;
  needsPassword: boolean;
};
const unavailable =
  "This invitation is unavailable. Ask the workplace administrator to resend it.";

export async function verifyInvitation(
  claim: string,
  hash: string,
  type: string,
) {
  if (
    !(await sameOrigin()) ||
    !validUuid(claim) ||
    typeof hash !== "string" ||
    !hash ||
    hash.length > 256 ||
    (type !== "invite" && type !== "magiclink")
  )
    return { error: unavailable };
  const { url, key } = supabaseConfig();
  const proof = createClient(url, key, {
    auth: {
      persistSession: false,
      detectSessionInUrl: false,
      autoRefreshToken: false,
    },
  });
  const { data, error } = await proof.auth.verifyOtp({
    type,
    token_hash: hash,
  });
  if (error || !data.session) return { error: unavailable };
  const { data: details, error: lookup } = await proof.rpc(
    "employee_invite_details",
    { claim },
  );
  if (!details || lookup) return { error: unavailable };
  const { error: cookieError } = await (
    await serverClient()
  ).auth.setSession(data.session);
  return cookieError
    ? { error: unavailable }
    : { details: details as Invitation };
}

export async function acceptInvitation(claim: string, password: string) {
  if (!(await sameOrigin()) || !validUuid(claim)) return { error: unavailable };
  const client = await serverClient();
  const { data: details, error } = await client.rpc("employee_invite_details", {
    claim,
  });
  if (!details || error) return { error: unavailable };
  if (details.needsPassword) {
    if (typeof password !== "string" || password.length < 8)
      return { error: "Choose a password with at least eight characters." };
    const update = await client.auth.updateUser({ password });
    if (update.error)
      return {
        error:
          "Supabase could not save this password. Check the password policy and try again.",
      };
  }
  const { data: org, error: link } = await client
    .rpc("accept_employee_invite", { claim })
    .retry(false);
  if (link || !validUuid(org))
    return {
      error:
        "Access could not be linked. Check your workspace or ask the administrator to check the invitation.",
    };
  redirect("/workspace/" + org + "/employee");
}
