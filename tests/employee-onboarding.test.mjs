import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  workplace,
  roleQuery,
  testDatabase,
  applyUpgrade,
} from "./kiosk-db.mjs";
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

const stage = (f, e, operation, address, actor = f.admin) =>
  service("prepare_dashboard_login", [f.org, e.id, actor, operation, address]);
async function provision(op, uid = op.userId) {
  await db.transaction(async (tx) => {
    await tx.query(
      "insert into auth.users(id,email,encrypted_password) values($1,$2,'supabase-hash')",
      [uid, op.address],
    );
    await tx.query(
      "update auth.users set raw_app_meta_data=$1,email_confirmed_at=now() where id=$2",
      [{ shiftbook_dashboard_change: op.nonce }, uid],
    );
  });
}
async function reset(uid, op) {
  await db.transaction(async (tx) => {
    await tx.query(
      "update auth.users set encrypted_password='replacement-hash' where id=$1",
      [uid],
    );
    await tx.query("update auth.users set raw_app_meta_data=$1 where id=$2", [
      { shiftbook_dashboard_change: op.nonce },
      uid,
    ]);
  });
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
  const operation = await stage(f, e, "enable", "jordan@example.test");
  await provision(operation);
  const uid = operation.userId;
  assert.equal((await profile(f, e.id)).accountStatus, "Linked");
  await db.query(
    "insert into work_sessions(organisation_id,employee_id,started_at) values($1,$2,now())",
    [f.org, f.employee],
  );
  const shifts = () =>
    roleQuery(
      db,
      "authenticated",
      uid,
      "select employee_id from work_sessions",
    );
  assert.deepEqual(await shifts(), [{ employee_id: e.id }]);
  const pins = () =>
    db.query(
      "select verifier,sealed_pin,revision from timesheet_private.employee_pins where employee_id=$1",
      [e.id],
    );
  const before = (await pins()).rows;
  await reset(uid, await stage(f, e, "reset", null));
  assert.deepEqual((await pins()).rows, before);
  await asUser(f.admin, "set_employee_pin", [
    f.org,
    e.id,
    "b".repeat(64),
    sealPin(f.org, e.id, "222222", key),
  ]);
  assert.equal(
    (
      await db.query("select encrypted_password from auth.users where id=$1", [
        uid,
      ])
    ).rows[0].encrypted_password,
    "replacement-hash",
  );
  await asUser(f.admin, "set_employee_active", [f.org, e.id, false]);
  assert.deepEqual(await shifts(), []);
  await asUser(f.admin, "set_employee_active", [f.org, e.id, true]);
  assert.deepEqual(await shifts(), [{ employee_id: e.id }]);
});

test("Auth writes roll back for duplicate, stale, wrong-target and unauthorised operations", async () => {
  const f = await workplace(db),
    other = await workplace(db),
    e = await create(f);
  await db.query(
    "update auth.users set email='owner@example.test' where id=$1",
    [other.admin],
  );
  await assert.rejects(
    stage(f, e, "enable", "owner@example.test"),
    /unavailable/,
  );
  await assert.rejects(
    stage(f, e, "enable", "fresh@example.test", other.admin),
    { code: "42501" },
  );
  await assert.rejects(stage(f, e, "enable", "fresh@example.test", f.worker), {
    code: "42501",
  });
  await assert.rejects(
    asUser(f.admin, "prepare_dashboard_login", [
      f.org,
      e.id,
      f.admin,
      "enable",
      "fresh@example.test",
    ]),
    { code: "42501" },
  );
  const stale = await stage(f, e, "enable", "fresh@example.test");
  const current = await stage(f, e, "enable", "fresh@example.test");
  await assert.rejects(provision(stale));
  await assert.rejects(provision(current, randomUUID()));
  await provision(current);
  await assert.rejects(stage(f, e, "enable", "other@example.test"));
  const pending = await stage(f, e, "reset", null);
  await db.query(
    "insert into organisation_memberships values($1,$2,'admin',true)",
    [other.org, current.userId],
  );
  await assert.rejects(reset(current.userId, pending), { code: "42501" });
  await assert.rejects(stage(f, e, "reset", null));
  assert.equal(
    (
      await db.query("select encrypted_password from auth.users where id=$1", [
        current.userId,
      ])
    ).rows[0].encrypted_password,
    "supabase-hash",
  );
  assert.equal((await profile(f, e.id)).canManageLogin, false);
});

test("all Shiftbook tables enforce RLS and operational records have no client grants or policies", async () => {
  assert.deepEqual(
    (
      await db.query(
        "select relname from pg_class where relnamespace in ('public'::regnamespace,'timesheet_private'::regnamespace) and relkind='r' and not relrowsecurity",
      )
    ).rows,
    [],
  );
  for (const role of ["anon", "authenticated", "service_role"]) {
    const table = "timesheet_private.dashboard_login_changes";
    assert.equal(
      (
        await db.query(
          "select has_table_privilege($1,$2,'select,insert,update,delete') as allowed",
          [role, table],
        )
      ).rows[0].allowed,
      false,
    );
    await assert.rejects(roleQuery(db, role, null, "select * from " + table), {
      code: "42501",
    });
    for (const fn of [
      "prepare_employee_invite(uuid,uuid,text)",
      "finish_employee_invite(uuid,boolean,uuid)",
      "employee_invite_details(uuid)",
      "accept_employee_invite(uuid)",
    ])
      assert.equal(
        (
          await db.query(
            "select has_function_privilege($1,$2,'execute') as allowed",
            [role, "public." + fn],
          )
        ).rows[0].allowed,
        false,
      );
  }
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from pg_policies where schemaname='timesheet_private' and tablename='dashboard_login_changes'",
      )
    ).rows[0].n,
    0,
  );
});

test("upgrade preserves existing passwords, email tokens, invitations, attendance and effective memberships", async () => {
  const prior = await testDatabase({ legacy: true });
  try {
    const f = await workplace(prior),
      ticket = randomUUID();
    await applyUpgrade(prior, {
      beforePinLogin: async () => {
        await prior.query(
          "update auth.users set email='legacy@example.test',email_confirmed_at=now(),encrypted_password='existing',recovery_token='pending' where id=$1",
          [f.worker],
        );
        await prior.query(
          "insert into auth.one_time_tokens values($1,'recovery_token')",
          [f.worker],
        );
        await prior.query(
          "insert into timesheet_private.employee_invites(employee_id,organisation_id,ticket,recipient,invited_by,expires_at,delivery,recipient_user) values($1,$2,$3,'legacy@example.test',$4,now()+interval '1 day','sent',$5)",
          [f.employee, f.org, ticket, f.admin, f.worker],
        );
        await prior.query(
          "insert into work_sessions(organisation_id,employee_id,started_at) values($1,$2,now())",
          [f.org, f.employee],
        );
      },
    });
    assert.deepEqual(
      (
        await prior.query(
          "select encrypted_password,recovery_token from auth.users where id=$1",
          [f.worker],
        )
      ).rows,
      [{ encrypted_password: "existing", recovery_token: "pending" }],
    );
    assert.equal(
      (
        await prior.query(
          "select * from auth.one_time_tokens where user_id=$1",
          [f.worker],
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await prior.query(
          "select ticket from timesheet_private.employee_invites",
        )
      ).rows[0].ticket,
      ticket,
    );
    assert.deepEqual(
      await roleQuery(
        prior,
        "authenticated",
        f.worker,
        "select employee_id from work_sessions",
      ),
      [{ employee_id: f.employee }],
    );
    await assert.rejects(
      roleQuery(
        prior,
        "authenticated",
        f.worker,
        "select accept_employee_invite($1)",
        [ticket],
      ),
      { code: "42501" },
    );
  } finally {
    await prior.close();
  }
});

test("only an explicit reset can replace an existing employee password; revoked sponsor rolls back", async () => {
  const f = await workplace(db),
    e = { id: f.employee };
  await db.query(
    "update auth.users set email='existing@example.test', email_confirmed_at=now(),encrypted_password='legacy' where id=$1",
    [f.worker],
  );
  assert.equal((await profile(f, e.id)).canManageLogin, true);
  const op = await stage(f, e, "reset", null);
  assert.equal(op.userId, f.worker);
  assert.equal(
    (
      await db.query("select encrypted_password from auth.users where id=$1", [
        f.worker,
      ])
    ).rows[0].encrypted_password,
    "legacy",
  );
  await db.query(
    "update organisation_memberships set active=false where organisation_id=$1 and user_id=$2",
    [f.org, f.admin],
  );
  await assert.rejects(reset(f.worker, op), { code: "42501" });
  assert.equal(
    (
      await db.query("select encrypted_password from auth.users where id=$1", [
        f.worker,
      ])
    ).rows[0].encrypted_password,
    "legacy",
  );
  await db.query(
    "update organisation_memberships set active=true where organisation_id=$1 and user_id=$2",
    [f.org, f.admin],
  );
  await reset(f.worker, await stage(f, e, "reset", null));
  assert.equal(
    (
      await db.query("select encrypted_password from auth.users where id=$1", [
        f.worker,
      ])
    ).rows[0].encrypted_password,
    "replacement-hash",
  );
});
