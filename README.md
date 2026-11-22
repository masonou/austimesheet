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
| Kiosk host `/[restaurant-slug]` | Restaurant-specific activation and employee PIN entry. Open the URL from Admin → Kiosks. |

The weekly window runs from local Monday midnight up to the following Monday. Each session shows its full elapsed duration. Weekly totals count only the portion of completed sessions inside that week, including over midnight and daylight-saving transitions. Open sessions appear as open and accrue no displayed total until closed.

## Phase 3C reporting

Open **Admin → Reports** to preview completed time or download CSVs. Reporting uses the existing Supabase session, workplace membership checks, RLS and work-session tables. Deploy the app with the current environment. This phase needs no SQL migration.

**This week** and **Last week** use Monday through Sunday in the workplace timezone. **Fortnight** uses any chosen start date and the following 13 days. **Custom date range** includes both dates. Select all employees, or select one or more names and choose **Apply filters**. Inactive employees with completed time appear in the breakdown. Expand a name to see recorded times, notes and review status.

Each session contributes only the portion inside the period. At each local midnight, the report assigns the elapsed time to weekday, Saturday or Sunday. Timestamps retain their recorded precision, including on daylight-saving changes. Summaries round the exact accumulated duration to two decimal hours, so adding the individually rounded CSV rows may differ slightly from a summary. A session crossing two reports counts once in each report it overlaps; its hours are split between them. Open and voided sessions contribute no time. The preview flags pending completed sessions, which are included alongside reviewed sessions.

**Export CSV** returns one row per session per local day. Recorded clock-in/out, allocation start/end (including UTC offsets), category and total hours make overnight shifts traceable. Sum the daily **Total hours** column. **Hours worked** is the same row duration. **Employee summary CSV** returns one row per reported employee with category totals, weekend and overall hours, and completed and pending counts. Both files carry workplace, dates, timezone and generation time. Empty files carry an explicitly labelled empty-report row if there are no data rows. Text fields are escaped for spreadsheets. Each download reads the latest records using the preview's dates and employee IDs, so corrections after preview appear in the download.

**Try a fortnight:** In a test workplace using Brisbane time, add an otherwise missing shift for Friday 20 November 2026 at 22:00 through Saturday 21 November at 02:00. Open Reports, select **Fortnight**, set **16 November 2026**, select that employee, and apply. The report ends on 29 November. For this shift expect **2.00 weekday**, **2.00 Saturday**, and **4.00 total**. Expand the employee, compare both CSVs, then mark the shift Reviewed on the timesheet and refresh the report. The hours stay the same and the pending count decreases.

A request covers up to 366 days, 100 explicitly selected employees (or all), a 5,000-person directory, 5,000 matching sessions and 20,000 daily allocations. Downloads are limited to 12 MiB. Oversized requests return an error so an administrator can narrow the report.

## Employee dashboard password rollout

A workplace PIN is six digits and is used for kiosk attendance. A dashboard login uses an email and an independent, server-generated 24-character password. An admin sees the generated email/password pair once after provisioning or a confirmed reset. Give it to the employee privately, then choose **Done**. Closing or refreshing the page or hiding the tab also clears the display. To replace a lost password, issue a new one from the employee profile. Supabase stores the password hash. Shiftbook does not store, log or offer later retrieval of the dashboard password.

### Which SQL to run

1. In **Supabase → SQL Editor → New query**, this read-only check identifies the prerequisite and the two versions of the unapplied draft:

   ```sql
   select to_regprocedure('public.create_employee(uuid,uuid,text,text,text,text)') is not null as onboarding_installed,
          to_regprocedure('public.prepare_login_change(uuid,uuid,uuid,text,text,text,text)') is not null as old_pin_draft_installed,
          to_regprocedure('public.prepare_dashboard_login(uuid,uuid,uuid,text,text)') is not null as password_rollout_installed;
   ```

2. For **true, false, false**, review and run **only** the complete [20261122000100_employee_pin_login.sql](supabase/migrations/20261122000100_employee_pin_login.sql) once as the project database owner. The existing filename retains its migration version. A missing prerequisite requires applying only the missing earlier migrations in order. If the old PIN draft is present, stop and review the installed schema before choosing an upgrade. If the password rollout is already installed, skip it.
3. Open a fresh SQL Editor tab and paste the **whole revised file**, including `begin` and `commit`. Review the target project, table name, immediate `ENABLE ROW LEVEL SECURITY`, grants, and four retired invitation permissions. Choose **Run** with no partial selection. Using Studio's published checks, neither a destructive-query warning nor a missing-RLS warning is expected for the full revised SQL. If Studio asks for a general confirmation and the displayed changes match this review, choose **Run query**. If it specifically reports missing RLS, cancel and verify the complete SQL. The migration supplies its own RLS statement. [Studio query checks](https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/SQLEditor/SQLEditor.utils.ts) · [Studio confirmation options](https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/SQLEditor/RunQueryWarningModal.tsx)
4. Under **Authentication → Sign In / Providers**, enable email/password and keep the project's password strength, rate limits and email-confirmation settings. On a private dedicated project, public signup can stay disabled. The server calls `admin.createUser` with an explicit fresh user ID and `email_confirm: true`. The address is assigned by the workplace and mailbox ownership has not been verified. Provisioning and password resets have no SMTP, invitation redirect or paid Auth Hook dependency. The two ordinary Postgres triggers validate only changes bearing Shiftbook's server-written operation ID. Keep the existing app environment variables, including the server-only Supabase secret and both existing kiosk PIN keys, then deploy the updated app. [Supabase admin provisioning](https://supabase.com/docs/reference/javascript/auth-admin-createuser) · [Supabase admin updates](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid)

### Audit of the withdrawn PIN-login draft

| Previous statement or object | Effect and decision |
| --- | --- |
| `DROP FUNCTION` on `prepare_employee_invite`, `finish_employee_invite`, `employee_invite_details` and `accept_employee_invite` | Removed four APIs. Retiring their execution permissions is sufficient to stop outstanding Shiftbook invitations granting a membership. The revised file revokes those permissions and retains the functions and historical invitation rows. |
| `DELETE FROM auth.one_time_tokens` for bound recipients, and `UPDATE auth.users` to clear `confirmation_token`, `recovery_token`, `confirmation_sent_at` and `recovery_sent_at` | Could invalidate an unrelated confirmation or recovery request for a recipient. Both statements were removed. Supabase-issued links follow their existing Auth expiry. |
| New private tables `login_changes` and `login_limits` | Stored pending credential-change information and rate-limit buckets. Both had revoked client grants but neither enabled RLS. The revised file creates only `timesheet_private.dashboard_login_changes`, enables RLS in the same transaction, and revokes all table privileges from PUBLIC, anonymous, authenticated and service roles. It has zero client policies. Its owner accesses it through narrowly granted definer functions. |
| Runtime deletes inside functions | The completed-change trigger deleted the consumed `login_changes` row. The form limiter deleted stale `login_limits` rows, and the password hook deleted an account's failure counter on successful verification. Other writes in those routines replaced pending operation details on retry, advanced or reset rate-limit counters and consumed short-lived sign-in permits. These were runtime operations. The revised code records completion on the single per-employee operation row and uses standard Supabase password authentication. |
| PIN setter rename, grants, function replacements and triggers | The old draft renamed `set_employee_pin`, replaced the profile and `my_role` functions, added `employees.pin_login_since` and an index, and installed credential, membership and session triggers. At runtime it could overwrite PIN verifiers/envelopes, change credential revisions, and deny previously usable sessions through existing RLS policies. This revision keeps the installed PIN setter, role checks, memberships and policies. It updates the admin profile function to show dashboard status. |

Applying the revised migration performs no data backfill, account reset, token cleanup, deletion or policy replacement. Later, a successful explicit admin action can create an employee membership, link its employee row, update the login address, or replace the Supabase password. The operation table contains request metadata only. A conflicting or superseded operation rolls back inside the Auth transaction.

### Verify onboarding

1. In **Admin → Employees → Add Employee**, enter a name, an unused email and a chosen or generated kiosk PIN. Save, record the displayed dashboard credentials privately, and choose **Done**. Sign in from a separate browser with the email and generated password. Use the six-digit PIN at the authorised kiosk and confirm the recorded shift appears in the employee dashboard.
2. Use **Change PIN**, then verify the existing dashboard password still works. Choose **Reset dashboard password → Confirm password reset**. Verify the new password works, the previous password fails, and the workplace kiosk still accepts the same PIN.
3. Omit email to add kiosk-only staff. From their existing profile, **Enable dashboard access** adds the new login and preserves historical shifts. A disputed or already-registered address requires a different unused address for a new account. If provisioning fails after the employee was created, retry from that employee's profile. If a successful delivery response was lost, an admin can issue a fresh password.
4. Existing linked employees keep their current login, password and history. An active single-workplace employee account can have its password explicitly reset or login email changed. A confirmed reset changes the password for that Supabase identity across the project, including any other app sharing that identity. Accounts with administrator or other workplace memberships, elevated Auth roles or non-email providers are excluded. Deactivation continues to remove access to that workplace and its kiosk.

## Phase 3A timesheet management

**Upgrade an existing Phase 2 workplace.** In the target Supabase project's **SQL Editor → New query**, paste and run the complete [Phase 3A migration](supabase/migrations/20261121000200_timesheet_management.sql) once as the database owner. Use this read-only check first if unsure whether it has run:

```sql
select to_regprocedure('public.manage_work_session(uuid,uuid,uuid,text,bigint,timestamptz,timestamptz,text,text)') is not null as phase_3a_installed;
```

If the result is true, skip the migration. Deploy or restart the application after applying the SQL. Use the existing environment variables. The migration extends the original session and audit tables and replaces the overlap constraint inside a transaction. Apply it during a quiet interval, because PostgreSQL locks the sessions table while rebuilding the constraint. Existing clock receipts, device attribution, review information and legacy edit history are preserved.

**Try a correction in a test workplace.**

1. Sign in as an administrator, navigate to the week containing **19 November 2026**, and choose **Add session**. Select an employee, set **17:00** and **22:30** on that date, and enter the reason **Missed clock-in**. Use a past interval free of other sessions. Verify **Manual entry**, **Pending** and a **5h 30m** contribution to the weekly total.
2. Open the row and select **Mark Reviewed**. Open it again and choose **Reopen for correction**. The editor opens immediately. Change the finish to **23:00**, add a note and enter the correction reason. Saving adds 30 minutes to the weekly total.
3. Open **Change history** to see the original values, corrections, reasons, timestamps and administrator identifiers. Mark the session Reviewed again. Refresh the employee's personal timesheet for that week to see **6h**, the updated note and **Reviewed**.
4. To cancel a mistaken record, reopen it if reviewed, then select **Void session** and confirm with a reason. The row and history stay visible. Its hours and count are excluded from the totals, and the employee can record another shift in that interval.

Dates in the editor use the workplace timezone. For a repeated time at the end of daylight saving, select the intended UTC offset. A skipped local time is unavailable. Weekly totals sum elapsed time within local Monday-to-Monday boundaries at stored timestamp precision. The hours label displays to the nearest second. An open session can be corrected or completed and becomes eligible for review once it has a finish time. If another administrator or a kiosk has already changed a session, reopen its details before editing again.

## Restaurant kiosk rollout

For an existing installation with the first four migrations applied, run **only** [the restaurant kiosk URL migration](supabase/migrations/20261121000100_restaurant_kiosk_urls.sql). In the target Supabase project open **SQL Editor → New query**, paste the complete file, and select **Run** once as the database owner. For a fresh database apply all migration files in `supabase/migrations` in filename order.

The migration assigns permanent URL slugs to existing and future restaurants. Duplicate names receive numeric suffixes, reserved routes are skipped, and names without usable characters receive a fallback. Renaming a restaurant keeps its original URL. To check the result in SQL Editor, run `select name, slug from public.organisations order by name, slug;`. Existing devices and attendance keep their organisation IDs.

### Local development with two tabs

One Next.js process serves both origins. The defaults below work in Chrome on the same computer without DNS or hosts-file edits. To set them explicitly, add these lines to `.env.local`:

```dotenv
SHIFTBOOK_APP_ORIGIN=http://localhost:3000
SHIFTBOOK_KIOSK_ORIGIN=http://127.0.0.1:3000
```

1. Apply the migration and start `npm run dev`. If using another port, set both origins to that port and start Next with `npm run dev -- --port PORT`, substituting the port number.
2. Open `http://localhost:3000`, sign in as an administrator, and select **Kiosks → Open Kiosk**. A second tab opens the exact restaurant URL, for example `http://127.0.0.1:3000/wattle-lane-cafe`.
3. Enter the administrator credentials, name the device and select **Activate Kiosk**. Leave the PIN screen open and continue using the dashboard in the first tab. A closed kiosk tab resumes when reopened in the same browser profile.

The old main-host `/kiosk` URL has been retired. On rollout, activate each existing tablet once at its new restaurant URL and update its bookmark. Host-only cookies stay on the hostname where they were issued. Revoke the superseded registration from **Kiosks** after confirming the replacement device. Its historical attendance stays intact.

### Production on Vercel

Add the app domain and kiosk subdomain to **Settings → Domains** on the same Vercel project, both assigned to the production deployment. Configure the DNS records shown by Vercel at your DNS provider and verify HTTPS for both names. Set `SHIFTBOOK_APP_ORIGIN=https://shiftbook.com` and `SHIFTBOOK_KIOSK_ORIGIN=https://kiosk.shiftbook.com` in the Production environment, substituting your actual domains, then redeploy. Keep both domains serving the app directly. A redirect from one to the other defeats the hostname split. [Vercel domain setup](https://vercel.com/docs/domains/working-with-domains/add-a-domain)

Both origins must have different hostnames. The server accepts the configured Host and checks the exact Origin on actions. Other hostnames, including an unconfigured deployment alias, return 404. Configure a separate origin pair if you need a preview environment. Both hosts use the existing Supabase project and its settings below.

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

1. Open the restaurant's kiosk link on the workplace device. Check the restaurant name, enter the administrator email and password, set the device name and select **Activate Kiosk**. The PIN screen opens.
2. Enter a six-digit employee PIN and select **Clock In / Out**. Check the first name, direction and recorded time. The screen returns to PIN entry after about three seconds. Repeat at shift end. If the response is interrupted, **Check recorded result** reads the original submission's receipt.
3. Reopen the same restaurant URL to resume PIN entry. Use **Exit Kiosk** and reauthenticate to deactivate this device. The dashboard tab stays signed in.
4. On the administrator dashboard, **Kiosks** shows registrations, status and last contact. **Rename** changes the device label. **Revoke access → Confirm revocation** immediately blocks further clock actions. Refresh a revoked tablet to see the activation form. If a tablet loses its browser data, revoke its old registration before activating the new browser profile.

Staff with physical access to an unlocked dashboard tab can use that session. Sign out of the main application before leaving a shared tablet unattended. The kiosk keeps running.

One browser profile on the kiosk hostname has one active restaurant registration. A different restaurant URL cannot switch that registration. Deactivate the kiosk at its original URL before reassigning the profile. The restaurant display name is visible to visitors who know or guess the URL. Employee information requires authorisation.

### Security and operating limits

- Use HTTPS on shared devices. Local Chrome supports development at `http://localhost`. The browser holds its credential in a persistent Secure, HttpOnly, host-only, SameSite=Strict cookie. Activation and exit use a fresh Supabase password sign-in scoped to the server request.
- An active screen checks in about once a minute. Credentials rotate automatically within 30 days of their 90-day expiry on the same registration. A bounded overlap recovers a lost renewal response. A temporary disconnect retries check-in. After an interrupted attendance submission, receipt lookup lets staff check what the server recorded. A browser offline past expiry requires administrator activation again.
- Five incorrect PINs per kiosk in ten minutes cause a ten-minute lock.
- A database transaction locks the device and employee, checks the PIN and active status, consumes the challenge, records the server time and saves a device-bound receipt. Overlapping requests and a three-second guard prevent near-simultaneous opposite actions. Receipt lookup is read-only for 24 hours. No staff directory is returned to the kiosk.
- Administrators who can reveal PINs are trusted with plaintext for their organisation. Protect administrator accounts and both server keys. The encryption key plus a database copy enables decryption. Losing or replacing that key requires resetting retrievable PINs unless you perform a managed re-encryption. Disable logging of cookies and request/response bodies in hosting, analytics and error reporting. The app cannot prevent a privileged user from photographing a revealed PIN.
- Attendance requires the registered browser credential. Physical presence still depends on device custody. Restrict remote control and extensions and revoke lost or copied profiles.

## Initial Phase 1 setup for an empty project

1. Open **SQL Editor → New query** in your existing project. Review and run [the foundation migration](supabase/migrations/20261119000100_timesheet_foundation.sql) **once** as the project database owner. It creates six tables, indexes, policies and a private helper in a single transaction. It installs the supported `btree_gist` extension if needed. An object-name collision aborts the transaction. Inspect any conflict before retrying. Running the app never applies the migration.
2. In **Project Settings → Data API**, check that the Data API is enabled and that `public` is an exposed schema. Keep `timesheet_private` outside the exposed schemas. The migration supplies the required grants and row policies.
3. Under **Authentication → Sign In / Providers**, enable the **Email** provider. For this staff-only app, disable **Allow new users to sign up** if the project is dedicated to this app. This setting is project-wide. Sign-in uses email and password and requires no OAuth callback. [Supabase Auth configuration](https://supabase.com/docs/guides/auth/general-configuration)
4. In **Authentication → Users → Add user → Create new user**, create and confirm the initial administrator account. Copy its user UUID. The administrator can onboard staff from the app once the migrations are installed.
5. In **SQL Editor → New query**, replace the administrator UUID placeholder, business name and timezone below. Run once to create your first workplace. The transaction rolls back if the administrator UUID is invalid.

```sql
do $$
declare
  business uuid;
  admin_uid uuid := 'REPLACE_WITH_ADMIN_USER_UUID';
begin
  insert into public.organisations (name, timezone)
    values ('Your café', 'Australia/Brisbane') returning id into business;

  insert into public.organisation_memberships (organisation_id, user_id, role)
    values (business, admin_uid, 'admin');
end $$;
```

Use your business’s IANA timezone, for example `Australia/Sydney`, `Australia/Adelaide` or `Australia/Perth`. Memberships grant access to individual businesses. An employee membership also needs an active employee record with the same organisation and Auth user ID. New employee dashboard logins require an unused email address.

## Database and access model

| Table | Authenticated read access |
| --- | --- |
| `organisations` | Workplaces where the user has an effective, active membership. |
| `organisation_memberships` | Own effective membership for employees. Administrators can read all membership rows in their workplace. |
| `employees` | Own active staff profile for employees. Administrators can read the entire workplace directory, including archived staff and staff without personal logins. |
| `kiosk_devices` | Workplace administrators only. Stores device metadata, activation, expiry and revocation timestamps. |
| `work_sessions` | Own sessions for employees, all workplace sessions for administrators. Includes optional notes, clock-device references and review attribution. |
| `timesheet_edit_history` | Workplace administrators only. Holds session changes, before/after values, administrator, timestamp and reason. |

All six public tables have RLS enabled and authenticated users have SELECT-only table grants. The private `employee_pins` and `kiosk_credentials` tables have RLS and no client table grants. Administrator actions require an active workplace administrator session. Dashboard login changes additionally use the server-only Auth Admin API and recheck membership when Auth commits the write. Only the server's service role can execute the kiosk attendance, receipt and heartbeat RPCs. Those functions require the device digest and derive the organisation from its registration. SQL Editor runs with administrative privileges.

The request proxy refreshes auth cookies and disables shared caching on workspace requests. The server verifies identity using `getClaims()` and looks up current memberships using the caller’s Supabase client. Protected data requests verify both the organisation and role. PostgreSQL enforces row access again, independently of the URL or interface. Roles come from database memberships. [Supabase SSR guide](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs) · [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

Composite foreign keys keep employees, devices, reviews and edit history within their organisation. A PostgreSQL exclusion constraint rejects overlapping sessions, including two open sessions for one employee, even during concurrent inserts. Back-to-back sessions are valid. Times use `timestamptz`. Deactivate staff from their profile. This removes employee workspace access while preserving historical records for administrators. Set `organisation_memberships.active` to false to revoke a membership of either role.

## Verify the installation

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

Run the production server after stopping any dev server on the same port.

The test suite applies the migrations to disposable PostgreSQL and checks the upgrade from populated Phase 2 data, PIN encryption and audit, tenant isolation, direct activation, reauthentication, renewal, lockout, receipts and weekly totals. Run `npm run test:browser` for the same-profile admin and kiosk tabs plus a separate employee session, including a lost response. It launches an isolated local app with test Auth/Data API fixtures and a fresh database. Set `CHROME_PATH` to an installed Chrome/Chromium executable (macOS Google Chrome is detected automatically). The test uses a temporary copy of the app and its installed dependencies.

1. Signed out, visit `/workspace`. Expect the sign-in page. Try both public previews, change weeks, and open a restaurant kiosk URL from an unregistered browser.
2. Sign in as the administrator. Verify the new workplace and employee directory. A newly provisioned workplace has an empty timesheet. Sign out and sign in as the employee in a separate browser profile. The same organisation’s admin URL should return a 404 for that employee.
3. In a test workplace, use **Add session** for a past overnight interval from 22:00 to 02:00 the next day. In Brisbane this contributes four hours across those dates. Verify the entry in both authorised views.
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

For Vercel, use the Next.js preset and Node 22 or newer. Configure the two origins and the five Supabase and PIN variables and apply the appropriate migrations to the target Supabase project.
