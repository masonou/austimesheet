import { Temporal } from "@js-temporal/polyfill";

export type Staff = { id: string; display_name: string; active: boolean };
export type Session = {
  id: string;
  employee_id: string;
  started_at: string;
  ended_at: string | null;
  reviewed_at: string | null;
  note: string | null;
  revision: number;
  voided_at: string | null;
  created_by: string | null;
};
export type Week = ReturnType<typeof getWeek>;

export function getWeek(
  value: string | undefined,
  zone: string,
  today = Temporal.Now.plainDateISO(zone),
) {
  let day = today;
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    try {
      day = Temporal.PlainDate.from(value);
    } catch {
      /* Use the current week for invalid links. */
    }
  }
  const monday = day.subtract({ days: day.dayOfWeek - 1 });
  const next = monday.add({ weeks: 1 });
  const format = (date: Temporal.PlainDate, year = false) =>
    date.toLocaleString("en-AU", {
      day: "numeric",
      month: "short",
      ...(year && { year: "numeric" }),
    });
  return {
    key: monday.toString(),
    previous: monday.subtract({ weeks: 1 }).toString(),
    next: next.toString(),
    start: monday.toZonedDateTime(zone).toInstant().toString(),
    end: next.toZonedDateTime(zone).toInstant().toString(),
    label: format(monday) + " – " + format(next.subtract({ days: 1 }), true),
  };
}

export function timeLabel(value: string, zone: string) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

export function dayLabel(value: string, zone: string) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

export function elapsed(
  session: Pick<Session, "started_at" | "ended_at"> & {
    voided_at?: string | null;
  },
  week?: Week,
) {
  if (!session.ended_at || session.voided_at) return 0;
  const start = Temporal.Instant.from(session.started_at);
  const end = Temporal.Instant.from(session.ended_at);
  const lo =
    week && Temporal.Instant.compare(start, week.start) < 0
      ? Temporal.Instant.from(week.start)
      : start;
  const hi =
    week && Temporal.Instant.compare(end, week.end) > 0
      ? Temporal.Instant.from(week.end)
      : end;
  return Math.max(0, Number(hi.epochNanoseconds - lo.epochNanoseconds) / 1e6);
}

export function hours(ms: number) {
  if (ms > 0 && ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return [
    Math.floor(minutes / 60) + "h",
    minutes % 60 ? (minutes % 60) + "m" : "",
    seconds % 60 ? (seconds % 60) + "s" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function shiftField(instant: string, zone: string) {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: "second" });
}

// During a spring-forward gap there is no such instant. A repeated autumn time
// has two valid offsets. Preserve subsecond kiosk precision on untouched fields.
export function shiftChoices(
  value: string,
  zone: string,
  original?: string | null,
) {
  if (!value) return [];
  let local: Temporal.PlainDateTime;
  try {
    local = Temporal.PlainDateTime.from(value);
  } catch {
    return [];
  }
  const choices = (["earlier", "later"] as const).map((disambiguation) =>
    local.toZonedDateTime(zone, {
      disambiguation,
    }),
  );
  const source = original
    ? Temporal.Instant.from(original).toZonedDateTimeISO(zone)
    : null;
  return choices
    .filter(
      (v, i) =>
        v.toPlainDateTime().equals(local) &&
        (i === 0 || v.offset !== choices[0].offset),
    )
    .map((v) => ({
      offset: v.offset,
      instant:
        original &&
        source &&
        source.offset === v.offset &&
        local.equals(shiftField(original, zone))
          ? original
          : v.toInstant().toString(),
    }));
}
