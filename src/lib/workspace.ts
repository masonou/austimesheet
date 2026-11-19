import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { serverClient } from "./supabase/server";

export type Role = "admin" | "employee";
export type Membership = {
  role: Role;
  organisations: { id: string; name: string; timezone: string };
};

export const getAccount = cache(async () => {
  const client = await serverClient();
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims.sub) redirect("/");
  const memberships = await client
    .from("organisation_memberships")
    .select("role, organisations!inner(id, name, timezone)")
    .eq("user_id", data.claims.sub)
    .eq("active", true)
    .order("organisation_id")
    .returns<Membership[]>();
  if (memberships.error)
    throw new Error(
      "Could not load workspace memberships. Check the migration and connection.",
    );
  return { memberships: memberships.data, client, userId: data.claims.sub };
});

export async function requireWorkspace(org: string, role: string) {
  const account = await getAccount();
  const membership = account.memberships.find(
    (m) => m.organisations.id === org && m.role === role,
  );
  if (!membership) notFound();
  return { ...account, membership };
}
