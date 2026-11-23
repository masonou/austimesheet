"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Temporal } from "@js-temporal/polyfill";
import { Button } from "./ui/button";
import {
  elapsed,
  hours,
  shiftChoices,
  shiftField,
  type Session,
  type Staff,
} from "@/lib/timesheets";
import {
  changeSession,
  sessionHistory,
  type SessionChange,
  type HistoryEntry,
} from "@/app/workspace/session-actions";

export function sessionStatus(s: Session) {
  return s.voided_at
    ? "Voided"
    : s.reviewed_at
      ? "Reviewed"
      : s.ended_at
        ? "Pending"
        : "Open";
}
function stamp(value: string | null, zone: string) {
  if (!value) return "Open";
  const t = Temporal.Instant.from(value).toZonedDateTimeISO(zone);
  return (
    t.toPlainDateTime().toString({ smallestUnit: "minute" }).replace("T", " ") +
    " (" +
    t.offset +
    ")"
  );
}

function useShiftField(
  initial: string,
  zone: string,
  original?: string | null,
) {
  const [value, setValue] = useState(initial);
  const [offset, setOffset] = useState("");
  const choices = shiftChoices(value, zone, original);
  const selected =
    choices.length === 1
      ? choices[0]
      : choices.find((c) =>
          offset ? c.offset === offset : original && c.instant === original,
        );
  return {
    value,
    choices,
    selected,
    setOffset,
    change(v: string) {
      setValue(v);
      setOffset("");
    },
  };
}
function TimeInput({
  label,
  field,
  required,
}: {
  label: string;
  field: ReturnType<typeof useShiftField>;
  required: boolean;
}) {
  return (
    <div>
      <label>
        {label}
        <input
          type="datetime-local"
          required={required}
          value={field.value}
          onChange={(e) => field.change(e.target.value)}
        />
      </label>
      {field.choices.length === 2 && (
        <label>
          {label} UTC offset
          <select
            required
            value={field.selected?.offset ?? ""}
            onChange={(e) => field.setOffset(e.target.value)}
          >
            <option value="">Choose the occurrence</option>
            {field.choices.map((c) => (
              <option key={c.offset} value={c.offset}>
                UTC{c.offset}
              </option>
            ))}
          </select>
        </label>
      )}
      {field.value && !field.choices.length && (
        <small>
          This local time does not exist during the daylight-saving change.
        </small>
      )}
    </div>
  );
}

export function SessionDialog({
  org,
  session: initialSession,
  staff,
  selected,
  week,
  zone,
  close,
  saved,
}: {
  org: string;
  session: Session | null;
  staff: Staff[];
  selected: string;
  week: string;
  zone: string;
  close: () => void;
  saved: (message: string) => void;
}) {
  const [session, setSession] = useState(initialSession);
  const [feedback, setFeedback] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  const [id] = useState(() => session?.id ?? crypto.randomUUID());
  const [mode, setMode] = useState<"details" | "edit" | "void">(
    session ? "details" : "edit",
  );
  const [employee, setEmployee] = useState(
    session?.employee_id || selected || "",
  );
  const [note, setNote] = useState(session?.note ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const start = useShiftField(
    session ? shiftField(session.started_at, zone) : week + "T09:00",
    zone,
    session?.started_at,
  );
  const finish = useShiftField(
    session?.ended_at
      ? shiftField(session.ended_at, zone)
      : session
        ? ""
        : week + "T17:00",
    zone,
    session?.ended_at,
  );
  const from = start.selected?.instant,
    to = finish.selected?.instant;
  const duration =
    from && to
      ? elapsed({ started_at: from, ended_at: to, voided_at: null })
      : 0;
  const person = staff.find((p) => p.id === employee)?.display_name;
  async function submit(operation: SessionChange["operation"]) {
    if (busy) return;
    if (
      (operation === "create" || operation === "edit") &&
      (!from || (finish.value && !to) || (to && duration <= 0))
    ) {
      setError("Choose valid times with the finish after the start.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await changeSession(org, {
        operation,
        id,
        employee,
        revision: session?.revision ?? null,
        start: from,
        finish: to,
        note: note || null,
        reason: operation === "void" ? reason : undefined,
      });
      if (result.error) {
        setError(result.error);
        if (result.stale) router.refresh();
        return;
      }
      if (operation === "reopen" && session && result.revision) {
        setSession({
          ...session,
          reviewed_at: null,
          revision: result.revision,
        });
        setFeedback("Session reopened for correction.");
        setHistory(null);
        setMode("edit");
        return;
      }
      saved(
        {
          create: "Session added.",
          edit: "Session updated.",
          review: "Session marked Reviewed.",
          reopen: "Session reopened for correction.",
          void: "Session voided.",
        }[operation],
      );
    } catch {
      setError(
        "Save could not be confirmed. Refresh the timesheet to check the record.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="shift-dialog"
      aria-labelledby="shift-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <header>
        <div>
          <p className="eyebrow">{zone.replaceAll("_", " ")}</p>
          <h2 id="shift-title">
            {!session
              ? "Add session"
              : mode === "edit"
                ? "Edit session"
                : mode === "void"
                  ? "Void session"
                  : "Session details"}
          </h2>
        </div>
        <button
          type="button"
          className="quiet-link"
          disabled={busy}
          onClick={close}
        >
          Close
        </button>
      </header>
      {session && (
        <p className="shift-person">
          <strong>{person}</strong> · {sessionStatus(session)}
          {session.created_by && " · Manually created"}
        </p>
      )}
      {mode === "details" && session && (
        <>
          <dl className="shift-summary">
            <dt>Clock in</dt>
            <dd>{stamp(session.started_at, zone)}</dd>
            <dt>Clock out</dt>
            <dd>{stamp(session.ended_at, zone)}</dd>
            <dt>Total hours</dt>
            <dd>
              {session.voided_at
                ? "Excluded"
                : session.ended_at
                  ? hours(elapsed(session))
                  : "In progress"}
            </dd>
            <dt>Note</dt>
            <dd>{session.note || "—"}</dd>
          </dl>
          {!session.voided_at && (
            <div className="shift-controls">
              {session.reviewed_at ? (
                <Button disabled={busy} onClick={() => submit("reopen")}>
                  Reopen for correction
                </Button>
              ) : (
                <>
                  {session.ended_at && (
                    <Button disabled={busy} onClick={() => submit("review")}>
                      Mark Reviewed
                    </Button>
                  )}
                  <button disabled={busy} onClick={() => setMode("edit")}>
                    Edit session
                  </button>
                  <button disabled={busy} onClick={() => setMode("void")}>
                    Void session
                  </button>
                </>
              )}
            </div>
          )}
          <details
            onToggle={async (e) => {
              if (e.currentTarget.open && history === null) {
                try {
                  setHistory(await sessionHistory(org, id));
                } catch {
                  setError("Could not load change history.");
                }
              }
            }}
          >
            <summary>Change history</summary>
            {history === null ? (
              <p>Loading…</p>
            ) : !history.length ? (
              <p>No administrator changes recorded.</p>
            ) : (
              history.map((h) => (
                <article className="shift-history" key={h.id}>
                  <strong>
                    {
                      {
                        create: "Manually created",
                        edit: "Edited",
                        review: "Reviewed",
                        reopen: "Reopened",
                        void: "Voided",
                      }[h.event]
                    }
                  </strong>{" "}
                  · {stamp(h.changed_at, zone)}
                  <p>{h.reason}</p>
                  {h.event === "edit" && (
                    <>
                      <p>
                        Before: {stamp(h.old_started_at, zone)} –{" "}
                        {stamp(h.old_ended_at, zone)}
                      </p>
                      <p>
                        After: {stamp(h.new_started_at, zone)} –{" "}
                        {stamp(h.new_ended_at, zone)}
                      </p>
                    </>
                  )}
                  {h.before_state?.note !== h.after_state?.note && (
                    <p>
                      Note: {h.before_state?.note || "—"} →{" "}
                      {h.after_state?.note || "—"}
                    </p>
                  )}
                </article>
              ))
            )}
          </details>
        </>
      )}
      {mode !== "details" && (
        <form
          className="shift-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(mode === "void" ? "void" : session ? "edit" : "create");
          }}
        >
          {mode === "edit" && (
            <>
              {!session && (
                <label>
                  Employee
                  <select
                    required
                    aria-label="Employee"
                    value={employee}
                    onChange={(e) => setEmployee(e.target.value)}
                  >
                    <option value="">Select employee</option>
                    {staff.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.display_name}
                        {p.active ? "" : " (archived)"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <TimeInput field={start} label="Clock in" required />
              <TimeInput
                field={finish}
                label="Clock out"
                required={!session || !!session.ended_at}
              />
              <strong>
                Total hours ·{" "}
                {duration > 0 ? hours(duration) : "—"}
              </strong>
              <label>
                Note
                <textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
            </>
          )}
          {mode === "void" && (
            <p>
              This session will be excluded from weekly totals. Its attendance
              and change history will remain available.
            </p>
          )}
          {mode === "void" && (
            <label>
              Note
              <textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}
          <div className="shift-controls">
            <Button disabled={busy}>
              {mode === "void"
                ? "Confirm void"
                : session
                  ? "Save changes"
                  : "Add session"}
            </Button>
            <button type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {feedback && <p role="status">{feedback}</p>}
      {error && <p role="alert">{error}</p>}
    </dialog>
  );
}
