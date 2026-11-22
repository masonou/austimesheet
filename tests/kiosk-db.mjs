import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// A fresh in-memory Postgres with the Auth roles/auth.uid contract used by RLS.
export const upgradeFile = "20261120000100_profiles_pairing_attendance.sql";
export async function applyUpgrade(db, { beforePinLogin } = {}) {
  await applyProfiles(db);
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/20261120000200_direct_kiosk.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/20261121000100_restaurant_kiosk_urls.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/20261121000200_timesheet_management.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/20261121000300_employee_onboarding.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (beforePinLogin) await beforePinLogin(db);
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/20261122000100_employee_pin_login.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}
async function applyProfiles(db) {
  await db.exec(
    await readFile(
      new URL("../supabase/migrations/" + upgradeFile, import.meta.url),
      "utf8",
    ),
  );
}
export async function testDatabase({ legacy = false } = {}) {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(`
    create schema auth; create schema extensions;
    create role supabase_auth_admin; create role anon; create role authenticated; create role service_role;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,invited_at timestamptz,encrypted_password text,raw_app_meta_data jsonb,role text default 'authenticated',is_super_admin boolean,confirmation_token text,recovery_token text,confirmation_sent_at timestamptz,recovery_sent_at timestamptz);
    create table auth.one_time_tokens(user_id uuid references auth.users,token_type text);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users,created_at timestamptz default clock_timestamp());
    create table auth.identities(user_id uuid references auth.users,provider text);
    create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated;
  `);
  for (const file of [
    "20261119000100_timesheet_foundation.sql",
    "20261119000200_workplace_kiosk.sql",
  ]) {
    await db.exec(
      await readFile(
        new URL("../supabase/migrations/" + file, import.meta.url),
        "utf8",
      ),
    );
  }
  if (!legacy) await applyUpgrade(db);
  return db;
}

export async function workplace(db) {
  const [org, admin, worker, employee] = Array.from({ length: 4 }, () =>
    randomUUID(),
  );
  await db.query("insert into organisations(id,name) values($1,'Test café')", [
    org,
  ]);
  await db.query("insert into auth.users values ($1),($2)", [admin, worker]);
  await db.query(
    "insert into organisation_memberships values($1,$2,'admin',true),($1,$3,'employee',true)",
    [org, admin, worker],
  );
  await db.query(
    "insert into employees(id,organisation_id,user_id,display_name) values($1,$2,$3,'Alex Lee')",
    [employee, org, worker],
  );
  return { org, admin, worker, employee };
}

export const roleQuery = (db, role, uid, sql, args = [], claims = {}) =>
  db.transaction(async (tx) => {
    if (!["anon", "authenticated", "service_role"].includes(role))
      throw new Error("Unknown test role");
    await tx.exec("set local role " + role);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [
      uid ?? "",
    ]);
    await tx.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify(claims),
    ]);
    return (await tx.query(sql, args)).rows;
  });
