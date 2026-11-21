import { WorkspaceShell } from "@/components/workspace-shell";
import { StaffList, TimesheetBoard } from "@/components/timesheet-board";
import { getWeek } from "@/lib/timesheets";
import { requireWorkspace } from "@/lib/workspace";
import { readPages, readRecords } from "@/lib/records";
import { KioskAdmin, type Device } from "@/components/kiosk-admin";
import { EmployeeProfile } from "@/components/employee-profile";
import { validUuid } from "@/lib/kiosk/server";
import { origins } from "@/lib/hosts";
import { notFound } from "next/navigation";

export default async function Dashboard({
  params,
  searchParams,
}: PageProps<"/workspace/[org]/[role]">) {
  const route = await params;
  const { client, userId, membership } = await requireWorkspace(
    route.org,
    route.role,
  );
  const {
    role,
    organisations: { name, timezone: zone },
  } = membership;
  const query = await searchParams;
  const week = getWeek(
    typeof query.week === "string" ? query.week : undefined,
    zone,
  );
  const base = "/workspace/" + route.org + "/" + role;
  const directory = role === "admin" && query.view === "staff";
  if (directory && query.person) {
    if (!validUuid(query.person)) notFound();
    const { data: profile, error } = await client.rpc("employee_profile", {
      org: route.org,
      employee: query.person,
    });
    if (error) throw new Error("Employee profile unavailable.");
    if (!profile) notFound();
    return (
      <WorkspaceShell {...{ name, role, base }} directory>
        <EmployeeProfile key={profile.id} org={route.org} profile={profile} />
      </WorkspaceShell>
    );
  }
  if (role === "admin" && query.view === "kiosks") {
    const devices = await readPages<Device>((from, to) =>
      client
        .from("kiosk_devices")
        .select("id,name,activated_at,expires_at,revoked_at,last_seen_at", {
          count: "exact",
        })
        .eq("organisation_id", route.org)
        .order("name")
        .order("id")
        .range(from, to),
    );
    return (
      <WorkspaceShell {...{ name, role, base }} kiosks>
        <KioskAdmin
          kioskUrl={
            new URL("/" + membership.organisations.slug, origins().kiosk).href
          }
          org={route.org}
          devices={devices}
          zone={zone}
          asOf={new Date().getTime()}
        />
      </WorkspaceShell>
    );
  }
  const { staff, sessions } = await readRecords(
    client,
    route.org,
    week,
    role === "employee" ? userId : undefined,
  );
  return (
    <WorkspaceShell {...{ name, role, base, directory }}>
      {directory ? (
        <StaffList staff={staff} org={route.org} />
      ) : (
        <TimesheetBoard
          org={role === "admin" ? route.org : undefined}
          {...{ role, staff, sessions, week, zone, base }}
          employee={
            typeof query.employee === "string" ? query.employee : undefined
          }
        />
      )}
    </WorkspaceShell>
  );
}
