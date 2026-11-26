import {
  nanosPerHundredth,
  ReportInputError,
  roundedHundredths,
  type Report,
} from "./reports.ts";

const buckets = ["weekday", "saturday", "sunday"] as const;
const hourHeadings = [
  "Weekday Hours",
  "Saturday Hours",
  "Sunday Hours",
  "Total Hours",
];
export const overviewHeadings = ["Employee", ...hourHeadings];
export const sessionHeadings = [
  "Date",
  "Clock In",
  "Clock Out",
  ...hourHeadings,
  "Status",
  "Notes",
];

// Apportion whole hundredths without losing one when independently rounding rows.
// The input order breaks ties (weekday, Saturday, Sunday or chronological session).
function apportion(
  durations: bigint[],
  target: number,
  sessionRemainders?: number[],
) {
  const units = durations.map((ns) => Number(ns / nanosPerHundredth));
  const extra = target - units.reduce((sum, n) => sum + n, 0);
  if (extra) {
    const ranking = durations.map((ns, index) => ({
      index,
      remainder: Number(ns % nanosPerHundredth),
    }));
    const eligible = ranking.filter((cell) => cell.remainder > 0);
    eligible.sort(
      (a, b) =>
        (sessionRemainders
          ? sessionRemainders[b.index] - sessionRemainders[a.index]
          : 0) ||
        b.remainder - a.remainder ||
        a.index - b.index,
    );
    for (const { index } of eligible.slice(0, extra)) {
      units[index]++;
      if (sessionRemainders)
        sessionRemainders[index] -= Number(nanosPerHundredth);
    }
  }
  return units;
}

export type ExportHours = {
  weekday: number;
  saturday: number;
  sunday: number;
  total: number;
};
function hours(weekday: number, saturday: number, sunday: number): ExportHours {
  return { weekday, saturday, sunday, total: weekday + saturday + sunday };
}

export function exportPeople(report: Report) {
  return report.people.map((person) => {
    const target = Number(roundedHundredths(person.hours.total));
    const categories = apportion(
      buckets.map((key) => person.hours[key]),
      target,
    );
    // For split shifts, favour rows with the most elapsed time still unrepresented
    // across all three columns. Only round up a cell that has a fraction of its own.
    const sessionRemainders = person.sessions.map((shift) =>
      buckets.reduce(
        (sum, key) => sum + Number(shift.hours[key] % nanosPerHundredth),
        0,
      ),
    );
    const [weekdays, saturdays, sundays] = buckets.map((key, i) =>
      apportion(
        person.sessions.map((shift) => shift.hours[key]),
        categories[i],
        sessionRemainders,
      ),
    );
    const sessions = person.sessions.map((shift, i) => {
      const allocations = shift.allocations;
      const clipped =
        allocations.length > 0 &&
        (allocations[0].from !== shift.clockIn ||
          allocations[allocations.length - 1].to !== shift.clockOut);
      const notes = [
        clipped ? "Only time within the reporting period is included." : "",
        shift.clockIn.slice(-6) !== shift.clockOut.slice(-6)
          ? "Clocks changed during this shift. Hours reflect elapsed time."
          : "",
        shift.note,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        day: shift.day,
        // Workbook clocks are local wall times. Duration has already been calculated from instants.
        start: shift.clockIn.slice(0, 16),
        finish: shift.clockOut.slice(0, 16),
        overnight: shift.day !== shift.clockOut.slice(0, 10),
        hours: hours(weekdays[i], saturdays[i], sundays[i]),
        status: shift.review,
        notes,
      };
    });
    return {
      name: person.staff.display_name,
      pending: person.pending,
      hours: hours(categories[0], categories[1], categories[2]),
      sessions,
    };
  });
}

const australianDate = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
export function displayDay(day: string) {
  return australianDate.format(new Date(day + "T00:00:00Z"));
}
function displayClock(local: string, includeDate: boolean) {
  const [day, time] = local.split("T");
  return includeDate ? displayDay(day) + " " + time : time;
}

function csvCell(value: string) {
  if (
    /^[\s\u0000-\u001f]*[=+@\-＝＋－＠]/u.test(value) ||
    /^[\t\r\n]/.test(value)
  )
    value = "'" + value;
  return '"' + value.replaceAll('"', '""') + '"';
}

export function reportCsv(report: Report, kind: "detail" | "summary") {
  const rows: string[] = [];
  let bytes = 3;
  function add(cells: string[]) {
    const row = cells.map(csvCell).join(",") + "\r\n";
    bytes += Buffer.byteLength(row);
    if (bytes > 12 * 1024 * 1024)
      throw new ReportInputError(
        "CSV exceeds 12 MiB. Choose fewer employees or a shorter period.",
      );
    rows.push(row);
  }
  const decimal = (hundredths: number) => (hundredths / 100).toFixed(2);
  if (kind === "detail") add(["Employee", ...sessionHeadings]);
  else
    add([
      ...overviewHeadings,
      "Weekend Hours",
      "Completed Sessions",
      "Pending Sessions",
    ]);
  for (const person of exportPeople(report)) {
    if (kind === "summary") {
      const h = person.hours;
      add([
        person.name,
        ...[
          h.weekday,
          h.saturday,
          h.sunday,
          h.total,
          h.saturday + h.sunday,
        ].map(decimal),
        String(person.sessions.length),
        String(person.pending),
      ]);
    } else {
      for (const shift of person.sessions) {
        const h = shift.hours;
        add([
          person.name,
          displayDay(shift.day),
          displayClock(shift.start, shift.overnight),
          displayClock(shift.finish, shift.overnight),
          ...[h.weekday, h.saturday, h.sunday, h.total].map(decimal),
          shift.status,
          shift.notes,
        ]);
      }
    }
  }
  return "\ufeff" + rows.join("");
}
