import { createServer } from "node:http";
import { randomBytes, createHmac } from "node:crypto";
import { testDatabase, workplace, roleQuery } from "./kiosk-db.mjs";

// Local Auth/HTTP adapter for browser tests. All profile, registration, attendance
// and RLS decisions go through the real migrations in an isolated database.
export async function browserFixture() {
  const db = await testDatabase(),
    f = await workplace(db);
  await db.query("insert into organisations(name) values ('Harbour Pub')");
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
  await db.query("update auth.users set email=$1 where id=$2", [
    email,
    f.worker,
  ]);
  function issue(address) {
    const id = address === adminEmail ? f.admin : f.worker;
    const user = {
      id,
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
        session_id: random(),
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
      res.writeHead(status, { "content-type": "application/json" });
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
      if (path === "/auth/v1/token")
        return body.password === password &&
          [adminEmail, email].includes(body.email)
          ? send(200, issue(body.email))
          : send(400, {});
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
          ),
        );
      }
      if (!["employees", "kiosk_devices", "work_sessions"].includes(name))
        return send(404, {});
      const rows = await roleQuery(db, role, user?.id, "select * from " + name);
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
