import { Suspense } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ReportFilters } from "@/components/report-filters";
import { ReportPreview } from "@/components/report-preview";
import { requireWorkspace } from "@/lib/workspace";
import { getWeek } from "@/lib/timesheets";
import { reportFilters, ReportInputError, type Report } from "@/lib/reports";
import { reportDirectory, loadReport } from "@/lib/report-records";

export default async function ReportsPage({
  params,
  searchParams,
}: PageProps<"/workspace/[org]/admin/reports">) {
  const { org } = await params;
  const { client, membership } = await requireWorkspace(org, "admin");
  const { name, timezone: zone } = membership.organisations;
  const base = "/workspace/" + org + "/admin",
    path = base + "/reports";
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === "string") query.append(k, v);
    else if (v) for (const item of v) query.append(k, item);
  }
  return (
    <WorkspaceShell role="admin" {...{ name, base }} reports>
      <h1>Reports</h1>
      <Suspense
        key={query.toString()}
        fallback={
          <p className="panel device-section" role="status">
            Loading report…
          </p>
        }
      >
        <ReportContent {...{ client, org, zone, path, query }} />
      </Suspense>
    </WorkspaceShell>
  );
}

async function ReportContent({
  client,
  org,
  zone,
  path,
  query,
}: {
  client: SupabaseClient;
  org: string;
  zone: string;
  path: string;
  query: URLSearchParams;
}) {
  const monday = getWeek(undefined, zone).key;
  let filters = reportFilters(new URLSearchParams(), zone, monday);
  let data: Report | undefined,
    issue = "";
  let staff: Awaited<ReturnType<typeof reportDirectory>> = [];
  try {
    staff = await reportDirectory(client, org);
    filters = reportFilters(query, zone, monday);
    data = await loadReport(client, org, filters, staff);
  } catch (error) {
    issue =
      error instanceof ReportInputError
        ? error.message
        : "The report could not be loaded. Refresh the page to try again.";
  }
  return (
    <ReportFilters
      key={query.toString()}
      {...{
        path,
        staff,
        period: filters.period,
        first: filters.first,
        last: filters.last,
        ids: filters.ids,
      }}
    >
      {issue && (
        <p className="panel device-section" role="alert">
          {issue}
        </p>
      )}
      {data && <ReportPreview report={data} path={path} />}
    </ReportFilters>
  );
}
