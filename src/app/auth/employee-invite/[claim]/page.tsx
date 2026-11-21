import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { expectedHost } from "@/lib/hosts";
import { serverClient } from "@/lib/supabase/server";
import { validUuid } from "@/lib/kiosk/server";
import { Brand } from "@/components/brand";
import { AcceptEmployeeInvite } from "@/components/accept-employee-invite";

export default async function EmployeeInvite({
  params,
}: PageProps<"/auth/employee-invite/[claim]">) {
  const { claim } = await params;
  if (!validUuid(claim) || !expectedHost(await headers(), "app")) notFound();
  const client = await serverClient();
  const { data: user } = await client.auth.getClaims();
  const details = user?.claims.sub
    ? (await client.rpc("employee_invite_details", { claim })).data
    : null;
  return (
    <div className="entry">
      <header className="topbar">
        <Brand />
      </header>
      <main className="kiosk-card">
        <h1>Employee invitation</h1>
        <AcceptEmployeeInvite claim={claim} initial={details} />
      </main>
    </div>
  );
}
