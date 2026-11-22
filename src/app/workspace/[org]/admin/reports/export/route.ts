import { requireWorkspace } from "@/lib/workspace";
import { getWeek } from "@/lib/timesheets";
import { loadReport, reportDirectory } from "@/lib/report-records";
import { reportFilters, ReportInputError } from "@/lib/reports";
import { reportCsv } from "@/lib/report-export";
import { reportWorkbook } from "@/lib/report-workbook";

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
      (kind !== "xlsx" && kind !== "detail" && kind !== "summary")
    )
      throw new ReportInputError("Choose Excel or a CSV format.");
    const filters = reportFilters(query, zone, getWeek(undefined, zone).key);
    const report = await loadReport(
      client,
      org,
      filters,
      await reportDirectory(client, org),
    );
    const excel = kind === "xlsx";
    const content =
      kind === "xlsx"
        ? await reportWorkbook(report, name, new Date())
        : reportCsv(report, kind);
    const person =
      excel && filters.ids.length === 1
        ? report.people[0].staff.display_name
            .normalize("NFKD")
            .replace(/\p{Mark}/gu, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 60)
            .replace(/^-|-$/g, "") || "employee"
        : "";
    const filename =
      "shiftbook-timesheets-" +
      (kind === "summary" ? "summary-" : "") +
      (person ? person + "-" : "") +
      filters.first +
      "-to-" +
      filters.last +
      (excel ? ".xlsx" : ".csv");
    headers.set(
      "Content-Type",
      excel
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "text/csv; charset=utf-8",
    );
    headers.set(
      "Content-Disposition",
      'attachment; filename="' + filename + '"',
    );
    return new Response(content, { headers });
  } catch (error) {
    return new Response(
      error instanceof ReportInputError
        ? error.message
        : "The report could not be exported. Refresh the report and try again.",
      { status: error instanceof ReportInputError ? 400 : 503, headers },
    );
  }
}
