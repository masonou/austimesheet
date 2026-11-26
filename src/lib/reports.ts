import { Temporal } from "@js-temporal/polyfill";
import { minuteInstant, type Staff, type Session } from "./timesheets.ts";

export type ReportSession = Pick<
  Session,
  | "id"
  | "employee_id"
  | "started_at"
  | "ended_at"
  | "reviewed_at"
  | "voided_at"
  | "note"
>;
export type ReportPeriod = "this-week" | "last-week" | "fortnight" | "custom";
export class ReportInputError extends Error {}
export const reportLimits = {
  days: 366,
  selected: 100,
  sessions: 5000,
  people: 5000,
  allocations: 20000,
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function date(value: string | null) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith("0000")) {
    try {
      return Temporal.PlainDate.from(value);
    } catch {
      /* Show a field-level explanation below. */
    }
  }
  throw new ReportInputError("Choose a valid start and end date.");
}

export function reportFilters(
  search: URLSearchParams,
  zone: string,
  currentMonday: string,
) {
  const one = (key: string) => {
    if (search.getAll(key).length > 1)
      throw new ReportInputError("Choose one reporting period and date range.");
    return search.get(key);
  };
  const period = one("period") ?? "this-week";
  const start = one("start"),
    end = one("end");
  let first = date(currentMonday);
  let last: Temporal.PlainDate;
  switch (period) {
    case "this-week":
    case "last-week":
      if (start !== null || end !== null)
        throw new ReportInputError("Use a custom range to enter weekly dates.");
      if (period === "last-week") first = first.subtract({ weeks: 1 });
      last = first.add({ days: 6 });
      break;
    case "fortnight":
      if (end !== null)
        throw new ReportInputError(
          "A fortnight ends 13 days after the start date.",
        );
      if (start !== null) first = date(start);
      last = first.add({ days: 13 });
      break;
    case "custom":
      first = date(start);
      last = date(end);
      break;
    default:
      throw new ReportInputError("Choose a valid reporting period.");
  }
  if (
    last.year > 9999 ||
    first.until(last).days < 0 ||
    first.until(last).days >= reportLimits.days
  )
    throw new ReportInputError(
      "Choose an inclusive date range of 1 to 366 days.",
    );
  const ids = search.getAll("employee");
  if (ids.length > reportLimits.selected || ids.some((id) => !uuid.test(id)))
    throw new ReportInputError(
      "Choose up to 100 employees from this workplace.",
    );
  return {
    period,
    first: first.toString(),
    last: last.toString(),
    zone,
    start: first.toZonedDateTime(zone).toInstant(),
    end: last.add({ days: 1 }).toZonedDateTime(zone).toInstant(),
    ids: [...new Set(ids.map((id) => id.toLowerCase()))],
  } as const;
}
export type Filters = ReturnType<typeof reportFilters>;

const zero = BigInt(0);
const amounts = () => ({
  weekday: zero,
  saturday: zero,
  sunday: zero,
  total: zero,
});
type Amounts = ReturnType<typeof amounts>;
type Bucket = Exclude<keyof Amounts, "total">;
type Allocation = {
  day: string;
  from: string;
  to: string;
  bucket: Bucket;
  duration: bigint;
};
type Shift = {
  id: string;
  day: string;
  clockIn: string;
  clockOut: string;
  note: string;
  review: "Reviewed" | "Pending";
  hours: Amounts;
  allocations: Allocation[];
};
type Person = {
  staff: Staff;
  hours: Amounts;
  sessions: Shift[];
  pending: number;
};

export const nanosPerHundredth = BigInt(36_000_000_000);
export function roundedHundredths(ns: bigint) {
  return (ns + nanosPerHundredth / BigInt(2)) / nanosPerHundredth;
}
export function decimalHours(ns: bigint) {
  const rounded = roundedHundredths(ns);
  return (
    String(rounded / BigInt(100)) +
    "." +
    String(rounded % BigInt(100)).padStart(2, "0")
  );
}
function stamp(zoned: Temporal.ZonedDateTime) {
  return zoned.toString({ timeZoneName: "never", calendarName: "never" });
}

export function makeReport(
  filters: Filters,
  staff: Staff[],
  sessions: ReportSession[],
) {
  const selected = new Set(filters.ids);
  const people = new Map<string, Person>();
  for (const person of staff)
    if (!selected.size || selected.has(person.id))
      people.set(person.id, {
        staff: person,
        hours: amounts(),
        sessions: [],
        pending: 0,
      });
  if (selected.size && people.size !== selected.size)
    throw new ReportInputError("Choose employees belonging to this workplace.");
  const hours = amounts(),
    seen = new Set<string>();
  let completed = 0,
    pending = 0,
    allocationCount = 0;
  const { zone, start, end } = filters;
  for (const row of sessions) {
    if (
      row.voided_at ||
      !row.ended_at ||
      (selected.size && !selected.has(row.employee_id))
    )
      continue;
    const who = people.get(row.employee_id);
    if (!who || seen.has(row.id))
      throw new Error("Report records changed. Refresh the report.");
    seen.add(row.id);
    const actualStart = minuteInstant(row.started_at),
      actualEnd = minuteInstant(row.ended_at);
    let cursor =
      Temporal.Instant.compare(actualStart, start) < 0 ? start : actualStart;
    const finish =
      Temporal.Instant.compare(actualEnd, end) > 0 ? end : actualEnd;
    // Keep completed shifts within one minute as zero-hour rows. A shift
    // clipped to zero at the period boundary contributes no row or hours.
    if (
      Temporal.Instant.compare(actualStart, end) >= 0 ||
      Temporal.Instant.compare(cursor, finish) > 0 ||
      (cursor.equals(finish) && !actualStart.equals(actualEnd))
    )
      continue;
    const clockIn = actualStart.toZonedDateTimeISO(zone);
    const shift: Shift = {
      id: row.id,
      day: clockIn.toPlainDate().toString(),
      clockIn: stamp(clockIn),
      clockOut: stamp(actualEnd.toZonedDateTimeISO(zone)),
      review: row.reviewed_at ? "Reviewed" : "Pending",
      note: row.note ?? "",
      hours: amounts(),
      allocations: [],
    };
    while (Temporal.Instant.compare(cursor, finish) < 0) {
      if (++allocationCount > reportLimits.allocations)
        throw new ReportInputError(
          "Too many daily allocations. Choose fewer employees or a shorter period.",
        );
      const local = cursor.toZonedDateTimeISO(zone),
        day = local.toPlainDate();
      const midnight = day.add({ days: 1 }).toZonedDateTime(zone).toInstant();
      const until =
        Temporal.Instant.compare(midnight, finish) < 0 ? midnight : finish;
      const duration = until.epochNanoseconds - cursor.epochNanoseconds;
      const bucket: Bucket =
        day.dayOfWeek === 6
          ? "saturday"
          : day.dayOfWeek === 7
            ? "sunday"
            : "weekday";
      shift.allocations.push({
        day: day.toString(),
        from: stamp(local),
        to: stamp(until.toZonedDateTimeISO(zone)),
        bucket,
        duration,
      });
      for (const totals of [hours, who.hours, shift.hours]) {
        totals[bucket] += duration;
        totals.total += duration;
      }
      cursor = until;
    }
    who.sessions.push(shift);
    completed++;
    if (!row.reviewed_at) {
      pending++;
      who.pending++;
    }
  }
  return {
    filters,
    hours,
    completed,
    pending,
    people: [...people.values()].filter(
      (p) => p.staff.active || selected.has(p.staff.id) || p.sessions.length,
    ),
  };
}
export type Report = ReturnType<typeof makeReport>;
