# Shiftbook

A weekly timesheet workspace and shared attendance kiosk for Australian hospitality teams. The app uses Next.js App Router, TypeScript, Tailwind CSS v4, locally owned shadcn/ui primitives and Supabase Auth/Postgres.

## Run locally

Use Node.js 22.13 or newer and npm. From the repository root:

```sh
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). Keep the existing `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `.env.local`. For attendance and PIN management, configure the three server-only secrets described below. To check Git protection, run `git check-ignore -v .env.local` and `git ls-files -- .env.local`. The first reports the ignore rule and the second should print nothing.

| Route | What works |
| --- | --- |
| `/` | Email/password sign-in with Supabase Auth. The illustrated timesheet is labelled sample data. |
| `/workspace` | Requires sign-in. Opens a sole membership directly, offers a choice for multiple memberships, or shows access instructions for an unassigned account. |
| `/workspace/[org]/employee` | Real, read-only weekly sessions for the signed-in employee, with clock times, notes, review state and a weekly total. |
| `/workspace/[org]/admin` | Workplace sessions, weekly navigation, employee filtering, a staff directory with PIN management, and kiosk status and revocation. |
| `/preview/admin`, `/preview/employee` | Public, clearly labelled fictional data for Wattle Lane Café. Try the week of 16 November 2026, filter by Ruby for a split shift, or look at Sam’s Friday overnight shift. These routes work before database setup. |
| `/kiosk` | An administrator activates the browser using their email and password. Returning kiosks open directly at PIN entry. |

The weekly window runs from local Monday midnight up to the following Monday. Each session shows its full elapsed duration. Weekly totals count only the portion of completed sessions inside that week, including over midnight and daylight-saving transitions. Open sessions appear as open and accrue no displayed total until closed.

## Upgrade your working Phase 2 project

In the target Supabase project's **SQL Editor**, run this read-only query as the database owner. The markers also work when earlier migrations were applied manually in SQL Editor.

```sql
select to_regclass('public.work_sessions') is not null as foundation,
       to_regclass('timesheet_private.kiosk_credentials') is not null as phase_2,
       to_regprocedure('public.clock_with_pin(text,uuid,text,uuid)') is not null as phase_2_1,
       to_regprocedure('public.register_workplace_kiosk(uuid,text,text,text)') is not null as direct_activation;
```

Apply each missing migration in filename order, opening the **complete file** in a new SQL Editor query and selecting **Run** once. If a later marker is present while an earlier one is missing, inspect the migration history and schema before applying changes.

1. [Foundation](supabase/migrations/20261119000100_timesheet_foundation.sql)
2. [Workplace kiosk](supabase/migrations/20261119000200_workplace_kiosk.sql)
3. [Phase 2.1 profiles and attendance](supabase/migrations/20261120000100_profiles_pairing_attendance.sql)
4. [Direct kiosk activation and exit](supabase/migrations/20261120000200_direct_kiosk.sql)

For an existing Phase 2 project, run files 3 and 4 if both markers are absent. If only direct activation is missing, run file 4 alone. If all four markers are present, skip the SQL step. File 3 is unchanged. File 4 adds admin-authorised activation and exit functions and withdraws access to the pairing functions. It preserves kiosk registrations, attendance records and PIN data. Keep `timesheet_private` outside the exposed Data API schemas.

Set the following in the ignored `.env.local` and the deployment environment. Direct activation adds no environment variables.

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Existing project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Existing project publishable key |
| `SUPABASE_SECRET_KEY` | Existing server-only secret from the project's API Keys settings |
| `SHIFTBOOK_PIN_PEPPER` | Existing server-only 64-character hex secret. Generate with `openssl rand -hex 32` only on a fresh installation. |
| `SHIFTBOOK_PIN_ENCRYPTION_KEY` | Existing independent server-only 64-character hex key. If setting up PIN encryption for the first time, generate once with `openssl rand -hex 32` and back it up privately. |

Use the same secrets on every instance for this database. After the SQL and environment are ready, restart `npm run dev` or deploy the updated app, then refresh open kiosk pages.

### Employee profiles and PINs

In **Employees**, click a name. The profile shows the linked login email when available, employment status, and whether the employee has an assigned PIN. **Edit name** updates the employee directory and timesheet label. It does not change the Auth account.

A pre-upgrade PIN continues working on the kiosk. **Reset required** means its one-way verifier has no encrypted copy. Choose **Change PIN**, enter a six-digit value or generate one, and save. **Reveal PIN** makes a fresh server request for that employee and hides the result after 30 seconds, on leaving the tab, or when you select **Hide PIN**. Archived employees keep their history and cannot clock.

The verifier still uses the organisation-specific, peppered scrypt derivation. The retrievable copy uses AES-256-GCM with a random 96-bit nonce and authenticated organisation/employee identifiers. PIN changes and retrievals write the actor, target, event and time to the private audit log. SQL Editor owners can inspect it with:

```sql
select happened_at, organisation_id, employee_id, actor_id, event
from timesheet_private.pin_audit
order by happened_at desc, id desc;
```

### Activate a tablet and test a shift

1. On the workplace device, open `/kiosk`, enter the administrator email and password, and select **Activate Kiosk**. The name is prefilled. An administrator of multiple workplaces also selects the workplace. The PIN screen appears, and any existing staff login on that browser ends. Admin sessions on other devices stay signed in.
2. Enter a six-digit employee PIN and select **Clock In / Out**. Check the first name, direction and recorded time. The screen returns to PIN entry after about three seconds. Repeat at shift end. If the response is interrupted, **Check recorded result** reads the original submission's receipt.
3. Reopen `/kiosk` in the same profile to resume PIN entry. To return this browser to normal sign-in, select **Exit Kiosk**, enter the workplace administrator's credentials and select **Deactivate kiosk**.
4. On the administrator dashboard, **Kiosks** shows registrations, status and last contact. **Revoke access → Confirm revocation** immediately blocks further clock actions. Refresh a revoked tablet to see the activation form. If a tablet loses its browser data, revoke its old registration before activating the new browser profile.

**Recover a locked browser after updating.** Open `/` and sign in normally if the old kiosk cookie is stale, expired or revoked. For an active registration, open `/kiosk?exit=1` and deactivate it with the workplace administrator's password. If the browser held a staff session alongside an active kiosk cookie, `/kiosk` also offers activation to resume attendance safely.

### Security and operating limits

- Use HTTPS on shared devices. Local Chrome supports development at `http://localhost`. The browser holds its credential in a persistent Secure, HttpOnly, host-only, SameSite=Strict cookie. Activation and exit use a fresh Supabase password sign-in scoped to the server request.
- An active screen checks in about once a minute. Credentials rotate automatically within 30 days of their 90-day expiry on the same registration. A bounded overlap recovers a lost renewal response. Still-valid Phase 2 cookies upgrade on check-in. A browser offline past expiry requires administrator activation again.
- Five incorrect PINs per kiosk in ten minutes cause a ten-minute lock.
- A database transaction locks the device and employee, checks the PIN and active status, consumes the challenge, records the server time and saves a device-bound receipt. Overlapping requests and a three-second guard prevent near-simultaneous opposite actions. Receipt lookup is read-only for 24 hours. No staff directory is returned to the kiosk.
- Administrators who can reveal PINs are trusted with plaintext for their organisation. Protect administrator accounts and both server keys. The encryption key plus a database copy enables decryption. Losing or replacing that key requires resetting retrievable PINs unless you perform a managed re-encryption. Disable logging of cookies and request/response bodies in hosting, analytics and error reporting. The app cannot prevent a privileged user from photographing a revealed PIN.
- Attendance requires the registered browser credential. Physical presence still depends on device custody. Restrict remote control and extensions and revoke lost or copied profiles.

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

All six public tables have RLS enabled and authenticated users have SELECT-only table grants. The private `employee_pins` and `kiosk_credentials` tables have RLS and no client table grants. Administrator mutations use the caller's Supabase session and check active admin membership again inside each function. Only the server's service role can execute the kiosk attendance, receipt and heartbeat RPCs. Those functions require the device digest and derive the organisation from its registration. SQL Editor runs with administrative privileges.

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

The test suite applies the migrations to disposable PostgreSQL and checks the upgrade from populated Phase 2 data, PIN encryption and audit, tenant isolation, direct activation, reauthentication, renewal, lockout, receipts and weekly totals. Run `npm run test:browser` for the separate admin, employee and kiosk browser workflow, including a lost response. It launches an isolated local app with test Auth/Data API fixtures and a fresh database. Set `CHROME_PATH` to an installed Chrome/Chromium executable (macOS Google Chrome is detected automatically). The test uses a temporary copy of the app and its installed dependencies.

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

For Vercel, use the Next.js preset and Node 22 or newer. Configure all five environment variables and apply the appropriate migrations to the target Supabase project.

## Next phase

Administrator timesheet corrections remain a future phase. Each correction should write the edit and its audit row in one transaction. Reporting, payroll, subscriptions and other HR features remain deferred.
