# Shiftbook

Phase 1 of a weekly timesheet workspace for Australian hospitality teams. The app uses Next.js App Router, TypeScript, Tailwind CSS v4, locally owned shadcn/ui primitives and Supabase Auth/Postgres. It runs as a standard Next.js application on Vercel.

## Run locally

Use Node.js 22 or newer and npm. From the repository root:

```sh
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). The existing `.env.local` supplies `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. No service-role key is required. To check the file stays out of Git, run `git check-ignore -v .env.local` and `git ls-files -- .env.local`. The first reports the ignore rule and the second should print nothing.

| Route | What works |
| --- | --- |
| `/` | Email/password sign-in with Supabase Auth. The illustrated timesheet is labelled sample data. |
| `/workspace` | Requires sign-in. Opens a sole membership directly, offers a choice for multiple memberships, or shows access instructions for an unassigned account. |
| `/workspace/[org]/employee` | Real, read-only weekly sessions for the signed-in employee, with clock times, notes, review state and a weekly total. |
| `/workspace/[org]/admin` | Real, read-only workplace sessions, weekly navigation, employee filtering and a staff directory including archived staff. |
| `/preview/admin`, `/preview/employee` | Public, clearly labelled fictional data for Wattle Lane Café. Try the week of 16 November 2026, filter by Ruby for a split shift, or look at Sam’s Friday overnight shift. These routes work before database setup. |
| `/kiosk` | Locked tablet preview. It accepts no PIN and has no clocking endpoint. |

The weekly window runs from local Monday midnight up to the following Monday. Each session shows its full elapsed duration. Weekly totals count only the portion of completed sessions inside that week, including over midnight and daylight-saving transitions. Open sessions appear as open and accrue no displayed total until closed.

## Configure the existing Supabase project

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
| `kiosk_devices` | Workplace administrators only. Stores device metadata and lifecycle timestamps. No device credentials or PINs exist in Phase 1. |
| `work_sessions` | Own sessions for employees, all workplace sessions for administrators. Includes optional notes, clock-device references and review attribution. |
| `timesheet_edit_history` | Workplace administrators only. Holds before/after times, editor, timestamp and required reason for the future editing operation. |

All six tables have RLS enabled. Anonymous callers have no table grants. Authenticated clients have SELECT grants only. The app exposes no timesheet, role, kiosk or staff write API. Direct SQL in the dashboard runs with administrative privileges, so use test records for manual checks.

The request proxy refreshes auth cookies and disables shared caching on workspace requests. The server verifies identity using `getClaims()` and looks up current memberships using the caller’s Supabase client. Protected data requests verify both the organisation and role. PostgreSQL enforces row access again, independently of the URL or interface. Roles come from database memberships. [Supabase SSR guide](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs) · [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

Composite foreign keys keep employees, devices, reviews and edit history within their organisation. A PostgreSQL exclusion constraint rejects overlapping sessions, including two open sessions for one employee, even during concurrent inserts. Back-to-back sessions are valid. Times use `timestamptz`. Archive staff by setting `employees.active` to false. This removes employee workspace access while preserving historical records for administrators. Set `organisation_memberships.active` to false to revoke a membership of either role.

## Verify the installation

```sh
npm run lint
npm run typecheck
npm run build
npm start
```

Run the production server after stopping any dev server on the same port.

1. Signed out, visit `/workspace`. Expect the sign-in page. Try both public previews, change weeks, and open the kiosk preview.
2. Sign in as the administrator. Verify the new workplace and employee directory. A newly provisioned workplace has an empty timesheet. Sign out and sign in as the employee in a separate browser profile. The same organisation’s admin URL should return a 404 for that employee.
3. To check real records, in a test workplace use **Table Editor → work_sessions → Insert row**. Set `organisation_id`, `employee_id`, `started_at` and `ended_at`. Include the UTC offset, for example `2026-11-20T22:00:00+10:00` through `2026-11-21T02:00:00+10:00` in Brisbane. Leave review fields empty for Pending. Navigate to that week. The session should show four hours in both authorised views.
4. Add another test employee and session. Only the administrator should see both employees’ sessions. Archive the first test employee. Their dashboard should lose access and their historical shift should remain visible to the administrator.
5. For a tenant check, provision a second test workplace and a different administrator. Sign in as the second administrator and visit the first workplace’s URL. Expect a 404. Each administrator should see only their own workplace in the selector.

## Source layout

- `src/app` — entry page, auth server actions, locked kiosk, sample routes and protected workspaces.
- `src/components` — shared dashboard shell, timesheet views and login form. `ui/` and `components.json` provide the shadcn/ui component setup.
- `src/proxy.ts` and `src/lib/supabase` — per-request server client, browser client factory, public configuration and cookie refresh.
- `src/lib/workspace.ts` and `records.ts` — membership checks and scoped database reads.
- `src/lib/timesheets.ts` and `sample.ts` — timezone-aware week boundaries, elapsed-time calculations and fictional preview records.
- `supabase/migrations` — ordered schema changes. The application uses the existing Supabase project.

For Vercel, import the repository using the Next.js preset, select Node 22 or newer and set the same two public Supabase environment variables for the intended environment before building. Apply the migration to that environment’s Supabase project.

## Next phase

Implement administrator-only kiosk pairing and revocation, then administrator-assigned six-digit PINs and one transactional clock-in/out operation. Verify the device and active employee on the server, keep PIN verification material private, provide organisation-scoped lookup, and rate-limit failed attempts before enabling attendance recording.

Later, add a single admin edit operation that writes the edit and its audit row in the same transaction. Phase 1 provides the audit table only. Report generation, including splitting elapsed hours at local midnight for weekday/weekend totals, remains deferred alongside payroll, subscriptions and other HR features.
