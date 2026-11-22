import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  reportFilters,
  makeReport,
  decimalHours,
  reportCsv,
  ReportInputError,
} from "../src/lib/reports.ts";
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
test("CSV separates daily allocations and employee totals, retains offsets, escapes untrusted spreadsheet fields", () => {
  const r = makeReport(filters(), directory, shifts);
  const csv = (kind) =>
    parseCsv(reportCsv(r, "@Cafe", kind, "2026-11-22T00:00Z"));
  const details = csv("detail");
  assert.equal(details.length, 4);
  assert.equal(details[0]["Weekday hours"], "2.00");
  assert.equal(details[1]["Saturday hours"], "2.00");
  assert.equal(
    details[1]["Allocation start (local)"],
    "2026-11-21T00:00:00+10:00",
  );
  assert.equal(details[0].Business, "'@Cafe");
  assert.equal(details[0]["Employee name"], a.display_name);
  assert.equal(details[3]["Employee name"], "'=TEST");
  assert.equal(details[3].Notes, "'" + shifts[1].note);
  assert.equal(details[3]["Review status"], "Reviewed");
  assert.equal(details[0]["Review status"], "Pending");
  const summary = csv("summary");
  assert.equal(summary.length, 3);
  assert.equal(summary[1]["Weekend hours"], "3.00");
  assert.equal(summary[0]["Pending sessions"], "1");
  const empty = makeReport(filters(), [], []);
  for (const kind of ["detail", "summary"])
    assert.equal(
      parseCsv(reportCsv(empty, "Cafe", kind, "now"))[0]["Record type"],
      "Empty report",
    );
});
