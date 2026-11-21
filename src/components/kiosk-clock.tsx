"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleCheck } from "lucide-react";
import {
  checkClockResult,
  clockWithPin,
  connectKiosk,
  authoriseKiosk,
} from "@/app/kiosk/actions";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

type Connection = Awaited<ReturnType<typeof connectKiosk>>;
type Result = Awaited<ReturnType<typeof clockWithPin>>;

export function KioskScreen() {
  const [connection, setConnection] = useState<Connection | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: number;
    async function poll() {
      let reply: Connection;
      try {
        reply = await connectKiosk();
      } catch {
        reply = { status: "offline" };
      }
      if (stopped) return;
      setConnection((old) =>
        reply.status === "offline" && old?.status === "active" ? old : reply,
      );
      if (reply.status === "active" || reply.status === "offline")
        timer = window.setTimeout(
          poll,
          reply.status === "active" ? 60000 : 4000,
        );
    }
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);
  const [exit, setExit] = useState(false);
  if (connection?.status === "active") {
    if (exit)
      return <KioskAuthorisation mode="exit" cancel={() => setExit(false)} />;
    return (
      <>
        <Clock context={connection} />
        <button className="quiet-link" onClick={() => setExit(true)}>
          Exit Kiosk
        </button>
      </>
    );
  }
  if (connection?.status === "setup")
    return <KioskAuthorisation mode="activate" reason={connection.reason} />;
  if (connection?.status === "mismatch")
    return (
      <p role="alert">
        This browser is registered to another workplace. Open its original kiosk
        link to continue.
      </p>
    );
  return (
    <p role="status">
      {connection
        ? "Kiosk connection unavailable. Reconnecting…"
        : "Connecting to the workplace kiosk…"}
    </p>
  );
}

function KioskAuthorisation({
  mode,
  reason,
  cancel,
}: {
  mode: "activate" | "exit";
  reason?: string;
  cancel?: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fields = new FormData(e.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      const r = await authoriseKiosk(mode, fields);
      if (r.error) setMessage(r.error);
      else window.location.reload();
    } catch {
      setMessage("Connection interrupted. Refresh to check the kiosk status.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1 className="kiosk-heading">
        {mode === "exit" ? "Exit Kiosk" : "Activate Kiosk"}
      </h1>
      <p>
        {reason ?? "Enter an administrator password to deactivate this kiosk."}
      </p>
      <form
        className="kiosk-form"
        method="post"
        onSubmit={submit}
        autoComplete="off"
      >
        <label>
          Admin email
          <Input type="email" name="email" autoComplete="off" required />
        </label>
        <label>
          Password
          <Input type="password" name="password" autoComplete="off" required />
        </label>
        {mode === "activate" && (
          <label>
            Kiosk name
            <Input
              name="name"
              defaultValue="Workplace kiosk"
              maxLength={80}
              required
            />
          </label>
        )}
        {message && <p role="alert">{message}</p>}
        <Button disabled={busy}>
          {busy
            ? "Checking…"
            : mode === "exit"
              ? "Deactivate kiosk"
              : "Activate Kiosk"}
        </Button>
        {cancel && (
          <button type="button" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        )}
      </form>
    </>
  );
}

function Clock({
  context,
}: {
  context: Extract<Connection, { status: "active" }>;
}) {
  const [now, setNow] = useState(() => new Date());
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState("");
  const submitted = useRef("");
  const requestId = useRef("");
  const running = useRef(false);
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (result?.status !== "recorded") return;
    const t = setTimeout(() => location.reload(), 3000);
    return () => clearTimeout(t);
  }, [result]);
  const format = (time: Date, options: Intl.DateTimeFormatOptions) =>
    time.toLocaleString("en-AU", { timeZone: context.zone, ...options });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running.current) return;
    const form = event.currentTarget;
    const pin = String(new FormData(form).get("pin") ?? "");
    submitted.current =
      result?.status === "error" && result.challenge
        ? result.challenge
        : context.challenge;
    requestId.current = crypto.randomUUID();
    running.current = true;
    setBusy(true);
    form.reset();
    try {
      setResult(await clockWithPin(pin, submitted.current, requestId.current));
    } catch {
      setResult({ status: "uncertain" });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function check() {
    setBusy(true);
    try {
      const r = await checkClockResult(submitted.current, requestId.current);
      if (r) setResult(r);
      else
        setLookup(
          "No receipt confirmed. Check again or ask an administrator to check your timesheet.",
        );
    } catch {
      setLookup("Still offline. Check again when the connection returns.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="eyebrow">{context.name}</p>
      <strong className="kiosk-time">
        {format(now, { timeStyle: "short" })}
      </strong>
      <p>
        {format(now, { dateStyle: "full" })} ·{" "}
        {context.zone.replaceAll("_", " ")}
      </p>
      <div className="clock-step" aria-live="polite">
        {result?.status === "recorded" ? (
          <>
            <CircleCheck aria-hidden className="success-mark" />
            <h1 className="kiosk-heading">
              {result.firstName} · Clocked {result.action.toUpperCase()}
            </h1>
            <p>
              Recorded at {format(new Date(result.at), { timeStyle: "medium" })}
            </p>
          </>
        ) : result?.status === "uncertain" ? (
          <>
            <h1 className="kiosk-heading">Check your clock result</h1>
            <p>
              The response was interrupted. Checking reads your receipt without
              clocking again.
            </p>
            <Button disabled={busy} onClick={check}>
              Check recorded result
            </Button>
            <p>{lookup}</p>
            <button className="quiet-link" onClick={() => location.reload()}>
              Return to PIN entry
            </button>
          </>
        ) : context.locked ||
          (result?.status === "error" && !result.challenge) ? (
          <>
            <p role="alert">
              {result?.status === "error"
                ? result.message
                : "Too many incorrect PINs. Try again in ten minutes."}
            </p>
            <Button onClick={() => location.reload()}>Refresh kiosk</Button>
          </>
        ) : (
          <form method="post" onSubmit={submit} className="kiosk-form">
            <h1 className="kiosk-heading">
              <label htmlFor="attendance-pin">Enter your PIN</label>
            </h1>
            <Input
              id="attendance-pin"
              name="pin"
              className="pin-field"
              type="password"
              autoComplete="off"
              inputMode="numeric"
              maxLength={6}
              pattern="[0-9]{6}"
              required
              disabled={busy}
            />
            {result?.status === "error" && <p role="alert">{result.message}</p>}
            <Button disabled={busy}>
              {busy ? "Recording…" : "Clock In / Out"}
            </Button>
          </form>
        )}
      </div>
    </>
  );
}
