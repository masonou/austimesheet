import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readPages } from "./records";
import {
  makeReport,
  ReportInputError,
  reportLimits,
  type Filters,
  type ReportSession,
} from "./reports";
import type { Staff } from "./timesheets";

export async function reportDirectory(client: SupabaseClient, org: string) {
  return readPages<Staff>(
    (from, to) =>
      client
        .from("employees")
        .select("id,display_name,active", { count: "exact" })
        .eq("organisation_id", org)
        .order("display_name")
        .order("id")
        .range(from, to),
    {
      max: reportLimits.people,
      message:
        "This workplace exceeds the reporting directory limit of 5,000 employees.",
    },
  );
}

export async function loadReport(
  client: SupabaseClient,
  org: string,
  filters: Filters,
  staff: Staff[],
) {
  const ids = new Set(staff.map((person) => person.id));
  if (filters.ids.some((id) => !ids.has(id)))
    throw new ReportInputError("Choose employees belonging to this workplace.");
  const sessions = await readPages<ReportSession>(
    (from, to) => {
      let q = client
        .from("work_sessions")
        .select(
          "id,employee_id,started_at,ended_at,reviewed_at,voided_at,note",
          { count: "exact" },
        )
        .eq("organisation_id", org)
        .is("voided_at", null)
        .lt("started_at", filters.end.toString())
        .gt("ended_at", filters.start.toString());
      if (filters.ids.length) q = q.in("employee_id", filters.ids);
      return q.order("started_at").order("id").range(from, to);
    },
    {
      max: reportLimits.sessions,
      message:
        "This report exceeds 5,000 sessions. Choose fewer employees or a shorter period.",
    },
  );
  return makeReport(filters, staff, sessions);
}
