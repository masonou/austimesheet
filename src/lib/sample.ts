import type { Session, Staff } from "./timesheets";

export const sampleWeek = "2026-11-16";
export const sampleStaff: Staff[] = [
  { id: "alex", display_name: "Alex Lee", active: true },
  { id: "ruby", display_name: "Ruby Nguyen", active: true },
  { id: "sam", display_name: "Sam Taylor", active: true },
  { id: "noah", display_name: "Noah Ellis", active: false },
];

function shift(
  employee_id: string,
  start: string,
  end: string,
  reviewed: boolean,
  note: string | null = null,
): Session {
  const started_at = start + ":00+10:00",
    ended_at = end + ":00+10:00";
  return {
    id: employee_id + start,
    employee_id,
    started_at,
    ended_at,
    reviewed_at: reviewed ? ended_at : null,
    note,
    revision: 1,
    voided_at: null,
    created_by: null,
  };
}
export const sampleSessions = [
  shift("alex", "2026-11-13T09:00", "2026-11-13T15:00", true),
  shift("alex", "2026-11-16T07:00", "2026-11-16T13:00", true, "Opening shift"),
  shift("ruby", "2026-11-16T12:00", "2026-11-16T15:00", true),
  shift("ruby", "2026-11-16T17:30", "2026-11-16T20:30", true, "Dinner service"),
  shift("alex", "2026-11-17T08:00", "2026-11-17T15:30", true),
  shift("sam", "2026-11-18T15:30", "2026-11-18T21:00", false),
  shift("alex", "2026-11-19T11:00", "2026-11-19T16:00", false),
  shift("sam", "2026-11-20T21:00", "2026-11-21T02:00", false, "Late close"),
];
