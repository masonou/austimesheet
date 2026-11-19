import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace-shell";
import { StaffList, TimesheetBoard } from "@/components/timesheet-board";
import { sampleSessions, sampleStaff, sampleWeek } from "@/lib/sample";
import { getWeek } from "@/lib/timesheets";

export default async function Preview({
  params,
  searchParams,
}: PageProps<"/preview/[role]">) {
  const { role } = await params;
  if (role !== "admin" && role !== "employee") notFound();
  const query = await searchParams;
  const zone = "Australia/Brisbane";
  const week = getWeek(
    typeof query.week === "string" ? query.week : sampleWeek,
    zone,
  );
  const directory = role === "admin" && query.view === "staff";
  const staff = role === "admin" ? sampleStaff : sampleStaff.slice(0, 1);
  const sessions = sampleSessions.filter(
    (s) =>
      staff.some((p) => p.id === s.employee_id) &&
      Date.parse(s.started_at) < Date.parse(week.end) &&
      (!s.ended_at || Date.parse(s.ended_at) > Date.parse(week.start)),
  );
  const base = "/preview/" + role;
  return (
    <WorkspaceShell
      name="Wattle Lane Café"
      role={role}
      base={base}
      directory={directory}
      sample
    >
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
