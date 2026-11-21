"use client";

import { useState } from "react";
import { SessionDialog, sessionStatus } from "./session-dialog";
import Link from "next/link";
import {
  CalendarDays,
  CalendarRange,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Hourglass,
} from "lucide-react";
import type { Role } from "@/lib/workspace";
import {
  dayLabel,
  elapsed,
  hours,
  timeLabel,
  type Session,
  type Staff,
  type Week,
} from "@/lib/timesheets";

export function StaffList({ staff, org }: { staff: Staff[]; org?: string }) {
  return (
    <>
      <p className="eyebrow">
        <span className="rule" /> Team directory
      </p>
      <h1>Employees</h1>
      <p className="lead">Active and archived staff at this workplace.</p>
      <section className="panel">
        <div className="section-head">
          <h2>Staff directory</h2>
          <span>{staff.length} employees</span>
        </div>
        {staff.map((person) => (
          <div className="directory-row" key={person.id}>
            {org ? (
              <Link
                className="employee-link"
                href={
                  "/workspace/" + org + "/admin?view=staff&person=" + person.id
                }
              >
                <Person name={person.display_name} />
              </Link>
            ) : (
              <Person name={person.display_name} />
            )}
            <span
              className={"status " + (person.active ? "reviewed" : "archived")}
            >
              {person.active ? "Active" : "Archived"}
            </span>
          </div>
        ))}
        {!staff.length && <p className="empty">No employees yet.</p>}
      </section>
    </>
  );
}

function Person({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("");
  return (
    <span className="person">
      <span className="avatar" aria-hidden="true">
        {initials}
      </span>
      {name}
    </span>
  );
}
function Status({ session }: { session: Session }) {
  return (
    <span
      className={
        "status " +
        (session.voided_at
          ? "archived"
          : session.reviewed_at
            ? "reviewed"
            : "pending")
      }
    >
      {session.reviewed_at ? <CheckCheck size={14} /> : <Hourglass size={13} />}
      {sessionStatus(session)}
    </span>
  );
}

export function TimesheetBoard({
  role,
  staff,
  sessions,
  week,
  zone,
  base,
  employee,
  org,
}: {
  role: Role;
  staff: Staff[];
  sessions: Session[];
  week: Week;
  zone: string;
  base: string;
  employee?: string;
  org?: string;
}) {
  const [dialog, setDialog] = useState<Session | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const admin = role === "admin";
  const selected =
    admin && staff.some((p) => p.id === employee) ? employee : "";
  const rows = selected
    ? sessions.filter((s) => s.employee_id === selected)
    : sessions;
  const names = new Map(staff.map((p) => [p.id, p.display_name]));
  const weekUrl = (date: string) =>
    base +
    "?week=" +
    date +
    (selected ? "&employee=" + encodeURIComponent(selected) : "");
  const finishLabel = (s: Session) => {
    if (!s.ended_at) return s.voided_at ? "—" : "Currently working";
    const endDay = dayLabel(s.ended_at, zone);
    return (
      timeLabel(s.ended_at, zone) +
      (endDay !== dayLabel(s.started_at, zone) ? " · " + endDay : "")
    );
  };
  return (
    <>
      <p className="eyebrow">
        <span className="rule" />
        {admin ? "Workplace overview" : "Employee workspace"}
      </p>
      <h1>{admin ? "Weekly timesheets" : "My timesheet"}</h1>
      <div className="week-strip">
        <div>
          <CalendarRange size={19} />
          <strong>{week.label}</strong>
        </div>
        <div className="week-controls">
          <Link aria-label="Previous week" href={weekUrl(week.previous)}>
            <ChevronLeft size={19} />
          </Link>
          <Link aria-label="Next week" href={weekUrl(week.next)}>
            <ChevronRight size={19} />
          </Link>
        </div>
      </div>
      <div className="metrics">
        <div className="metric primary">
          <span>
            <Clock3 />
            Weekly hours
          </span>
          <strong>
            {hours(rows.reduce((n, s) => n + elapsed(s, week), 0))}
          </strong>
          <small>Completed time this week</small>
        </div>
        <div className="metric">
          <span>
            <CalendarDays />
            Work sessions
          </span>
          <strong>{rows.filter((s) => !s.voided_at).length}</strong>
          <small>Across the selected week</small>
        </div>
        <div className="metric">
          <span>
            <Hourglass />
            Pending review
          </span>
          <strong>
            {
              rows.filter((s) => !s.reviewed_at && s.ended_at && !s.voided_at)
                .length
            }
          </strong>
          <small>Awaiting administrator review</small>
        </div>
      </div>
      {notice && (
        <p role="status" className="shift-notice">
          {notice}
        </p>
      )}
      {dialog && org && (
        <SessionDialog
          org={org}
          session={dialog === "new" ? null : dialog}
          staff={staff}
          selected={selected || ""}
          week={week.key}
          zone={zone}
          close={() => setDialog(null)}
          saved={(msg) => {
            setNotice(msg);
            setDialog(null);
          }}
        />
      )}
      <section className="panel">
        <div className="section-head">
          <div>
            <h2>Work sessions</h2>
            <small>{zone.replaceAll("_", " ")}</small>
          </div>
          {admin && (
            <div className="shift-tools">
              {org && !!staff.length && (
                <button
                  className="button"
                  onClick={() => {
                    setNotice("");
                    setDialog("new");
                  }}
                >
                  Add session
                </button>
              )}
              <form className="filter" action={base}>
                <input type="hidden" name="week" value={week.key} />
                <select
                  key={selected}
                  name="employee"
                  aria-label="Filter by employee"
                  defaultValue={selected}
                >
                  <option value="">All employees</option>
                  {staff.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
                <button>Filter</button>
              </form>
            </div>
          )}
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <CalendarDays />
            <p>No work sessions for this week.</p>
          </div>
        ) : admin ? (
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Weekly sessions"
          >
            <table>
              <thead>
                <tr>
                  {[
                    "Employee",
                    "Date",
                    "Clock in",
                    "Clock out",
                    "Hours",
                    "Review",
                    "Note",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr
                    key={s.id}
                    className={org ? "editable-shift" : undefined}
                    onClick={
                      org
                        ? () => {
                            setNotice("");
                            setDialog(s);
                          }
                        : undefined
                    }
                  >
                    <td>
                      {org ? (
                        <button
                          className="employee-link"
                          aria-label={
                            "Open session for " +
                            names.get(s.employee_id) +
                            " on " +
                            dayLabel(s.started_at, zone) +
                            " at " +
                            timeLabel(s.started_at, zone)
                          }
                        >
                          <Person
                            name={names.get(s.employee_id) ?? "Employee"}
                          />
                        </button>
                      ) : (
                        <Person name={names.get(s.employee_id) ?? "Employee"} />
                      )}
                      {s.created_by && (
                        <small className="manual-label">Manual entry</small>
                      )}
                    </td>
                    <td>{dayLabel(s.started_at, zone)}</td>
                    <td>{timeLabel(s.started_at, zone)}</td>
                    <td>{finishLabel(s)}</td>
                    <td>
                      {s.voided_at ? "—" : s.ended_at ? hours(elapsed(s)) : "—"}
                    </td>
                    <td>
                      <Status session={s} />
                    </td>
                    <td>{s.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="session-list">
            {rows.map((s) => (
              <article className="session-card" key={s.id}>
                <div>
                  <strong>{dayLabel(s.started_at, zone)}</strong>
                  <Status session={s} />
                </div>
                <div className="session-time">
                  <span>
                    {timeLabel(s.started_at, zone)} – {finishLabel(s)}
                  </span>
                  <b>
                    {s.voided_at
                      ? "Excluded"
                      : s.ended_at
                        ? hours(elapsed(s))
                        : "Open session"}
                  </b>
                </div>
                {s.note && <p>{s.note}</p>}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
