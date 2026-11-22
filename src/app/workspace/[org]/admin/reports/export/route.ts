import { requireWorkspace } from "@/lib/workspace";
import { getWeek } from "@/lib/timesheets";
import { loadReport, reportDirectory } from "@/lib/report-records";
import { reportFilters, reportCsv, ReportInputError } from "@/lib/reports";

export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: RouteContext<"/workspace/[org]/admin/reports/export">,
) {
  const { org } = await params;
  const { client, membership } = await requireWorkspace(org, "admin");
  const { name, timezone: zone } = membership.organisations;
  const query = new URL(request.url).searchParams;
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  try {
    const kind = query.get("format") ?? "detail";
    if (
      query.getAll("format").length > 1 ||
      (kind !== "detail" && kind !== "summary")
    )
      throw new ReportInputError("Choose a valid CSV format.");
    const filters = reportFilters(query, zone, getWeek(undefined, zone).key);
    const report = await loadReport(
      client,
      org,
      filters,
      await reportDirectory(client, org),
    );
    const csv = reportCsv(report, name, kind, new Date().toISOString());
    const filename =
      "shiftbook-timesheets-" +
      (kind === "summary" ? "summary-" : "") +
      filters.first +
      "-to-" +
      filters.last +
      ".csv";
    headers.set("Content-Type", "text/csv; charset=utf-8");
    headers.set(
      "Content-Disposition",
      'attachment; filename="' + filename + '"',
    );
    return new Response(csv, { headers });
  } catch (error) {
    return new Response(
      error instanceof ReportInputError
        ? error.message
        : "The report could not be exported. Refresh the report and try again.",
      { status: error instanceof ReportInputError ? 400 : 503, headers },
    );
  }
}
