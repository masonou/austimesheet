import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { workplace, roleQuery, testDatabase } from "./kiosk-db.mjs";
import {
  newToken,
  tokenDigest,
  sealPin,
  pinVerifier,
} from "../src/lib/kiosk/crypto.ts";

let db;
before(async () => {
  db = await testDatabase();
});
after(async () => {
  await db?.close();
});
const rpc = async (role, uid, name, args) =>
  (
    await roleQuery(
      db,
      role,
      uid,
      "select public." +
        name +
        "(" +
        args.map((_, i) => "$" + (i + 1)).join(",") +
        ") as result",
      args,
    )
  )[0].result;
const asUser = (uid, name, args) => rpc("authenticated", uid, name, args);
const service = (name, args) => rpc("service_role", null, name, args);
const key = "ab".repeat(32),
  pepper = "cd".repeat(32);
async function create(
  f,
  { id = randomUUID(), mail = null, pin = "012345", actor = f.admin } = {},
) {
  const verifier = await pinVerifier(f.org, pin, pepper);
  const inserted = await asUser(actor, "create_employee", [
    f.org,
    id,
    "Jordan Lee",
    mail,
    verifier,
    sealPin(f.org, id, pin, key),
  ]);
  return { id, verifier, inserted };
}
const profile = (f, id) => asUser(f.admin, "employee_profile", [f.org, id]);
const prepare = (f, id, mail) =>
  asUser(f.admin, "prepare_employee_invite", [f.org, id, mail]);
const active = (f, id, enabled) =>
  asUser(f.admin, "set_employee_active", [f.org, id, enabled]);
async function authUser(mail, confirmed = true) {
  const uid = randomUUID();
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at,encrypted_password) values($1,$2,case when $3 then now() end,'fixture-hash')",
    [uid, mail, confirmed],
  );
  return uid;
}

test("atomic kiosk-only creation, PIN uniqueness, request retries and later account linking preserve shifts", async () => {
  const f = await workplace(db),
    e = await create(f);
  assert(e.inserted);
  assert.equal((await create(f, { id: e.id })).inserted, false);
  assert.equal((await profile(f, e.id)).accountStatus, "Kiosk only");
  await assert.rejects(create(f), { code: "23505" });
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from employees where organisation_id=$1",
        [f.org],
      )
    ).rows[0].n,
    2,
  );
  const digest = tokenDigest(newToken());
  await asUser(f.admin, "register_workplace_kiosk", [
    f.org,
    "Counter",
    digest,
    null,
  ]);
  const clock = async () => {
    const ctx = await service("kiosk_context", [digest]);
    return service("clock_with_pin", [
      digest,
      ctx.challenge,
      e.verifier,
      randomUUID(),
    ]);
  };
  assert.equal((await clock()).action, "in");
  await db.query(
    "update work_sessions set started_at=now()-interval '5 minutes' where employee_id=$1",
    [e.id],
  );
  assert.equal((await clock()).action, "out");
  const mail = "jordan@example.test",
    uid = await authUser(mail);
  const ticket = await prepare(f, e.id, mail);
  assert.equal(await asUser(uid, "employee_invite_details", [ticket]), null);
  assert(await service("finish_employee_invite", [ticket, true]));
  assert.deepEqual(
    await roleQuery(db, "authenticated", uid, "select id from work_sessions"),
    [],
  );
  assert.equal(await asUser(uid, "accept_employee_invite", [ticket]), f.org);
  const shifts = () =>
    roleQuery(
      db,
      "authenticated",
      uid,
      "select id,employee_id from work_sessions",
    );
  const recorded = await shifts();
  assert.equal(recorded[0].employee_id, e.id);
  assert.equal((await profile(f, e.id)).accountStatus, "Linked");
  await assert.rejects(asUser(uid, "accept_employee_invite", [ticket]));
  await active(f, e.id, false);
  assert.equal((await clock()).status, "invalid");
  assert.deepEqual(await shifts(), []);
  await active(f, e.id, true);
  assert.deepEqual(await shifts(), recorded);
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from timesheet_private.pin_audit where employee_id=$1",
        [e.id],
      )
    ).rows[0].n,
    1,
  );
});

test("delivery failures can be retried, superseded links fail, account ID and confirmed email are both required", async () => {
  const f = await workplace(db),
    mail = "new@example.test",
    e = await create(f, { mail }),
    uid = await authUser(mail, false);
  await assert.rejects(create(f, { mail: mail.toUpperCase(), pin: "999999" }), {
    code: "23505",
  });
  assert.equal((await profile(f, e.id)).email, mail);
  const first = await prepare(f, e.id, mail);
  assert.equal(await service("finish_employee_invite", [first, false]), false);
  assert.equal((await profile(f, e.id)).accountStatus, "Email failed");
  const second = await prepare(f, e.id, mail);
  assert.notEqual(first, second);
  assert.equal(await service("finish_employee_invite", [first, true]), false);
  assert(await service("finish_employee_invite", [second, true, uid]));
  await assert.rejects(asUser(uid, "accept_employee_invite", [second]));
  await db.query("update auth.users set email_confirmed_at=now() where id=$1", [
    uid,
  ]);
  await assert.rejects(asUser(f.worker, "accept_employee_invite", [second]));
  await db.query(
    "update auth.users set email='changed@example.test' where id=$1",
    [uid],
  );
  await assert.rejects(asUser(uid, "accept_employee_invite", [second]));
  await active(f, e.id, false);
  await active(f, e.id, true);
  assert.equal(await asUser(uid, "employee_invite_details", [second]), null);
});

test("onboarding and delivery are role scoped; acceptance preserves existing roles and unique employee links", async () => {
  const f = await workplace(db),
    other = await workplace(db),
    mail = "owner@example.test",
    e = await create(f, { mail });
  for (const uid of [f.worker, other.admin]) {
    await assert.rejects(create(f, { actor: uid }), { code: "42501" });
    await assert.rejects(
      asUser(uid, "set_employee_active", [f.org, e.id, false]),
      { code: "42501" },
    );
    await assert.rejects(
      asUser(uid, "prepare_employee_invite", [f.org, e.id, mail]),
      { code: "42501" },
    );
  }
  await assert.rejects(
    asUser(f.admin, "finish_employee_invite", [randomUUID(), true]),
    { code: "42501" },
  );
  await db.query(
    "update auth.users set email=$1,email_confirmed_at=now(),encrypted_password='existing' where id=$2",
    [mail, f.admin],
  );
  const ticket = await prepare(f, e.id, mail);
  await service("finish_employee_invite", [ticket, true]);
  await assert.rejects(asUser(f.admin, "accept_employee_invite", [ticket]));
  assert.equal(
    (
      await db.query(
        "select role from organisation_memberships where organisation_id=$1 and user_id=$2",
        [f.org, f.admin],
      )
    ).rows[0].role,
    "admin",
  );
  const linkedMail = "linked@example.test";
  await db.query("update auth.users set email=$1 where id=$2", [
    linkedMail,
    f.worker,
  ]);
  await assert.rejects(prepare(f, e.id, linkedMail), /already in directory/);
  await assert.rejects(prepare(other, e.id, mail), /unavailable/);
});

test("expired invitations, revoked sponsors, passwordless invites and duplicate account links cannot complete", async () => {
  const f = await workplace(db),
    mail = "staff@example.test",
    uid = await authUser(mail);
  const e = await create(f, { mail });
  const ticket = await prepare(f, e.id, mail);
  await service("finish_employee_invite", [ticket, true]);
  const accept = () => asUser(uid, "accept_employee_invite", [ticket]);
  await db.query("update auth.users set encrypted_password=null where id=$1", [
    uid,
  ]);
  assert(
    (await asUser(uid, "employee_invite_details", [ticket])).needsPassword,
  );
  await assert.rejects(accept(), { code: "42501" });
  await db.query(
    "update auth.users set encrypted_password='employee-chosen' where id=$1",
    [uid],
  );
  await db.query(
    "update timesheet_private.employee_invites set expires_at=now()-interval '1 second' where ticket=$1",
    [ticket],
  );
  await assert.rejects(accept(), { code: "42501" });
  await db.query(
    "update timesheet_private.employee_invites set expires_at=now()+interval '1 day' where ticket=$1",
    [ticket],
  );
  await db.query(
    "update organisation_memberships set active=false where user_id=$1",
    [f.admin],
  );
  await assert.rejects(accept(), { code: "42501" });
  await db.query(
    "update organisation_memberships set active=true where user_id=$1",
    [f.admin],
  );
  await db.query(
    "insert into organisation_memberships(organisation_id,user_id,role) values($1,$2,'employee')",
    [f.org, uid],
  );
  await db.query(
    "insert into employees(organisation_id,user_id,display_name) values($1,$2,'Another profile')",
    [f.org, uid],
  );
  await assert.rejects(accept(), { code: "23505" });
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from employees where id=$1 and user_id is not null",
        [e.id],
      )
    ).rows[0].n,
    0,
  );
});
