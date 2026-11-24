import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ReportInputError } from "./reports";
import type { Staff, Session, Week } from "./timesheets";

export async function readPages<T>(
  read: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; count: number | null; error: unknown }>,
  limit?: { max: number; message: string },
) {
  const rows: T[] = [];
  let expectedCount: number | undefined;
  // Respect the project's API row cap, which can be smaller than our page size.
  for (;;) {
    const { data, count, error } = await read(rows.length, rows.length + 499);
    if (error || !data || count === null)
      throw new Error("Could not load timesheet records.");
    if (limit) {
      if (count > limit.max) throw new ReportInputError(limit.message);
      if (
        (expectedCount !== undefined && expectedCount !== count) ||
        (!data.length && rows.length < count)
      )
        throw new Error("Records changed while loading. Refresh the report.");
      expectedCount = count;
    }
    rows.push(...data);
    if (!data.length || rows.length >= count) return rows;
  }
}

export async function readRecords(
  client: SupabaseClient,
  org: string,
  week: Week,
  userId?: string,
) {
  const staffRequest = readPages<Staff>((from, to) => {
    let q = client
      .from("employees")
      .select("id, display_name, active", { count: "exact" })
      .eq("organisation_id", org);
    if (userId) q = q.eq("user_id", userId).eq("active", true);
    return q.order("display_name").order("id").range(from, to);
  });
  const readSessions = (employeeId?: string) => readPages<Session>((from, to) => {
    let q = client
      .from("work_sessions")
      .select(
        "id, employee_id, started_at, ended_at, reviewed_at, note, revision, voided_at, created_by",
        {
          count: "exact",
        },
      )
      .eq("organisation_id", org)
      .lt("started_at", week.end)
      .or(
        `ended_at.gt.${week.start},and(ended_at.is.null,or(voided_at.is.null,started_at.gte.${week.start}))`,
      );
    if (employeeId) q = q.eq("employee_id", employeeId);
    return q.order("started_at", { ascending: false }).order("id").range(from, to);
  });
  if (!userId) {
    const [staff, sessions] = await Promise.all([staffRequest, readSessions()]);
    return { staff, sessions };
  }
  const staff = await staffRequest;
  if (!staff.length) return { staff, sessions: [] };
  const sessions = await readSessions(staff[0].id);
  return { staff, sessions };
}
