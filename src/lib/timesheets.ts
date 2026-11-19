import { Temporal } from "@js-temporal/polyfill";

export type Staff = { id: string; display_name: string; active: boolean };
export type Session = {
  id: string;
  employee_id: string;
  started_at: string;
  ended_at: string | null;
  reviewed_at: string | null;
  note: string | null;
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

export function elapsed(session: Session, week?: Week) {
  if (!session.ended_at) return 0;
  const start = Date.parse(session.started_at),
    end = Date.parse(session.ended_at);
  return week
    ? Math.max(
        0,
        Math.min(end, Date.parse(week.end)) -
          Math.max(start, Date.parse(week.start)),
      )
    : end - start;
}

export function hours(ms: number) {
  const mins = Math.round(ms / 60000);
  if (ms > 0 && mins === 0) return "<1m";
  return (
    Math.floor(mins / 60) + "h" + (mins % 60 ? " " + (mins % 60) + "m" : "")
  );
}
