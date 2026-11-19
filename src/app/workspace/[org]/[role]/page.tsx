import { WorkspaceShell } from "@/components/workspace-shell";
import { StaffList, TimesheetBoard } from "@/components/timesheet-board";
import { getWeek } from "@/lib/timesheets";
import { requireWorkspace } from "@/lib/workspace";
import { readRecords } from "@/lib/records";

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
  const { staff, sessions } = await readRecords(
    client,
    route.org,
    week,
    role === "employee" ? userId : undefined,
  );
  return (
    <WorkspaceShell {...{ name, role, base, directory }}>
      {directory ? (
        <StaffList staff={staff} />
      ) : (
        <TimesheetBoard
          {...{ role, staff, sessions, week, zone, base }}
          employee={
            typeof query.employee === "string" ? query.employee : undefined
          }
        />
      )}
    </WorkspaceShell>
  );
}
