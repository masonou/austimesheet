"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ReportPeriod } from "@/lib/reports";
import type { Staff } from "@/lib/timesheets";
import { Button } from "./ui/button";

type Props = {
  children: React.ReactNode;
  path: string;
  period: ReportPeriod;
  first: string;
  last: string;
  ids: readonly string[];
  staff: Staff[];
};
export function ReportFilters({
  path,
  period,
  first,
  last,
  ids,
  staff,
  children,
}: Props) {
  const [mode, setMode] = useState(period),
    [some, setSome] = useState(ids.length > 0);
  const [selected, setSelected] = useState(ids),
    [error, setError] = useState("");
  const [pending, transition] = useTransition(),
    router = useRouter();
  const [edited, setEdited] = useState(false);
  return (
    <>
      <form
        onChange={() => setEdited(true)}
        className="panel report-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (some && !selected.length) {
            setError("Select at least one employee.");
            return;
          }
          const values = new FormData(event.currentTarget);
          const query = new URLSearchParams({ period: mode });
          if (mode === "fortnight" || mode === "custom")
            query.set("start", String(values.get("start")));
          if (mode === "custom") query.set("end", String(values.get("end")));
          if (some) for (const id of selected) query.append("employee", id);
          setError("");
          setEdited(false);
          transition(() => router.push(path + "?" + query, { scroll: false }));
        }}
      >
        <label>
          Reporting period
          <select
            aria-label="Reporting period"
            value={mode}
            onChange={(e) => setMode(e.target.value as ReportPeriod)}
          >
            <option value="this-week">This week</option>
            <option value="last-week">Last week</option>
            <option value="fortnight">Fortnight</option>
            <option value="custom">Custom date range</option>
          </select>
        </label>
        {(mode === "fortnight" || mode === "custom") && (
          <label>
            Start date
            <input type="date" name="start" defaultValue={first} required />
          </label>
        )}
        {mode === "custom" && (
          <label>
            End date
            <input type="date" name="end" defaultValue={last} required />
          </label>
        )}
        <label>
          Employees
          <select
            aria-label="Employees"
            value={some ? "some" : "all"}
            onChange={(e) => {
              setSome(e.target.value === "some");
              setError("");
            }}
          >
            <option value="all">All employees</option>
            <option value="some">Selected employees</option>
          </select>
        </label>
        {some && (
          <fieldset className="report-choices">
            <legend>Select employees</legend>
            {staff.map((p) => (
              <label key={p.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  onChange={(e) => {
                    setSelected(
                      e.target.checked
                        ? [...selected, p.id]
                        : selected.filter((id) => id !== p.id),
                    );
                    setError("");
                  }}
                />
                {p.display_name}
                {!p.active && " (inactive)"}
              </label>
            ))}
          </fieldset>
        )}
        <Button disabled={pending}>
          {pending ? "Loading report…" : "Apply filters"}
        </Button>
        {error && <p role="alert">{error}</p>}
      </form>
      {edited && (
        <p role="status">Apply filters to update the report and exports.</p>
      )}
      <div
        className="report-results"
        inert={edited || pending}
        aria-busy={pending}
      >
        {children}
      </div>
    </>
  );
}
