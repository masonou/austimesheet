"use client";

import { useEffect, useState, type FormEvent } from "react";
import { verifyPin, recordAttendance } from "@/app/kiosk/actions";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Result =
  | Awaited<ReturnType<typeof verifyPin>>
  | Awaited<ReturnType<typeof recordAttendance>>;

export function KioskClock({
  name,
  zone,
  initialTime,
  initialChallenge,
  locked,
}: {
  name: string;
  zone: string;
  initialTime: string;
  initialChallenge: string;
  locked: boolean;
}) {
  const [now, setNow] = useState(initialTime);
  const [challenge, setChallenge] = useState(initialChallenge);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const interval = window.setInterval(
      () => setNow(new Date().toISOString()),
      1000,
    );
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    const delay =
      result?.status === "recorded"
        ? 3500
        : result?.status === "ready"
          ? 45000
          : 0;
    if (!delay) return;
    const timeout = window.setTimeout(() => window.location.reload(), delay);
    return () => window.clearTimeout(timeout);
  }, [result]);
  const fmt = (time: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-AU", { timeZone: zone, ...options }).format(
      new Date(time),
    );
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const pin = String(new FormData(form).get("pin") ?? "");
    form.reset();
    setBusy(true);
    try {
      const reply = await verifyPin(pin, challenge);
      if (reply.status === "error" && reply.challenge)
        setChallenge(reply.challenge);
      setResult(reply);
    } catch {
      setResult({
        status: "error",
        message: "Connection lost. Start again to check your status.",
      });
    } finally {
      setBusy(false);
    }
  }
  async function record() {
    if (busy || result?.status !== "ready") return;
    setBusy(true);
    try {
      setResult(await recordAttendance(result.ticket));
    } catch {
      setResult({
        status: "error",
        message:
          "Recording could not be confirmed. Start again to check your status.",
      });
    } finally {
      setBusy(false);
    }
  }
  const canEnter =
    !locked && (!result || (result.status === "error" && !!result.challenge));
  return (
    <main className="kiosk-card">
      <p className="eyebrow">{name}</p>
      <strong className="kiosk-time">{fmt(now, { timeStyle: "short" })}</strong>
      <p>
        {fmt(now, { dateStyle: "full" })} · {zone.replaceAll("_", " ")}
      </p>
      <div className="clock-step" aria-live="polite">
        {locked && <p>Too many incorrect PINs. Try again in 10 minutes.</p>}
        {result?.status === "error" && <p role="alert">{result.message}</p>}
        {canEnter ? (
          <form method="post" className="kiosk-form" onSubmit={verify}>
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
              pattern="[0-9]{6}"
              maxLength={6}
              required
              disabled={busy}
            />
            <Button disabled={busy}>{busy ? "Checking…" : "Continue"}</Button>
          </form>
        ) : result?.status === "ready" ? (
          <div className="kiosk-form">
            <h1 className="kiosk-heading">{result.firstName}</h1>
            <p>
              {result.action === "in"
                ? "You are clocked out."
                : "You are currently working."}
            </p>
            <Button disabled={busy} onClick={record}>
              {busy
                ? "Recording…"
                : result.action === "in"
                  ? "Clock In"
                  : "Clock Out"}
            </Button>
            <button disabled={busy} onClick={() => window.location.reload()}>
              Cancel
            </button>
          </div>
        ) : result?.status === "recorded" ? (
          <>
            <h1 className="kiosk-heading">
              Clocked {result.action} at{" "}
              {fmt(result.at, { timeStyle: "short" })}
            </h1>
            <p>Attendance recorded.</p>
          </>
        ) : (
          <Button onClick={() => window.location.reload()}>Start again</Button>
        )}
      </div>
    </main>
  );
}
