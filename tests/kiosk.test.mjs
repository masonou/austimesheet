import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  newPin,
  newToken,
  pinVerifier,
  tokenDigest,
  validPin,
} from "../src/lib/kiosk/crypto.ts";
import { elapsed, getWeek, hours } from "../src/lib/timesheets.ts";
import { testDatabase, workplace, roleQuery } from "./kiosk-db.mjs";

let db;
before(async () => {
  db = await testDatabase();
});
after(async () => {
  await db?.close();
});
const pepper = randomBytes(32).toString("hex");
const adminCall = (actor, sql, args) =>
  roleQuery(db, "authenticated", actor, sql, args);
const kioskCall = async (sql, args) =>
  (
    await roleQuery(
      db,
      "service_role",
      null,
      "select " + sql + " as result",
      args,
    )
  )[0].result;
const assign = (f, verifier) =>
  adminCall(f.admin, "select assign_employee_pin($1,$2,$3)", [
    f.org,
    f.employee,
    verifier,
  ]);
const activate = async (f) => {
  const token = tokenDigest(newToken());
  await adminCall(f.admin, "select activate_kiosk($1,'Front counter',$2)", [
    f.org,
    token,
  ]);
  return token;
};
const context = (device) => kioskCall("kiosk_context($1)", [device]);
const verify = async (device, verifier, challenge) => {
  const ticket = tokenDigest(newToken());
  const reply = await kioskCall("verify_kiosk_pin($1,$2,$3,$4)", [
    device,
    challenge ?? (await context(device))?.challenge ?? null,
    verifier,
    ticket,
  ]);
  return { ...reply, ticket };
};
const record = (device, ticket) =>
  kioskCall("record_kiosk_attendance($1,$2)", [device, ticket]);
async function fixture() {
  const f = await workplace(db);
  const verifier = await pinVerifier(f.org, "012345", pepper);
  await assign(f, verifier);
  return { ...f, verifier, device: await activate(f) };
}

test("PIN derivation preserves leading zeros, uses the secret and organisation, and enforces six digits", async () => {
  assert(validPin("012345"));
  assert(!validPin("12345"));
  assert(!validPin("12a456"));
  assert(validPin(newPin()));
  const a = await pinVerifier("a", "012345", pepper);
  assert.equal(a, await pinVerifier("a", "012345", pepper));
  assert.notEqual(a, await pinVerifier("b", "012345", pepper));
  assert.notEqual(
    a,
    await pinVerifier("a", "012345", randomBytes(32).toString("hex")),
  );
});

test("admin assigns a unique PIN; employee, anonymous and foreign callers lack management or credential access", async () => {
  const f = await fixture(),
    other = await workplace(db);
  const extra = (
    await db.query(
      "insert into employees(organisation_id,display_name) values($1,'Other') returning id",
      [f.org],
    )
  ).rows[0].id;
  await assert.rejects(assign({ ...f, employee: extra }, f.verifier), {
    code: "23505",
  });
  await assert.rejects(assign({ ...f, admin: f.worker }, f.verifier), {
    code: "42501",
  });
  await assert.rejects(assign({ ...f, admin: other.admin }, f.verifier), {
    code: "42501",
  });
  await assert.rejects(
    assign({ ...f, employee: other.employee }, f.verifier),
    /Employee unavailable/,
  );
  await assert.rejects(activate({ ...f, admin: f.worker }), { code: "42501" });
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(
      roleQuery(
        db,
        role,
        f.worker,
        "select * from timesheet_private.employee_pins",
      ),
      { code: "42501" },
    );
    await assert.rejects(
      roleQuery(db, role, f.worker, "select kiosk_context($1)", [f.device]),
      { code: "42501" },
    );
    await assert.rejects(
      roleQuery(db, role, f.worker, "select record_kiosk_attendance($1,$2)", [
        f.device,
        f.verifier,
      ]),
      { code: "42501" },
    );
  }
  const otherDevice = await activate(other);
  assert.equal((await verify(otherDevice, f.verifier)).status, "invalid");
  const sameDigits = await pinVerifier(other.org, "012345", pepper);
  await assign(other, sameDigits);
  assert.equal((await verify(otherDevice, sameDigits)).status, "ready");
});

test("two kiosks, duplicate submissions and stale clock-outs cannot toggle attendance; completed hours reach both dashboard roles", async () => {
  const f = await fixture(),
    second = await activate(f);
  const a = await verify(f.device, f.verifier),
    b = await verify(second, f.verifier);
  assert.deepEqual([a.status, a.firstName, a.action], ["ready", "Alex", "in"]);
  assert.equal((await record(second, a.ticket)).status, "stale");
  const results = await Promise.all([
    record(f.device, a.ticket),
    record(second, b.ticket),
    record(f.device, a.ticket),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [
    "recorded",
    "stale",
    "stale",
  ]);
  // PostgREST delivers timestamps as JSON strings, including fractional seconds.
  const shifts = async (uid) =>
    (await adminCall(
      uid,
      "select to_jsonb(s) as session from work_sessions s where organisation_id=$1 order by started_at",
      [f.org],
    )).map(row => row.session);
  const [open] = await shifts(f.worker);
  assert.equal(open.ended_at, null);
  assert.equal(elapsed(open), 0);
  assert(open.clock_in_device_id);
  const out = await verify(second, f.verifier),
    redundant = await verify(f.device, f.verifier);
  assert.equal(out.action, "out");
  assert.equal((await record(second, out.ticket)).status, "recorded");
  assert.equal((await record(f.device, redundant.ticket)).status, "stale");
  for (const action of ["in", "out"]) {
    const fresh = await verify(f.device, f.verifier);
    assert.equal(fresh.action, action);
    assert.equal((await record(f.device, fresh.ticket)).status, "recorded");
  }
  const rows = await shifts(f.worker);
  assert.equal(rows.length, 2);
  assert(rows.every((row) => row.clock_out_device_id && row.ended_at));
  assert.notEqual(hours(rows.reduce((sum, s) => sum + elapsed(s), 0)), "0h");
  assert.deepEqual(await shifts(f.admin), rows);
  const other = await workplace(db);
  assert.deepEqual(await shifts(other.admin), []);
});

test("unregistered, expired and revoked kiosks cannot verify or record, even with an issued ticket", async () => {
  const f = await fixture(),
    fake = tokenDigest(newToken());
  assert.equal(await context(fake), null);
  assert.equal((await verify(fake, f.verifier)).status, "unauthorised");
  assert.equal((await record(fake, f.verifier)).status, "unauthorised");
  const stale = await verify(f.device, f.verifier);
  const device = (
    await db.query("select id from kiosk_devices where organisation_id=$1", [
      f.org,
    ])
  ).rows[0].id;
  const foreign = await workplace(db);
  await assert.rejects(
    adminCall(foreign.admin, "select revoke_kiosk($1,$2)", [
      foreign.org,
      device,
    ]),
    /Device unavailable/,
  );
  await adminCall(f.admin, "select revoke_kiosk($1,$2)", [f.org, device]);
  assert.equal(await context(f.device), null);
  assert.equal((await record(f.device, stale.ticket)).status, "unauthorised");
  const expired = await activate(f);
  await db.query(
    "update kiosk_devices set expires_at=now() where organisation_id=$1",
    [f.org],
  );
  assert.equal((await verify(expired, f.verifier)).status, "unauthorised");
});

test("renewing this browser retires its former credential and preserves the registration history", async () => {
  const f = await fixture(),
    replacement = tokenDigest(newToken());
  await adminCall(
    f.admin,
    "select activate_kiosk($1,'Counter renewed',$2,$3)",
    [f.org, replacement, f.device],
  );
  assert.equal(await context(f.device), null);
  assert.equal((await context(replacement)).name, "Counter renewed");
  const rows = await adminCall(
    f.admin,
    "select revoked_at from kiosk_devices where organisation_id=$1",
    [f.org],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((d) => d.revoked_at).length, 1);
});

test("incorrect PINs consume fresh attempts, repeated invalid attempts lock the device and the lock expires", async () => {
  const f = await fixture(),
    bad = await pinVerifier(f.org, "567890", pepper),
    initial = await context(f.device);
  assert.equal(
    (await verify(f.device, bad, initial.challenge)).status,
    "invalid",
  );
  assert.equal(
    (await verify(f.device, bad, initial.challenge)).status,
    "stale",
  );
  for (let i = 2; i <= 5; i++)
    assert.equal(
      (await verify(f.device, bad)).status,
      i === 5 ? "locked" : "invalid",
    );
  assert.equal((await verify(f.device, f.verifier)).status, "locked");
  await db.query(
    "update timesheet_private.kiosk_credentials set locked_until=now()-interval '1 second',window_start=now()-interval '11 minutes' where digest=$1",
    [f.device],
  );
  assert.equal((await verify(f.device, f.verifier)).status, "ready");
});

test("PIN reset, verification timeout and deactivation invalidate confirmations and prevent clocking", async () => {
  const f = await fixture(),
    old = await verify(f.device, f.verifier);
  const replacement = await pinVerifier(f.org, "654321", pepper);
  await assign(f, replacement);
  assert.equal((await record(f.device, old.ticket)).status, "stale");
  assert.equal((await verify(f.device, f.verifier)).status, "invalid");
  const timed = await verify(f.device, replacement);
  await db.query(
    "update timesheet_private.kiosk_credentials set ticket_until=now() where digest=$1",
    [f.device],
  );
  assert.equal((await record(f.device, timed.ticket)).status, "stale");
  const pending = await verify(f.device, replacement);
  await db.query("update employees set active=false where id=$1", [f.employee]);
  assert.equal((await record(f.device, pending.ticket)).status, "stale");
  assert.equal((await verify(f.device, replacement)).status, "invalid");
  await assert.rejects(assign(f, replacement), /Employee unavailable/);
});

test("closes an overnight session; week totals allocate completed elapsed time across local Monday and DST", async () => {
  const f = await fixture();
  await db.query(
    "insert into work_sessions(organisation_id,employee_id,started_at) values($1,$2,now()-interval '25 hours')",
    [f.org, f.employee],
  );
  const ready = await verify(f.device, f.verifier);
  assert.equal(ready.action, "out");
  assert.equal((await record(f.device, ready.ticket)).status, "recorded");
  const [row] = await adminCall(
    f.worker,
    "select * from work_sessions where employee_id=$1",
    [f.employee],
  );
  assert.equal(hours(elapsed(row)), "25h");
  const crossWeek = {
    started_at: "2026-11-22T23:00:00+10:00",
    ended_at: "2026-11-23T02:00:00+10:00",
  };
  assert.equal(
    hours(elapsed(crossWeek, getWeek("2026-11-22", "Australia/Brisbane"))),
    "1h",
  );
  assert.equal(
    hours(elapsed(crossWeek, getWeek("2026-11-23", "Australia/Brisbane"))),
    "2h",
  );
  assert.equal(
    hours(
      elapsed({
        started_at: "2026-10-04T01:00:00+10:00",
        ended_at: "2026-10-04T04:00:00+11:00",
      }),
    ),
    "2h",
  );
});
