import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  newPin,
  newToken,
  nextToken,
  openPin,
  pinVerifier,
  sealPin,
  tokenDigest,
  validPin,
} from "../src/lib/kiosk/crypto.ts";
import { elapsed, getWeek, hours } from "../src/lib/timesheets.ts";
import {
  applyUpgrade,
  testDatabase,
  workplace,
  roleQuery,
} from "./kiosk-db.mjs";

let db;
before(async () => {
  db = await testDatabase();
});
after(async () => {
  await db?.close();
});
const pepper = randomBytes(32).toString("hex"),
  key = randomBytes(32).toString("hex");
const rpc = async (role, actor, sql, args, conn = db) =>
  (await roleQuery(conn, role, actor, "select " + sql + " as result", args))[0]
    .result;
const admin = (f, sql, args) => rpc("authenticated", f.admin, sql, args);
const service = (sql, args) => rpc("service_role", null, sql, args);
const profile = (f) => admin(f, "employee_profile($1,$2)", [f.org, f.employee]);
async function assign(f, pin = "012345") {
  const verifier = await pinVerifier(f.org, pin, pepper),
    envelope = sealPin(f.org, f.employee, pin, key);
  await admin(f, "set_employee_pin($1,$2,$3,$4)", [
    f.org,
    f.employee,
    verifier,
    envelope,
  ]);
  return verifier;
}
function begin() {
  const token = newToken();
  return { token, digest: tokenDigest(token) };
}
const activate = (f, p, old = null) =>
  admin(f, "register_workplace_kiosk($1,'Counter',$2,$3)", [
    f.org,
    p.digest,
    old,
  ]);
const heartbeat = (p) =>
  service("kiosk_heartbeat($1,$2)", [
    p.digest,
    tokenDigest(nextToken(p.token, pepper)),
  ]);
async function paired(f) {
  const p = await begin();
  await activate(f, p);
  return p;
}
const clock = async (p, v, c, submission = randomUUID()) =>
  service("clock_with_pin($1,$2,$3,$4)", [
    p.digest,
    c ?? (await heartbeat(p)).challenge ?? randomUUID(),
    v,
    submission,
  ]);
const receipt = (p, c, r) =>
  service("kiosk_receipt($1,$2,$3)", [p.digest, c, r]);

test("encrypted PIN, scoped reveal, change/reveal audit, editable profile and optional linked email", async () => {
  const f = await workplace(db),
    other = await workplace(db);
  await db.query(
    "update auth.users set email='alex@example.test' where id=$1",
    [f.worker],
  );
  const before = await profile(f);
  assert.deepEqual(before, {
    id: f.employee,
    name: "Alex Lee",
    active: true,
    email: "alex@example.test",
    pinStatus: "none",
  });
  assert(validPin(newPin()));
  assert(!validPin("12345"));
  const verifier = await assign(f);
  const stored = (
    await db.query(
      "select sealed_pin,verifier from timesheet_private.employee_pins where employee_id=$1",
      [f.employee],
    )
  ).rows[0];
  assert.match(stored.sealed_pin, /^v1\.[a-f0-9]{68}$/);
  assert.equal(stored.verifier, verifier);
  assert.notEqual(stored.sealed_pin, sealPin(f.org, f.employee, "012345", key));
  assert.throws(() => openPin(other.org, f.employee, stored.sealed_pin, key));
  assert.throws(() => openPin(f.org, other.employee, stored.sealed_pin, key));
  const envelope = await admin(f, "read_employee_pin($1,$2)", [
    f.org,
    f.employee,
  ]);
  assert.equal(openPin(f.org, f.employee, envelope, key), "012345");
  assert.equal((await profile(f)).pinStatus, "assigned");
  const extra = (
    await db.query(
      "insert into employees(organisation_id,display_name) values($1,'Pat') returning id",
      [f.org],
    )
  ).rows[0].id;
  assert.equal((await profile({ ...f, employee: extra })).email, null);
  await assert.rejects(assign({ ...f, employee: extra }), { code: "23505" });
  await admin(f, "rename_employee($1,$2,$3)", [
    f.org,
    f.employee,
    "Alex Smith",
  ]);
  assert.equal((await profile(f)).name, "Alex Smith");
  assert.equal((await profile(f)).email, before.email);
  await assign(f, "000007");
  assert.deepEqual(
    (
      await db.query(
        "select event,actor_id from timesheet_private.pin_audit where employee_id=$1 order by id",
        [f.employee],
      )
    ).rows,
    ["pin_changed", "pin_revealed", "pin_changed"].map((event) => ({
      event,
      actor_id: f.admin,
    })),
  );
  assert.equal(
    openPin(
      f.org,
      f.employee,
      await admin(f, "read_employee_pin($1,$2)", [f.org, f.employee]),
      key,
    ),
    "000007",
  );
});

test("employee and foreign administrator cannot access profiles, PINs or kiosk management", async () => {
  const f = await workplace(db),
    other = await workplace(db),
    request = await begin();
  await assign(f);
  for (const actor of [f.worker, other.admin]) {
    for (const [sql, args] of [
      ["employee_profile($1,$2)", [f.org, f.employee]],
      ["read_employee_pin($1,$2)", [f.org, f.employee]],
      ["set_employee_pin($1,$2,$3,$4)", [f.org, f.employee, "x", "y"]],
      ["rename_employee($1,$2,'New')", [f.org, f.employee]],
      [
        "register_workplace_kiosk($1,'Counter',$2,null)",
        [f.org, request.digest],
      ],
      ["revoke_kiosk($1,$2)", [f.org, randomUUID()]],
    ])
      await assert.rejects(rpc("authenticated", actor, sql, args), {
        code: "42501",
      });
  }
  assert.equal(await profile({ ...other, employee: f.employee }), null);
  await assert.rejects(
    admin(other, "read_employee_pin($1,$2)", [other.org, f.employee]),
    /PIN unavailable/,
  );
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
      rpc(role, f.worker, "clock_with_pin($1,$2,$3,$4)", [
        request.digest,
        randomUUID(),
        "x",
        randomUUID(),
      ]),
      { code: "42501" },
    );
  }
  await assert.rejects(
    admin(f, "assign_employee_pin($1,$2,$3)", [f.org, f.employee, "x"]),
    { code: "42501" },
  );
  await assert.rejects(
    admin(f, "activate_kiosk($1,'Old',$2)", [f.org, request.digest]),
    { code: "42501" },
  );
});

test("upgrade retains legacy PIN attendance, review status and historical device references", async () => {
  const old = await testDatabase({ legacy: true });
  try {
    const f = await workplace(old),
      token = tokenDigest(newToken()),
      v = await pinVerifier(f.org, "012345", pepper);
    const call = (sql, args) => rpc("authenticated", f.admin, sql, args, old);
    await call("assign_employee_pin($1,$2,$3)", [f.org, f.employee, v]);
    await call("activate_kiosk($1,'Existing',$2)", [f.org, token]);
    await old.query(
      "insert into work_sessions(organisation_id,employee_id,started_at,ended_at,reviewed_at,reviewed_by,clock_in_device_id) select $1,$2,now()-interval '1 day',now()-interval '20 hours',now(),$3,id from kiosk_devices",
      [f.org, f.employee, f.admin],
    );
    const rows = async () =>
      (
        await old.query(
          "select to_jsonb(s) as session from work_sessions s order by started_at",
        )
      ).rows;
    const historic = await rows();
    await applyUpgrade(old);
    assert.deepEqual(await rows(), historic);
    assert.equal(
      (await call("employee_profile($1,$2)", [f.org, f.employee])).pinStatus,
      "legacy",
    );
    await assert.rejects(
      call("read_employee_pin($1,$2)", [f.org, f.employee]),
      /PIN unavailable/,
    );
    const ctx = await rpc(
      "service_role",
      null,
      "kiosk_context($1)",
      [token],
      old,
    );
    assert.equal(
      (
        await rpc(
          "service_role",
          null,
          "clock_with_pin($1,$2,$3,$4)",
          [token, ctx.challenge, v, randomUUID()],
          old,
        )
      ).action,
      "in",
    );
    await call("set_employee_pin($1,$2,$3,$4)", [
      f.org,
      f.employee,
      v,
      sealPin(f.org, f.employee, "012345", key),
    ]);
    assert.equal(
      (await call("employee_profile($1,$2)", [f.org, f.employee])).pinStatus,
      "assigned",
    );
  } finally {
    await old.close();
  }
});

test("registration is idempotent, exit requires the correct admin, reactivation preserves device history", async () => {
  const f = await workplace(db),
    p = begin(),
    other = await workplace(db);
  await Promise.all([activate(f, p), activate(f, p)]);
  await assert.rejects(admin(other, "exit_workplace_kiosk($1)", [p.digest]), {
    code: "42501",
  });
  await assert.rejects(
    admin({ ...f, admin: f.worker }, "exit_workplace_kiosk($1)", [p.digest]),
    { code: "42501" },
  );
  await admin(f, "exit_workplace_kiosk($1)", [p.digest]);
  assert.equal((await heartbeat(p)).status, "retired");
  await assert.rejects(activate(f, p));
  const fresh = begin();
  await activate(f, fresh, p.digest);
  assert.equal((await heartbeat(fresh)).status, "active");
  assert.notEqual((await heartbeat(p)).status, "active");
  await db.query(
    "update kiosk_devices set expires_at=now()-interval '1 second' where organisation_id=$1",
    [f.org],
  );
  assert.equal((await heartbeat(fresh)).status, "retired");
  assert.equal(await service("kiosk_context($1)", [fresh.digest]), null);
  assert.equal((await clock(fresh, tokenDigest("expired"))).status, "unauthorised");
  const replacement = begin();
  await activate(f, replacement, fresh.digest);
  assert.equal((await heartbeat(replacement)).status, "active");
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from kiosk_devices where organisation_id=$1",
        [f.org],
      )
    ).rows[0].n,
    1,
  );
});

test("rotation is recoverable across a lost response and revocation stops both credentials", async () => {
  const f = await workplace(db),
    p = await paired(f),
    v = await assign(f);
  const id = (
    await db.query(
      "update kiosk_devices set expires_at=now()+interval '2 days' where organisation_id=$1 returning id",
      [f.org],
    )
  ).rows[0].id;
  assert.equal((await heartbeat(p)).renewed, true);
  assert.equal((await heartbeat(p)).renewed, true);
  const token = nextToken(p.token, pepper),
    next = { token, digest: tokenDigest(token) };
  const reopened = await heartbeat(next);
  assert.equal(reopened.status, "active");
  assert.equal(reopened.renewed, false);
  const metadata = (
    await db.query(
      "select last_seen_at is not null and expires_at>now()+interval '89 days' as fresh from kiosk_devices where id=$1",
      [id],
    )
  ).rows[0];
  assert(metadata.fresh);
  await admin(f, "revoke_kiosk($1,$2)", [f.org, id]);
  for (const dev of [p, next]) {
    assert.equal((await heartbeat(dev)).status, "retired");
    assert.equal((await clock(dev, v)).status, "unauthorised");
  }
});

test("one-step clocking returns a receipt, coalesces replays and serialises competing kiosks", async () => {
  const f = await workplace(db),
    p = await paired(f),
    second = await paired(f),
    v = await assign(f);
  const c = (await heartbeat(p)).challenge,
    other = (await heartbeat(second)).challenge;
  const submission = randomUUID();
  assert.equal(await receipt(p, c, submission), null);
  const [first, replay, competing] = await Promise.all([
    clock(p, v, c, submission),
    clock(p, v, c, submission),
    clock(second, v, other),
  ]);
  assert.equal(first.status, "recorded");
  assert.equal(first.firstName, "Alex");
  assert.equal(first.action, "in");
  assert.deepEqual(first, replay);
  assert.equal(competing.status, "recent");
  assert.equal(
    (await clock(p, tokenDigest("wrong verifier"), c)).status,
    "stale",
  );
  assert.deepEqual(await receipt(p, c, submission), first);
  assert.equal(await receipt(second, c, submission), null);
  assert.equal(await receipt(p, c, randomUUID()), null);
  const shifts = async (uid) =>
    (
      await roleQuery(
        db,
        "authenticated",
        uid,
        "select to_jsonb(s) as session from work_sessions s where employee_id=$1 order by started_at",
        [f.employee],
      )
    ).map((r) => r.session);
  const [open] = await shifts(f.worker);
  assert.equal(elapsed(open), 0);
  assert(open.clock_in_device_id);
  await db.query(
    "update work_sessions set started_at=now()-interval '25 hours' where id=$1",
    [open.id],
  );
  assert.equal((await clock(second, v)).action, "out");
  assert.equal(hours(elapsed((await shifts(f.worker))[0])), "25h");
  assert.deepEqual(await shifts(f.admin), await shifts(f.worker));
  assert.deepEqual(await clock(p, v, c, submission), first);
  assert.equal((await shifts(f.worker)).length, 1);
  const cross = {
    started_at: "2026-11-22T23:00:00+10:00",
    ended_at: "2026-11-23T02:00:00+10:00",
  };
  assert.equal(
    hours(elapsed(cross, getWeek("2026-11-22", "Australia/Brisbane"))),
    "1h",
  );
  assert.equal(
    hours(elapsed(cross, getWeek("2026-11-23", "Australia/Brisbane"))),
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

test("incorrect, archived and foreign PINs cannot clock; five wrong attempts lock the device", async () => {
  const f = await workplace(db),
    p = await paired(f),
    v = await assign(f),
    other = await workplace(db);
  const foreign = await assign(other);
  assert.notEqual(v, foreign);
  assert.equal((await clock(p, foreign)).status, "invalid");
  await db.query("update employees set active=false where id=$1", [f.employee]);
  assert.equal((await clock(p, v)).status, "invalid");
  await assert.rejects(assign(f), /Employee unavailable/);
  for (let i = 3; i <= 5; i++)
    assert.equal(
      (await clock(p, foreign)).status,
      i === 5 ? "locked" : "invalid",
    );
  assert.equal((await clock(p, v)).status, "locked");
  assert.equal((await heartbeat(p)).locked, true);
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from work_sessions where employee_id=$1",
        [f.employee],
      )
    ).rows[0].n,
    0,
  );
});
