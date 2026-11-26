import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabase, workplace, roleQuery } from "./kiosk-db.mjs";
import {
  elapsed,
  getWeek,
  hours,
  shiftChoices,
  shiftField,
} from "../src/lib/timesheets.ts";

let db;
before(async () => {
  db = await testDatabase();
});
after(async () => {
  await db.close();
});
const start = "2025-11-19T17:00:00.123456+10:00",
  finish = "2025-11-19T22:30:00.123456+10:00";
function change(f, id, operation, revision, fields = {}, actor = f.admin) {
  const args = {
    org: f.org,
    employee: f.employee,
    id,
    operation,
    revision,
    start,
    finish,
    note: "Dinner",
    reason: "Missed clock-in",
    ...fields,
  };
  return roleQuery(
    db,
    "authenticated",
    actor,
    "select public.manage_work_session($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    Object.values(args),
  );
}
function history(f, id, actor = f.admin) {
  return roleQuery(
    db,
    "authenticated",
    actor,
    "select * from timesheet_edit_history where session_id=$1 order by changed_at",
    [id],
  );
}
async function session(f, id) {
  const rows = await roleQuery(
    db,
    "authenticated",
    f.worker,
    "select to_jsonb(s) as record from work_sessions s where id=$1",
    [id],
  );
  return rows[0]?.record;
}

test("manual creation, review, reopen, corrections and void are atomic and visible to the employee", async () => {
  const f = await workplace(db),
    id = randomUUID();
  await change(f, id, "create", null, { reason: "" });
  await assert.rejects(change(f, id, "create", null));
  assert.equal((await session(f, id)).created_by, f.admin);
  assert.equal(hours(elapsed(await session(f, id))), "5h 30m");
  await change(f, id, "review", 1);
  assert.equal((await session(f, id)).reviewed_by, f.admin);
  await assert.rejects(change(f, id, "edit", 2), /Reopen/);
  await change(f, id, "reopen", 2);
  await assert.rejects(change(f, id, "edit", 1), /Session changed/);
  assert.equal((await session(f, id)).reviewed_at, null);
  const extended = "2025-11-19T23:00:00.123456+10:00";
  await change(f, id, "edit", 3, {
    finish: extended,
    reason: "",
  });
  await change(f, id, "edit", 4, {
    finish: extended,
    note: "Late close",
    reason: null,
  });
  assert.equal(hours(elapsed(await session(f, id))), "6h");
  const audit = await history(f, id);
  assert.deepEqual(
    audit.map((x) => x.event),
    ["create", "review", "reopen", "edit", "edit"],
  );
  assert(audit.every((x) => x.changed_by === f.admin && x.changed_at));
  assert.equal(audit[0].before_state, null);
  assert.equal(audit[0].reason, "Manually created");
  assert.equal(audit[3].before_state.ended_at, audit[0].after_state.ended_at);
  assert.match(audit[3].before_state.started_at, /123456/);
  assert.equal(audit[3].reason, "Session edited");
  assert.equal(audit[4].before_state.note, "Dinner");
  assert.equal(audit[4].after_state.note, "Late close");
  await change(f, id, "void", 5, { reason: "" });
  assert.equal(elapsed(await session(f, id)), 0);
  assert.equal((await history(f, id)).at(-1).event, "void");
  assert.equal((await history(f, id)).at(-1).reason, "Session voided");
  await change(f, randomUUID(), "create", null);
});

test("invalid intervals, overlaps, open-session review and stale kiosk edits are rejected", async () => {
  const f = await workplace(db),
    id = randomUUID();
  await change(f, id, "create", null);
  for (const invalid of [
    { finish: start },
    { finish: null },
    { finish: "infinity" },
    { start: "-infinity" },
    { finish: "2999-01-01Z" },
  ]) {
    await assert.rejects(change(f, randomUUID(), "create", null, invalid));
  }
  await assert.rejects(change(f, randomUUID(), "create", null), {
    code: "23P01",
  });
  const adjacent = randomUUID();
  await change(f, adjacent, "create", null, {
    start: finish,
    finish: "2025-11-20T01:00+10:00",
  });
  await assert.rejects(
    change(f, id, "edit", 1, { finish: "2025-11-19T23:00+10:00" }),
    { code: "23P01" },
  );
  assert.equal((await history(f, id)).length, 1);
  const open = randomUUID();
  await db.query(
    "insert into work_sessions(id,organisation_id,employee_id,started_at) values($1,$2,$3,now()-interval '1 hour')",
    [open, f.org, f.employee],
  );
  await assert.rejects(change(f, open, "review", 1), /Open sessions/);
  await db.query("update work_sessions set ended_at=now() where id=$1", [open]);
  await assert.rejects(change(f, open, "edit", 1), /Session changed/);
});

test("employee and foreign admin cannot mutate sessions or access correction history", async () => {
  const f = await workplace(db),
    other = await workplace(db),
    id = randomUUID();
  await change(f, id, "create", null);
  for (const actor of [f.worker, other.admin]) {
    for (const operation of ["create", "edit", "review", "reopen", "void"]) {
      await assert.rejects(change(f, id, operation, 1, {}, actor), {
        code: "42501",
      });
    }
    assert.deepEqual(await history(f, id, actor), []);
    await assert.rejects(
      roleQuery(
        db,
        "authenticated",
        actor,
        "update work_sessions set note='x' where id=$1",
        [id],
      ),
      { code: "42501" },
    );
  }
  await assert.rejects(change(other, id, "edit", 1), /unavailable/);
  await assert.rejects(
    change(other, randomUUID(), "create", null, { employee: f.employee }),
    /unavailable/,
  );
  assert.equal(await session(other, id), undefined);
});

test("workplace time entry preserves microseconds, rejects gaps and distinguishes both DST occurrences", () => {
  const zone = "Australia/Sydney";
  assert.deepEqual(shiftChoices("2025-10-05T02:30", zone), []);
  const repeated = shiftChoices("2025-04-06T02:30", zone);
  assert.deepEqual(
    repeated.map((x) => x.offset),
    ["+11:00", "+10:00"],
  );
  assert.equal(
    hours(
      elapsed({
        started_at: repeated[0].instant,
        ended_at: repeated[1].instant,
      }),
    ),
    "1h",
  );
  const source = "2025-04-06T02:30:00.123456+10:00";
  assert.equal(
    shiftChoices(shiftField(source, zone), zone, source)[1].instant,
    source,
  );
  const precise = "2025-04-06T02:30:47.123456+10:00";
  assert.equal(shiftField(precise, zone), "2025-04-06T02:30");
  assert.equal(shiftChoices(shiftField(precise, zone), zone, precise)[1].instant, precise);
  assert.equal(hours(7000), "0m");
  assert.equal(hours(45000), "0m");
  assert.equal(hours(3599000), "0h 59m");
  const overnight = {
    started_at: "2025-10-04T22:00+10:00",
    ended_at: "2025-10-05T06:00+11:00",
  };
  assert.equal(hours(elapsed(overnight)), "7h");
  const boundary = {
    started_at: "2025-11-23T23:00:00.000001+11:00",
    ended_at: "2025-11-24T01:00:00.000002+11:00",
  };
  assert.equal(elapsed(boundary, getWeek("2025-11-23", zone)), 3600000);
  assert.equal(elapsed(boundary, getWeek("2025-11-24", zone)), 3600000);
});

test("shift durations discard seconds from each clock time before calculating minutes", () => {
  for (const [start, finish, minutes] of [
    ["07:00:00.000001", "13:30:59.999999", 390],
    ["07:01:00", "13:30:59.999999", 389],
    ["07:00:59.999999", "13:30:00", 390],
    ["13:13:59.999999", "13:14:00", 1],
    ["13:13:00", "13:13:59.999999", 0],
  ]) {
    const duration = elapsed({
      started_at: "2026-11-26T" + start + "+10:00",
      ended_at: "2026-11-26T" + finish + "+10:00",
    });
    assert.equal(duration, minutes * 60000);
  }
  const first = elapsed({
    started_at: "2026-11-26T07:00:00+10:00",
    ended_at: "2026-11-26T13:30:59+10:00",
  });
  const second = elapsed({
    started_at: "2026-11-27T07:00:59+10:00",
    ended_at: "2026-11-27T13:30:00+10:00",
  });
  assert.equal(hours(first), "6h 30m");
  assert.equal(hours(first + second), "13h");
});
