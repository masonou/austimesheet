import { decimalHours, type Report } from "@/lib/reports";

export function ReportPreview({
  report,
  path,
}: {
  report: Report;
  path: string;
}) {
  const { filters, hours, completed, pending, people } = report;
  // Pin relative presets to the preview's resolved dates even if Monday passes before download.
  const query = new URLSearchParams({
    period: "custom",
    start: filters.first,
    end: filters.last,
  });
  for (const id of filters.ids) query.append("employee", id);
  const download = path + "/export?" + query;
  const metrics = [
    ["Total hours", decimalHours(hours.total)],
    ["Weekday hours", decimalHours(hours.weekday)],
    ["Saturday hours", decimalHours(hours.saturday)],
    ["Sunday hours", decimalHours(hours.sunday)],
    ["Weekend hours", decimalHours(hours.saturday + hours.sunday)],
    ["Completed sessions", completed],
  ];
  return (
    <>
      <header className="report-heading">
        <div>
          <h2>
            {filters.first} – {filters.last}
          </h2>
          <small>{filters.zone} · Decimal hours</small>
        </div>
        <div className="account">
          <a className="button" href={download + "&format=xlsx"}>
            Export Excel
          </a>
          <a className="quiet-link" href={download + "&format=detail"}>
            Work sessions CSV
          </a>
          <a className="quiet-link" href={download + "&format=summary"}>
            Employee summary CSV
          </a>
        </div>
      </header>
      {pending > 0 && (
        <p className="report-warning" role="status">
          {pending} completed {pending === 1 ? "session is" : "sessions are"}{" "}
          pending review and included in these totals.
        </p>
      )}
      <div className="metrics report-metrics">
        {metrics.map(([label, value], i) => (
          <div className={"metric" + (i === 0 ? " primary" : "")} key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <section className="panel">
        <div className="section-head">
          <h2>Employee breakdown</h2>
        </div>
        {!completed && (
          <p className="empty">
            No completed sessions for this period and employee selection.
          </p>
        )}
        {people.map((p) => (
          <details className="report-person" key={p.staff.id}>
            <summary>
              <span className="person">
                {p.staff.display_name}
                {!p.staff.active && " (inactive)"}
              </span>
              <span>
                Weekday <b>{decimalHours(p.hours.weekday)}</b>
              </span>
              <span>
                Saturday <b>{decimalHours(p.hours.saturday)}</b>
              </span>
              <span>
                Sunday <b>{decimalHours(p.hours.sunday)}</b>
              </span>
              <span>
                Total <b>{decimalHours(p.hours.total)}</b>
              </span>
            </summary>
            {p.sessions.length ? (
              <div className="table-scroll">
                <table aria-label={p.staff.display_name + " sessions"}>
                  <thead>
                    <tr>
                      {[
                        "Work date",
                        "Clock in",
                        "Clock out",
                        "Hours in period",
                        "Review status",
                        "Note",
                      ].map((label) => (
                        <th key={label}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {p.sessions.map((s) => (
                      <tr key={s.id}>
                        <td>{s.day}</td>
                        <td>{s.clockIn.slice(0, 16).replace("T", " ")}</td>
                        <td>{s.clockOut.slice(0, 16).replace("T", " ")}</td>
                        <td>{decimalHours(s.hours.total)}</td>
                        <td>
                          <span
                            className={
                              "status " +
                              (s.review === "Pending" ? "pending" : "reviewed")
                            }
                          >
                            {s.review}
                          </span>
                        </td>
                        <td>{s.note || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty">No completed sessions.</p>
            )}
          </details>
        ))}
      </section>
    </>
  );
}
