import { createServer } from "node:http";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { testDatabase, workplace, roleQuery } from "./kiosk-db.mjs";

// Local Auth/HTTP adapter for browser tests. All profile, registration, attendance
// and RLS decisions go through the real migrations in an isolated database.
export async function browserFixture() {
  const db = await testDatabase(),
    f = await workplace(db);
  const harbour = (
    await db.query(
      "insert into organisations(name) values ('Harbour Pub') returning id",
    )
  ).rows[0].id;
  const formerEmployee = randomUUID();
  const harbourEmployee = randomUUID();
  await db.query(
    "insert into employees(id,organisation_id,display_name,active) values($1,$2,'Sam Wilson',false),($3,$4,'Harbour employee',true)",
    [formerEmployee, f.org, harbourEmployee, harbour],
  );
  await db.query(
    `insert into work_sessions(organisation_id,employee_id,started_at,ended_at)
     values ($1,$2,'2025-11-28 22:00+10','2025-11-29 02:00+10'),
            ($3,$4,'2025-11-28 10:00+10','2025-11-28 18:00+10')`,
    [f.org, formerEmployee, harbour, harbourEmployee],
  );
  const random = () => randomBytes(32).toString("hex");
  const secret = random(),
    publishable = random(),
    pepper = random(),
    password = random();
  const accounts = new Map();
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const email = "alex@example.test",
    adminEmail = "admin@example.test";
  const existingEmail = "returning@example.test";
  const ids = new Map([
    [adminEmail, f.admin],
    [email, f.worker],
    [existingEmail, randomUUID()],
  ]);
  const passwords = new Map(
    [...ids.keys()].map((address) => [address, password]),
  );
  await db.query("insert into auth.users(id) values($1)", [
    ids.get(existingEmail),
  ]);
  for (const [address, id] of ids)
    await db.query(
      "update auth.users set email=$1,email_confirmed_at=now(),encrypted_password='existing' where id=$2",
      [address, id],
    );
  let emailRequests = 0;
  async function issue(address) {
    const id = ids.get(address);
    const session = randomUUID();
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [
      session,
      id,
    ]);
    const user = {
      id,
      session_id: session,
      amr: [{ method: "password" }],
      aud: "authenticated",
      role: "authenticated",
      email: address,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    };
    const body =
      encode({ alg: "HS256", typ: "JWT" }) +
      "." +
      encode({
        ...user,
        sub: id,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
    const token =
      body +
      "." +
      createHmac("sha256", pepper).update(body).digest("base64url");
    accounts.set(token, user);
    return {
      access_token: token,
      refresh_token: random(),
      expires_in: 3600,
      token_type: "bearer",
      user,
    };
  }
  const signatures = {
    create_employee: [
      "org",
      "employee",
      "full_name",
      "address",
      "pin_verifier",
      "envelope",
    ],
    set_employee_active: ["org", "employee", "enabled"],
    prepare_dashboard_login: [
      "org",
      "employee",
      "actor",
      "operation",
      "address",
    ],
    manage_work_session: [
      "org",
      "employee",
      "session_id",
      "operation",
      "expected_revision",
      "start_time",
      "finish_time",
      "session_note",
      "change_reason",
    ],
    kiosk_restaurant: ["restaurant_slug"],
    employee_profile: ["org", "employee"],
    read_employee_pin: ["org", "employee"],
    set_employee_pin: ["org", "employee", "pin_verifier", "envelope"],
    rename_employee: ["org", "employee", "new_name"],
    register_workplace_kiosk: ["org", "label", "new_digest", "old_digest"],
    exit_workplace_kiosk: ["browser_digest"],
    rename_kiosk: ["org", "device", "label"],
    revoke_kiosk: ["org", "device"],
    kiosk_context: ["credential_digest"],
    kiosk_heartbeat: ["credential_digest", "successor"],
    clock_with_pin: [
      "credential_digest",
      "attempt_id",
      "pin_verifier",
      "submission",
    ],
    kiosk_receipt: ["credential_digest", "attempt_id", "submission"],
  };
  let dropClockResponse = false;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const send = (status, val) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "x-supabase-api-version": "2024-01-01",
      });
      res.end(JSON.stringify(val));
    };
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : {};
      const token = req.headers.authorization?.slice(7),
        user = accounts.get(token);
      const role =
        req.headers.apikey === secret
          ? "service_role"
          : user
            ? "authenticated"
            : "anon";
      if (path === "/auth/v1/token") {
        return passwords.has(body.email) &&
          passwords.get(body.email) === body.password
          ? send(200, await issue(body.email))
          : send(400, {});
      }
      if (path === "/auth/v1/invite" || path === "/auth/v1/otp") {
        emailRequests++;
        return send(400, {});
      }
      if (
        path === "/auth/v1/admin/users" ||
        path.startsWith("/auth/v1/admin/users/")
      ) {
        if (role !== "service_role") return send(403, {});
        const creating = req.method === "POST",
          uid = creating ? body.id : path.split("/").pop();
        const prior = [...ids.keys()].find(
          (address) => ids.get(address) === uid,
        );
        const address = body.email || prior;
        if (!address || (ids.has(address) && ids.get(address) !== uid))
          return send(422, {
            code: "email_exists",
            message: "Email unavailable",
          });
        await db.transaction(async (tx) => {
          if (creating)
            await tx.query(
              "insert into auth.users(id,email,encrypted_password) values($1,$2,$3)",
              [uid, address, random()],
            );
          else if (body.password)
            await tx.query(
              "update auth.users set encrypted_password=$1 where id=$2",
              [random(), uid],
            );
          else
            await tx.query("update auth.users set email=$1 where id=$2", [
              address,
              uid,
            ]);
          await tx.query(
            "update auth.users set raw_app_meta_data=$1,email_confirmed_at=now() where id=$2",
            [body.app_metadata, uid],
          );
        });
        const nextPassword = body.password ?? passwords.get(prior);
        if (prior && prior !== address) {
          passwords.delete(prior);
          ids.delete(prior);
        }
        passwords.set(address, nextPassword);
        ids.set(address, uid);
        return send(200, { id: uid, email: address, identities: [] });
      }
      if (path === "/auth/v1/user") return send(user ? 200 : 401, user);
      if (path === "/auth/v1/logout") {
        const scope =
          new URL(req.url, "http://localhost").searchParams.get("scope") ??
          "global";
        if (scope === "local") accounts.delete(token);
        else
          for (const [key, account] of accounts) {
            if (
              account.id === user?.id &&
              (scope === "global" || key !== token)
            )
              accounts.delete(key);
          }
        return send(204);
      }
      if (path.endsWith("jwks.json")) return send(200, { keys: [] });
      const name = path.split("/").pop();
      if (path.startsWith("/rest/v1/rpc/") && Object.hasOwn(signatures, name)) {
        const args = signatures[name];
        const rows = await roleQuery(
          db,
          role,
          user?.id,
          "select " +
            name +
            "(" +
            args.map((_, i) => "$" + (i + 1)).join(",") +
            ") as result",
          args.map((k) => body[k]),
          user,
        );
        if (name === "clock_with_pin" && dropClockResponse) {
          dropClockResponse = false;
          res.destroy();
          return;
        }
        return send(200, rows[0].result);
      }
      if (name === "organisation_memberships") {
        return send(
          200,
          await roleQuery(
            db,
            role,
            user?.id,
            "select m.role,jsonb_build_object('id',o.id,'name',o.name,'slug',o.slug,'timezone',o.timezone) as organisations from organisation_memberships m join organisations o on o.id=m.organisation_id where m.user_id=$1",
            [user?.id],
            user,
          ),
        );
      }
      if (
        ![
          "employees",
          "kiosk_devices",
          "work_sessions",
          "timesheet_edit_history",
        ].includes(name)
      )
        return send(404, {});
      const params = new URL(req.url, "http://localhost").searchParams;
      const sessionId = params.get("session_id")?.slice(3);
      let rows;
      if (name === "timesheet_edit_history")
        rows = await roleQuery(
          db,
          role,
          user?.id,
          "select * from timesheet_edit_history where session_id=$1 order by changed_at desc",
          [sessionId],
          user,
        );
      else if (name === "work_sessions") {
        const end = params.get("started_at")?.slice(3);
        if (params.has("ended_at")) {
          const ids =
            params.get("employee_id")?.slice(4, -1).split(",") ?? null;
          rows = await roleQuery(
            db,
            role,
            user?.id,
            "select id,employee_id,started_at,ended_at,reviewed_at,voided_at,note from work_sessions where organisation_id=$1 and started_at<$2 and ended_at>$3 and voided_at is null and ($4::uuid[] is null or employee_id=any($4)) order by started_at,id",
            [
              params.get("organisation_id")?.slice(3),
              end,
              params.get("ended_at").slice(3),
              ids,
            ],
            user,
          );
        } else {
          const start = params.get("or")?.match(/ended_at\.gt\.([^,)]+)/)?.[1];
          rows = await roleQuery(
            db,
            role,
            user?.id,
            "select * from work_sessions where started_at<$1 and (ended_at>$2 or (ended_at is null and (voided_at is null or started_at>=$2))) order by started_at desc, id",
            [end, start],
            user,
          );
        }
      } else
        rows = await roleQuery(
          db,
          role,
          user?.id,
          "select * from " + name,
          [],
          user,
        );
      res.setHeader(
        "content-range",
        rows.length ? "0-" + (rows.length - 1) + "/" + rows.length : "*/0",
      );
      send(200, rows);
    } catch {
      send(400, { message: "Local fixture request failed" });
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    email,
    adminEmail,
    password,
    org: f.org,
    harbour,
    harbourEmployee,
    existingEmail,
    emailRequests: () => emailRequests,
    dropReply: () => {
      dropClockResponse = true;
    },
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:" + server.address().port,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable,
      SUPABASE_SECRET_KEY: secret,
      SHIFTBOOK_PIN_PEPPER: pepper,
      SHIFTBOOK_PIN_ENCRYPTION_KEY: random(),
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await db.close();
    },
  };
}
