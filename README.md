# Shiftbook

A weekly timesheet workspace and shared attendance kiosk for Australian hospitality teams. The app uses Next.js App Router, TypeScript, Tailwind CSS v4, locally owned shadcn/ui primitives and Supabase Auth/Postgres.

## Run locally

Use Node.js 22.13 or newer and npm. From the repository root:

```sh
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). Keep the existing `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `.env.local`. For attendance, add the two server variables in the upgrade instructions below. To check Git protection, run `git check-ignore -v .env.local` and `git ls-files -- .env.local`. The first reports the ignore rule and the second should print nothing.

| Route | What works |
| --- | --- |
| `/` | Email/password sign-in with Supabase Auth. The illustrated timesheet is labelled sample data. |
| `/workspace` | Requires sign-in. Opens a sole membership directly, offers a choice for multiple memberships, or shows access instructions for an unassigned account. |
| `/workspace/[org]/employee` | Real, read-only weekly sessions for the signed-in employee, with clock times, notes, review state and a weekly total. |
| `/workspace/[org]/admin` | Workplace sessions, weekly navigation, employee filtering, a staff directory with PIN management, and kiosk activation/revocation. |
| `/preview/admin`, `/preview/employee` | Public, clearly labelled fictional data for Wattle Lane Café. Try the week of 16 November 2026, filter by Ruby for a split shift, or look at Sam’s Friday overnight shift. These routes work before database setup. |
| `/kiosk` | Authorised browsers show the device name, local time, PIN entry and explicit clock-in/out confirmation. Other browsers show the locked screen. |

The weekly window runs from local Monday midnight up to the following Monday. Each session shows its full elapsed duration. Weekly totals count only the portion of completed sessions inside that week, including over midnight and daylight-saving transitions. Open sessions appear as open and accrue no displayed total until closed.

## Upgrade an existing Phase 1 project

1. In the existing project's **SQL Editor → New query**, paste the complete [Phase 2 migration](supabase/migrations/20261119000200_workplace_kiosk.sql), then click **Run** once. The transaction adds a device expiry column, two private tables, an index and narrowly scoped functions. Existing employees, memberships and sessions are preserved. The Phase 1 migration is already installed in your project.
2. Under **Settings → API Keys → Secret keys**, create a named secret key for the Shiftbook server (for example, `shiftbook-kiosk`). Copy the `sb_secret_…` value into your ignored local environment file as `SUPABASE_SECRET_KEY`. The key has elevated project access. Keep it in the server environment. [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
3. Generate a separate 32-byte random secret, e.g. run `openssl rand -hex 32` privately. Add the resulting 64 hexadecimal characters as `SHIFTBOOK_PIN_PEPPER`. Keep it consistent across all servers pointing at this database. Both new names are server-only. Keep `timesheet_private` outside the Supabase Data API's exposed schemas.
4. Restart the local Next.js server. For Vercel, set the same variables for the target environment in **Project Settings → Environment Variables** and redeploy. Use the production HTTPS origin on a shared device. Current Chrome on `http://localhost` supports local development. A tablet visiting an ordinary HTTP LAN address needs HTTPS for the Secure cookie.

### First attendance check

1. Sign in with your existing administrator account. In **Employees**, choose **Manage PIN** for an active employee. Select **Generate randomly** or **Choose six digits**, then **Save new PIN**. Share the displayed PIN privately. **Hide PIN** clears it immediately and the screen clears it automatically after 45 seconds. A reset invalidates the previous PIN and its pending confirmation.
2. On the computer or tablet that will stay at the workplace, open **Kiosks**, enter a device name, then choose **Activate and sign out**. This opens `/kiosk` with a separate device cookie. A different browser profile should still see a locked screen.
3. Enter the employee's PIN, check their first name and status, and select **Clock In**. Wait for the recorded time and automatic return to PIN entry. In another browser profile, open or refresh the employee and administrator timesheets. The open session displays **Currently working** and contributes zero completed hours.
4. Enter the PIN again and choose **Clock Out**. Refresh both dashboards on the week containing the session. Completed time now contributes to the weekly total. Very short completed durations display as `<1m`. A second clock-in creates a separate session.
5. To remove access immediately, open **Kiosks → Revoke access → Confirm revocation** as an administrator. This also blocks already-issued attendance confirmations. Registrations expire after 30 days. Reauthorise by signing in on the device and activating it again; same-browser renewal retires the old credential for that organisation. If cookies have been cleared or a device has been lost, revoke its previous registration explicitly.

### Kiosk security and operating limits

PINs are six digits, including leading zeros. The server derives a verifier using HMAC with a private pepper followed by scrypt with an organisation-specific salt. PostgreSQL enforces workplace-local uniqueness. Administrators can issue a replacement but cannot retrieve an existing PIN. Only active employee records can clock, including staff without a personal dashboard login. Archive the employee to withdraw attendance access.

Each activation generates a random 256-bit bearer credential stored in a Secure, HttpOnly, host-only, SameSite=Strict cookie. Postgres stores its digest. The server requires a same-origin mutation and passes only digests to the kiosk RPCs. PIN attempts use rotating challenges. Five incorrect PINs on one device in ten minutes lock it for ten minutes. Successful entries do not replenish the budget during that window.

After identification, a separate random ticket gives that device 45 seconds to confirm the observed clock action once. At commit, the database locks the device and employee, checks revocation, expiry, PIN revision and session state, and timestamps the change. If the network drops after tapping a button, enter the PIN again and check the status before taking another action.

Activation identifies a browser profile. Physical presence and employee identity still depend on control of the device and PIN. Keep the device at the workplace, restrict remote access and browser extensions, and revoke lost devices. A copied profile or compromised host can expose a bearer credential. Configure hosting, proxy, analytics and error reporting to exclude request/response bodies, cookies and credentials on these routes. Protect and back up the pepper in a secret manager. Changing it requires reassigning employee PINs. The dedicated Supabase secret has project-wide privileges, so rotate it if exposed.

## Initial Phase 1 setup for an empty project

1. Open **SQL Editor → New query** in your existing project. Review and run [the foundation migration](supabase/migrations/20261119000100_timesheet_foundation.sql) **once** as the project database owner. It creates six tables, indexes, policies and a private helper in a single transaction. It installs the supported `btree_gist` extension if needed. An object-name collision aborts the transaction. Inspect any conflict before retrying. Running the app never applies the migration.
2. In **Project Settings → Data API**, check that the Data API is enabled and that `public` is an exposed schema. Keep `timesheet_private` outside the exposed schemas. The migration supplies the required grants and row policies.
3. Under **Authentication → Sign In / Providers**, enable the **Email** provider. For this staff-only app, disable **Allow new users to sign up** if the project is dedicated to this app. This setting is project-wide. Sign-in uses email and password and requires no OAuth callback. [Supabase Auth configuration](https://supabase.com/docs/guides/auth/general-configuration)
4. In **Authentication → Users → Add user → Create new user**, create one administrator and one employee with distinct emails and passwords. Use **Auto Confirm User** for these manually provisioned test accounts, or confirm their emails before testing. Copy both user UUIDs. Add roles in the database in the next step.
5. In **SQL Editor → New query**, replace the two UUID placeholders, business name, timezone and employee name below. Run once to create your first workplace. The single transaction rolls back if either UID is invalid.

```sql
do $$
declare
  business uuid;
  admin_uid uuid := 'REPLACE_WITH_ADMIN_USER_UUID';
  employee_uid uuid := 'REPLACE_WITH_EMPLOYEE_USER_UUID';
begin
  insert into public.organisations (name, timezone)
    values ('Your café', 'Australia/Brisbane') returning id into business;

  insert into public.organisation_memberships (organisation_id, user_id, role)
    values (business, admin_uid, 'admin'), (business, employee_uid, 'employee');

  insert into public.employees (organisation_id, user_id, display_name)
    values (business, employee_uid, 'Your employee');
end $$;
```

Use your business’s IANA timezone, for example `Australia/Sydney`, `Australia/Adelaide` or `Australia/Perth`. Memberships grant access to individual businesses. An employee membership also needs an active employee record with the same organisation and Auth user ID. To link an additional workplace to an existing account, insert another membership for that organisation.

## Database and access model

| Table | Authenticated read access |
| --- | --- |
| `organisations` | Workplaces where the user has an effective, active membership. |
| `organisation_memberships` | Own effective membership for employees. Administrators can read all membership rows in their workplace. |
| `employees` | Own active staff profile for employees. Administrators can read the entire workplace directory, including archived staff and staff without personal logins. |
| `kiosk_devices` | Workplace administrators only. Stores device metadata, activation, expiry and revocation timestamps. |
| `work_sessions` | Own sessions for employees, all workplace sessions for administrators. Includes optional notes, clock-device references and review attribution. |
| `timesheet_edit_history` | Workplace administrators only. Holds before/after times, editor, timestamp and required reason for the future editing operation. |

All six public tables have RLS enabled and authenticated users have SELECT-only table grants. The private `employee_pins` and `kiosk_credentials` tables have RLS and no client table grants. Administrator mutations use the caller's Supabase session and check active admin membership again inside each function. Only the server's service role can execute the three attendance RPCs. Those functions require the device digest and derive the organisation from its registration. SQL Editor runs with administrative privileges.

The request proxy refreshes auth cookies and disables shared caching on workspace requests. The server verifies identity using `getClaims()` and looks up current memberships using the caller’s Supabase client. Protected data requests verify both the organisation and role. PostgreSQL enforces row access again, independently of the URL or interface. Roles come from database memberships. [Supabase SSR guide](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs) · [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

Composite foreign keys keep employees, devices, reviews and edit history within their organisation. A PostgreSQL exclusion constraint rejects overlapping sessions, including two open sessions for one employee, even during concurrent inserts. Back-to-back sessions are valid. Times use `timestamptz`. Archive staff by setting `employees.active` to false. This removes employee workspace access while preserving historical records for administrators. Set `organisation_memberships.active` to false to revoke a membership of either role.

## Verify the installation

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

Run the production server after stopping any dev server on the same port.

The test suite applies both migrations to disposable in-memory PostgreSQL, supplies test Auth identities, and exercises the actual PIN derivation, SQL privileges, lockout, state transitions, revocation, renewal and weekly totals. It does not use hosted credentials.

1. Signed out, visit `/workspace`. Expect the sign-in page. Try both public previews, change weeks, and open the kiosk from an unregistered browser.
2. Sign in as the administrator. Verify the new workplace and employee directory. A newly provisioned workplace has an empty timesheet. Sign out and sign in as the employee in a separate browser profile. The same organisation’s admin URL should return a 404 for that employee.
3. To check real records, in a test workplace use **Table Editor → work_sessions → Insert row**. Set `organisation_id`, `employee_id`, `started_at` and `ended_at`. Include the UTC offset, for example `2026-11-20T22:00:00+10:00` through `2026-11-21T02:00:00+10:00` in Brisbane. Leave review fields empty for Pending. Navigate to that week. The session should show four hours in both authorised views.
4. Add another test employee and session. Only the administrator should see both employees’ sessions. Archive the first test employee. Their dashboard should lose access and their historical shift should remain visible to the administrator.
5. For a tenant check, provision a second test workplace and a different administrator. Sign in as the second administrator and visit the first workplace’s URL. Expect a 404. Each administrator should see only their own workplace in the selector.

## Source layout

- `src/app` — entry page, auth and kiosk server actions, shared kiosk, sample routes and protected workspaces.
- `src/lib/kiosk` — server-only credential handling, PIN derivation and cookie checks. `tests/` covers the attendance database contract.
- `src/components` — shared dashboard shell, timesheet views and login form. `ui/` and `components.json` provide the shadcn/ui component setup.
- `src/proxy.ts` and `src/lib/supabase` — per-request server client, browser client factory, public configuration and cookie refresh.
- `src/lib/workspace.ts` and `records.ts` — membership checks and scoped database reads.
- `src/lib/timesheets.ts` and `sample.ts` — timezone-aware week boundaries, elapsed-time calculations and fictional preview records.
- `supabase/migrations` — ordered schema changes. The application uses the existing Supabase project.

For Vercel, use the Next.js preset and Node 22 or newer. Configure all four environment variables and apply the appropriate migrations to the target Supabase project.

## Next phase

Administrator timesheet corrections remain a future phase. Each correction should write the edit and its audit row in one transaction. Reporting, payroll, subscriptions and other HR features remain deferred.
