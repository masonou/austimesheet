import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  reportFilters,
  makeReport,
  decimalHours,
  ReportInputError,
} from "../src/lib/reports.ts";
import readExcelFile from "read-excel-file/node";
import { strFromU8, unzipSync } from "fflate";
import { reportCsv } from "../src/lib/report-export.ts";
import { reportWorkbook } from "../src/lib/report-workbook.ts";
import { getWeek } from "../src/lib/timesheets.ts";

const a = { id: randomUUID(), display_name: 'Jo, "Lee"', active: true };
const b = { id: randomUUID(), display_name: "=TEST", active: false };
const c = { id: randomUUID(), display_name: "Sam", active: true };
const zone = "Australia/Brisbane",
  monday = "2026-11-16",
  directory = [a, b, c];
const filters = (args = "", tz = zone) =>
  reportFilters(new URLSearchParams(args), tz, monday);
const range = (start, end, tz = zone) =>
  filters("period=custom&start=" + start + "&end=" + end, tz);
const session = (start, end, extra = {}) => ({
  id: randomUUID(),
  employee_id: a.id,
  started_at: start,
  ended_at: end,
  reviewed_at: null,
  voided_at: null,
  note: null,
  ...extra,
});
const hour = BigInt(3600_000_000_000);

test("Monday weeks, previous week, arbitrary fortnight start, strict inclusive range and employee IDs", () => {
  assert.equal(getWeek("2026-11-22", zone).key, monday);
  assert.equal(filters().last, "2026-11-22");
  assert.equal(filters("period=last-week").first, "2026-11-09");
  assert.equal(filters("period=fortnight&start=2026-11-19").last, "2026-12-02");
  assert.equal(range(monday, monday).end.toString(), "2026-11-16T14:00:00Z");
  for (const q of [
    "period=nothing",
    "period=custom&start=2026-02-30&end=2026-03-01",
    "period=custom&start=2025-01-01&end=2026-05-01",
    "period=custom&start=2026-11-17&end=2026-11-16",
    "period=custom",
    "employee=oops",
    "period=fortnight&period=custom",
  ])
    assert.throws(() => filters(q), ReportInputError);
  assert.throws(
    () =>
      filters(
        new URLSearchParams(
          Array.from({ length: 101 }, () => ["employee", a.id]),
        ),
      ),
    ReportInputError,
  );
  assert.throws(
    () => makeReport(filters("employee=" + randomUUID()), directory, []),
    ReportInputError,
  );
});

const shifts = [
  session("2026-11-20T22:00+10:00", "2026-11-21T02:00+10:00"),
  session("2026-11-21T23:00+10:00", "2026-11-22T02:00+10:00", {
    employee_id: b.id,
    reviewed_at: "2026-11-23T00:00Z",
    note: ' \t=2+2, "night"\r\nclose',
  }),
  session("2026-11-18T10:00+10:00", null),
  session("2026-11-18T10:00+10:00", "2026-11-18T18:00+10:00", {
    voided_at: "2026-11-23T00:00Z",
  }),
];
test("all, one or multiple staff, inactive historical staff, pending review, open and voided shifts", () => {
  const all = makeReport(filters(), directory, shifts);
  assert.equal(all.completed, 2);
  assert.equal(all.pending, 1);
  assert.deepEqual(all.hours, {
    weekday: 2n * hour,
    saturday: 3n * hour,
    sunday: 2n * hour,
    total: 7n * hour,
  });
  const selected = (ids) =>
    makeReport(
      filters(new URLSearchParams(ids.map((id) => ["employee", id]))),
      directory,
      shifts,
    );
  assert.deepEqual(
    selected([b.id]).people.map((p) => p.staff.id),
    [b.id],
  );
  assert.equal(selected([b.id]).hours.saturday, hour);
  assert.equal(selected([a.id, c.id]).hours.total, 4n * hour);
  assert.equal(selected([b.id, b.id]).completed, 1);
  assert.equal(makeReport(filters(), directory, []).people.length, 2);
});
test("range clipping uses half-open boundaries and retains sub-second precision", () => {
  const s = session(
    "2026-11-15T23:59:59.123456+10:00",
    "2026-11-17T00:00:00.654321+10:00",
  );
  const build = (lo, hi) => makeReport(range(lo, hi), directory, [s]);
  const left = build("2026-11-15", "2026-11-15"),
    day = build(monday, monday),
    right = build("2026-11-17", "2026-11-17");
  assert.equal(day.hours.total, 24n * hour);
  assert.equal(left.hours.total, 876544000n);
  assert.equal(right.hours.total, 654321000n);
  assert.equal(
    left.hours.total + day.hours.total + right.hours.total,
    build("2026-11-15", "2026-11-17").hours.total,
  );
  assert.equal(build("2026-11-18", "2026-11-18").completed, 0);
  assert.equal(
    makeReport(range(monday, monday), directory, [
      session("2026-11-15T22:00+10:00", "2026-11-16T00:00+10:00"),
    ]).completed,
    0,
  );
  assert.equal(decimalHours(18_000_000_000n), "0.01");
});
test("Sydney's 23- and 25-hour Sundays and Lord Howe's half-hour DST change", () => {
  for (const [day, tz, start, end, expected] of [
    [
      "2026-04-05",
      "Australia/Sydney",
      "2026-04-05T00:00+11:00",
      "2026-04-06T00:00+10:00",
      "25.00",
    ],
    [
      "2026-10-04",
      "Australia/Sydney",
      "2026-10-04T00:00+10:00",
      "2026-10-05T00:00+11:00",
      "23.00",
    ],
    [
      "2026-10-04",
      "Australia/Lord_Howe",
      "2026-10-04T00:00+10:30",
      "2026-10-05T00:00+11:00",
      "23.50",
    ],
  ]) {
    const r = makeReport(range(day, day, tz), directory, [session(start, end)]);
    assert.equal(decimalHours(r.hours.sunday), expected);
    assert.equal(r.completed, 1);
  }
});
// Read the quote-delimited CSV including embedded CRLF in a quoted cell.
function parseCsv(text) {
  assert(text.startsWith("\uFEFF"));
  const rows = [];
  let row = [];
  const cells = /"((?:""|[^"])*)"(,|\r\n)/gy;
  cells.lastIndex = 1;
  while (cells.lastIndex < text.length) {
    const m = cells.exec(text);
    assert(m);
    row.push(m[1].replaceAll('""', '"'));
    if (m[2] === "\r\n") {
      rows.push(row);
      row = [];
    }
  }
  const headers = rows.shift();
  return rows.map((r) => {
    assert.equal(r.length, headers.length);
    return Object.fromEntries(headers.map((h, i) => [h, r[i]]));
  });
}
test("compact CSV exports use one row per shift, readable clocks, safe names and notes, and no IDs", () => {
  const r = makeReport(filters(), directory, shifts);
  const details = parseCsv(reportCsv(r, "detail"));
  assert.equal(details.length, 2);
  assert.deepEqual(details[0], {
    Employee: a.display_name,
    Date: "20 Nov 2026",
    "Clock In": "20 Nov 2026 22:00",
    "Clock Out": "21 Nov 2026 02:00",
    "Weekday Hours": "2.00",
    "Saturday Hours": "2.00",
    "Sunday Hours": "0.00",
    "Total Hours": "4.00",
    Status: "Pending",
    Notes: "",
  });
  assert.equal(details[1].Employee, "'=TEST");
  assert.equal(details[1].Notes, "'" + shifts[1].note);
  assert.equal(details[1].Status, "Reviewed");
  const summary = parseCsv(reportCsv(r, "summary"));
  assert.equal(summary.length, 3);
  assert.equal(summary[1]["Weekend Hours"], "3.00");
  assert.equal(summary[0]["Pending Sessions"], "1");
  for (const kind of ["detail", "summary"])
    assert.deepEqual(
      parseCsv(reportCsv(makeReport(filters(), [], []), kind)),
      [],
    );
});

const generate = (report) =>
  reportWorkbook(report, "Harbour & Hill", new Date("2026-11-21T15:00Z"));
const reopen = async (report) =>
  readExcelFile(Buffer.from(await generate(report)), { trim: false });
const shiftsIn = (sheet) =>
  sheet.data.filter((row) => ["Reviewed", "Pending"].includes(row[7]));
const totalIn = (sheet, label) => sheet.data.find((row) => row[0] === label)[6];

test("team workbook reopens with an overview, local dates, numeric hours, frozen headers and an employee sheet per person", async () => {
  const r = makeReport(filters(), directory, shifts);
  const bytes = await generate(r);
  const [overview, jo, second, empty] = await readExcelFile(
    Buffer.from(bytes),
    { trim: false },
  );
  assert.deepEqual(
    [overview, jo, second, empty].map((s) => s.sheet),
    ["Overview", a.display_name, b.display_name, c.display_name],
  );
  assert.deepEqual(overview.data.at(-1), ["Overall total", 2, 3, 2, 7]);
  assert(
    overview.data.some(
      (row) => row[0] === a.display_name + " (pending review)",
    ),
  );
  assert(
    overview.data.some(
      (row) => row[0] === "Generated" && row[1] === "22 November 2026",
    ),
  );
  const [night] = shiftsIn(jo);
  assert.equal(shiftsIn(jo).length, 1); // voided and open entries are absent
  assert.deepEqual(night.slice(3, 8), [2, 2, 0, 4, "Pending"]);
  assert.equal(night[0].toISOString(), "2026-11-20T00:00:00.000Z");
  for (const [i, expected] of [
    [1, "2026-11-20T22:00Z"],
    [2, "2026-11-21T02:00Z"],
  ]) {
    assert(Math.abs(night[i].getTime() - Date.parse(expected)) <= 1);
  }
  assert.equal(totalIn(jo, "TOTAL HOURS"), 4);
  assert.equal(totalIn(second, "Total weekend hours"), 3);
  assert.equal(totalIn(empty, "TOTAL HOURS"), 0);
  assert.match(jo.data.at(-1)[0], /pending review/);
  const xml = unzipSync(bytes);
  const styles = strFromU8(xml["xl/styles.xml"]);
  for (const format of ["0.00", "dd mmm yyyy", "dd mmm yy hh:mm"])
    assert(styles.includes(format));
  const sheet = strFromU8(xml["xl/worksheets/sheet2.xml"]);
  for (const setting of [
    'state="frozen"',
    'ySplit="8"',
    'orientation="landscape"',
    'paperSize="9"',
    'showGridLines="false"',
  ])
    assert(sheet.includes(setting), setting);
  for (const [path, data] of Object.entries(xml)) {
    if (path.endsWith(".xml"))
      assert.doesNotMatch(strFromU8(data), /<f[ >]|Employee ID|Session ID/);
  }
});

test("individual workbook contains no foreign shared strings, worksheets, session references or hidden records", async () => {
  const only = makeReport(filters("employee=" + b.id), directory, shifts);
  const bytes = await generate(only);
  const sheets = await readExcelFile(Buffer.from(bytes));
  assert.deepEqual(
    sheets.map((s) => s.sheet),
    [b.display_name],
  );
  assert.equal(shiftsIn(sheets[0])[0][7], "Reviewed");
  const xml = Object.values(unzipSync(bytes))
    .map((file) => strFromU8(file))
    .join("\n");
  assert(xml.includes("=2+2"));
  for (const sensitive of [
    a.id,
    b.id,
    c.id,
    ...shifts.map((s) => s.id),
    c.display_name,
    "pending review)",
    "Jo,",
  ])
    assert(!xml.includes(sensitive));
  assert(!xml.includes("<f>"));
});

test("partial shifts preserve original clock dates, include only time inside the period and disclose clipping", async () => {
  const only = range("2026-11-21", "2026-11-21");
  const r = makeReport(only, directory, shifts);
  const [overview, jo, other] = await reopen(r);
  assert.deepEqual(overview.data.at(-1), ["Overall total", 0, 3, 0, 3]);
  for (const sheet of [jo, other]) {
    const [shift] = shiftsIn(sheet);
    assert.match(shift[8], /Only time within the reporting period/);
    assert.equal(shift[3], 0);
    assert.equal(shift[5], 0);
  }
  assert.equal(totalIn(jo, "TOTAL HOURS"), 2);
  assert.equal(totalIn(other, "TOTAL HOURS"), 1);
});

test("two-decimal shift rows, category totals and overview reconcile for split and very short sessions", async () => {
  const data = [
    session("2026-11-20T09:00:00+10:00", "2026-11-20T09:00:18.000001+10:00"),
    session("2026-11-20T13:00:00+10:00", "2026-11-20T13:00:18.000001+10:00"),
    session("2026-11-20T23:59:42+10:00", "2026-11-21T00:00:18+10:00"),
  ];
  const [overview, person] = await reopen(makeReport(filters(), [a], data));
  const details = shiftsIn(person);
  assert.equal(details.length, 3);
  assert.deepEqual(
    details.map((r) => r.slice(3, 7)),
    [
      [0.01, 0, 0, 0.01],
      [0, 0, 0, 0],
      [0.01, 0, 0, 0.01],
    ],
  );
  assert.equal(totalIn(person, "TOTAL HOURS"), 0.02);
  assert.deepEqual(overview.data.at(-1), ["Overall total", 0.02, 0, 0, 0.02]);
});

test("sheet tabs are unique after sanitising, truncating and reserving Excel names", async () => {
  const names = [
    "Overview",
    "overview",
    "History",
    "Sam / Lee",
    "Sam : Lee",
    " ?* ",
    "'Alex'",
    "A".repeat(30) + "🐨",
    "A".repeat(31) + " end",
    "A".repeat(32),
  ];
  const staff = names.map((display_name) => ({
    id: randomUUID(),
    display_name,
    active: true,
  }));
  const tabs = await reopen(makeReport(filters(), staff, []));
  const used = new Set();
  for (const { sheet } of tabs) {
    assert(sheet && sheet.length <= 31 && !used.has(sheet.toUpperCase()));
    assert(!/[\[\]\\/:*?]|^'|'$/.test(sheet));
    assert(sheet.isWellFormed());
    assert.notEqual(sheet.toLowerCase(), "history");
    used.add(sheet.toUpperCase());
  }
  assert.deepEqual(
    tabs.slice(1).map((s) => s.data[1][1]),
    names,
  );
});

test("repeated Sydney clock times show elapsed hours and explain the clock change", async () => {
  const local = range("2026-04-05", "2026-04-05", "Australia/Sydney");
  const r = makeReport(
    local,
    [a],
    [session("2026-04-05T02:15+11:00", "2026-04-05T02:15+10:00")],
  );
  const [, sheet] = await reopen(r);
  const [shift] = shiftsIn(sheet);
  assert.equal(shift[1].getTime(), shift[2].getTime());
  assert.deepEqual(shift.slice(3, 7), [0, 0, 1, 1]);
  assert.match(shift[8], /Clocks changed/);
});

test("empty reports reopen and oversized workbook selections give a useful error", async () => {
  const r = makeReport(filters(), [], []);
  const [empty] = await reopen(r);
  assert.deepEqual(empty.data.at(-1), ["Overall total", 0, 0, 0, 0]);
  const staff = Array.from({ length: 251 }, (_, i) => ({
    id: randomUUID(),
    display_name: "Employee " + i,
    active: true,
  }));
  await assert.rejects(
    generate(makeReport(filters(), staff, [])),
    /250 employees/,
  );
});
