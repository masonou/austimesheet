import writeExcelFile, {
  type CellObject,
  type Sheet,
  type SheetData,
} from "write-excel-file/node";
import {
  displayDay,
  exportPeople,
  overviewHeadings,
  sessionHeadings,
  type ExportHours,
} from "./report-export.ts";
import { ReportInputError, type Report } from "./reports.ts";

type Person = ReturnType<typeof exportPeople>[number];
const green = "#174737";
const band: CellObject = {
  backgroundColor: green,
  textColor: "#FFFFFF",
  fontWeight: "bold",
  alignVertical: "center",
};
const rule: CellObject = {
  topBorderColor: "#CDDAD2",
  topBorderStyle: "thin",
  fontWeight: "bold",
};
const warning: CellObject = {
  textColor: "#704A16",
  backgroundColor: "#FBF3DE",
  wrap: true,
};
function text(value: string, style: CellObject = {}): CellObject {
  if (value.length > 32767)
    throw new ReportInputError(
      "A name or note exceeds Excel’s cell length limit. Use the CSV export for this report.",
    );
  // The writer indexes shared strings by object key. A trailing space preserves
  // the visible label for names such as "constructor" that collide with that index.
  return {
    ...style,
    type: String,
    value: Object.hasOwn(Object.prototype, value) ? value + " " : value,
  };
}
function amount(hundredths: number, style: CellObject = {}): CellObject {
  return {
    ...style,
    type: Number,
    value: hundredths / 100,
    format: "0.00",
    align: "right",
  };
}
function hourCells(h: ExportHours, style: CellObject = {}) {
  return [h.weekday, h.saturday, h.sunday, h.total].map((n) =>
    amount(n, style),
  );
}
function merged(value: string, count: number, style: CellObject = {}) {
  return [
    text(value, { ...style, columnSpan: count }),
    ...Array<null>(count - 1).fill(null),
  ];
}

function sheetName(name: string, used: Set<string>) {
  const clean =
    name
      .normalize("NFC")
      .replace(/[\[\]\\/:*?\p{C}\ufffd]/gu, " ")
      .replace(/\s+/g, " ")
      .replace(/^['\s]+|['\s]+$/g, "") || "Employee";
  // Excel's 31 UTF-16 units must not split a surrogate pair, or end in an apostrophe.
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : " (" + n + ")";
    const stem = clean
      .slice(0, 31 - suffix.length)
      .replace(/[\uD800-\uDBFF]$/u, "")
      .replace(/['\s]+$/u, "");
    const candidate = (stem || "Employee") + suffix;
    const key = candidate.toUpperCase();
    if (!used.has(key)) {
      used.add(key);
      return candidate;
    }
  }
}

type Metadata = {
  business: string;
  period: string;
  generated: string;
  zone: string;
};
function heading(
  meta: Metadata,
  headings: string[],
  employee?: string,
): SheetData {
  const values = [
    ...(employee === undefined ? [] : [["Employee", employee]]),
    ["Business", meta.business],
    ["Period", meta.period],
    ["Generated", meta.generated],
    ["Timezone", meta.zone],
  ];
  return [
    merged(
      employee === undefined
        ? "Shiftbook — Timesheet Report"
        : "Shiftbook — Employee Timesheet",
      headings.length,
      { ...band, height: 29, fontSize: 15 },
    ),
    ...values.map(([label, value]) => [
      text(label, { fontWeight: "bold", textColor: green }),
      ...merged(value, headings.length - 1),
    ]),
    [],
    headings.map((label) => text(label, { ...band, height: 32, wrap: true })),
  ];
}
function worksheet(
  sheet: string,
  data: SheetData,
  widths: number[],
): Sheet<Buffer> {
  return {
    sheet,
    data,
    columns: widths.map((width) => ({ width })),
    stickyRowsCount: data.length,
    showGridLines: false,
    orientation: "landscape",
  };
}

function overview(people: Person[], meta: Metadata) {
  const rows = heading(meta, overviewHeadings);
  const sheet = worksheet("Overview", rows, [37, 18, 18, 18, 17]);
  const totals = { weekday: 0, saturday: 0, sunday: 0, total: 0 };
  for (const person of people) {
    const h = person.hours;
    totals.weekday += h.weekday;
    totals.saturday += h.saturday;
    totals.sunday += h.sunday;
    totals.total += h.total;
    rows.push([
      text(
        person.name + (person.pending ? " (pending review)" : ""),
        person.pending ? warning : { wrap: true },
      ),
      ...hourCells(h),
    ]);
  }
  if (!people.length)
    rows.push(
      merged("No employees with reportable time in this selection.", 5),
    );
  rows.push([text("Overall total", band), ...hourCells(totals, band)]);
  return sheet;
}

// Excel stores calendar values without a timezone. Use UTC only as a carrier for
// the already-local date and minute, independent of the server's timezone.
function calendarCell(local: string, format: string): CellObject {
  return { type: Date, value: new Date(local + "Z"), format, align: "left" };
}
function employeeSheet(person: Person, name: string, meta: Metadata) {
  const rows = heading(meta, sessionHeadings, person.name);
  const sheet = worksheet(name, rows, [14, 18, 18, 10, 10, 10, 10, 11, 25]);
  for (const shift of person.sessions) {
    const format = shift.overnight ? "dd mmm yy hh:mm" : "hh:mm";
    rows.push([
      calendarCell(shift.day + "T00:00", "dd mmm yyyy"),
      calendarCell(shift.start, format),
      calendarCell(shift.finish, format),
      ...hourCells(shift.hours),
      text(shift.status, shift.status === "Pending" ? warning : {}),
      text(shift.notes, { wrap: true }),
    ]);
  }
  if (!person.sessions.length)
    rows.push(merged("No completed work sessions in this period.", 9));
  rows.push([]);
  const h = person.hours;
  for (const [label, value] of [
    ["Total weekday hours", h.weekday],
    ["Total Saturday hours", h.saturday],
    ["Total Sunday hours", h.sunday],
    ["Total weekend hours", h.saturday + h.sunday],
    ["TOTAL HOURS", h.total],
  ] as const) {
    const style = label === "TOTAL HOURS" ? { ...band, height: 23 } : rule;
    rows.push([...merged(label, 6, style), amount(value, style)]);
  }
  if (person.pending)
    rows.push(
      merged(
        person.pending === 1
          ? "1 completed session is pending review and included in these totals."
          : person.pending +
              " completed sessions are pending review and included in these totals.",
        9,
        warning,
      ),
    );
  return sheet;
}

export async function reportWorkbook(
  report: Report,
  business: string,
  generated: Date,
) {
  if (report.people.length > 250)
    throw new ReportInputError(
      "Excel workbooks support up to 250 employees per download. Select fewer employees or use CSV.",
    );
  const { first, last, zone } = report.filters;
  const meta = {
    business,
    zone,
    period: displayDay(first) + " – " + displayDay(last),
    generated: new Intl.DateTimeFormat("en-AU", {
      dateStyle: "long",
      timeZone: zone,
    }).format(generated),
  };
  const people = exportPeople(report);
  const sheets: Sheet<Buffer>[] = [];
  const used = new Set(["HISTORY", "OVERVIEW"]);
  if (report.filters.ids.length !== 1) sheets.push(overview(people, meta));
  for (const person of people)
    sheets.push(employeeSheet(person, sheetName(person.name, used), meta));
  const buffer = await writeExcelFile(sheets, {
    fontFamily: "Calibri",
    fontSize: 10,
  }).toBuffer();
  if (buffer.length > 12 * 1024 * 1024)
    throw new ReportInputError(
      "Excel file exceeds 12 MiB. Choose fewer employees or a shorter period.",
    );
  return new Uint8Array(buffer);
}
