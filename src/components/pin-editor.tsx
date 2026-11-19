"use client";

import { useEffect, useState, type FormEvent } from "react";
import { assignPin } from "@/app/workspace/kiosk-actions";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

export function PinEditor({
  org,
  employee,
  name,
}: {
  org: string;
  employee: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState("");
  useEffect(() => {
    if (!issued) return;
    const hide = window.setTimeout(() => {
      setIssued("");
      setOpen(false);
    }, 45000);
    return () => window.clearTimeout(hide);
  }, [issued]);
  const close = () => {
    setIssued("");
    setError("");
    setOpen(false);
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const pin = manual ? String(new FormData(form).get("pin") ?? "") : null;
    form.reset();
    setBusy(true);
    setError("");
    try {
      const result = await assignPin(org, employee, pin);
      if (result.pin) setIssued(result.pin);
      else setError(result.error ?? "PIN assignment failed.");
    } catch {
      setError(
        "The result could not be confirmed. Reset the PIN before sharing it.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <button
        className="quiet-link"
        onClick={() => setOpen(true)}
        aria-label={"Manage PIN for " + name}
      >
        Manage PIN
      </button>
    );
  return (
    <div className="pin-editor">
      {issued ? (
        <div role="status">
          <p>New PIN for {name}</p>
          <strong className="issued-pin">{issued}</strong>
          <p>Share privately. It will disappear in 45 seconds.</p>
          <button className="quiet-link" onClick={close}>
            Hide PIN
          </button>
        </div>
      ) : (
        <form method="post" onSubmit={submit} className="kiosk-form">
          <label>
            New PIN for {name}
            <select
              value={manual ? "manual" : "random"}
              disabled={busy}
              onChange={(e) => setManual(e.target.value === "manual")}
            >
              <option value="random">Generate randomly</option>
              <option value="manual">Choose six digits</option>
            </select>
          </label>
          {manual && (
            <Input
              aria-label="New six-digit PIN"
              name="pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="off"
              required
            />
          )}
          <small>Saving replaces any existing PIN.</small>
          {error && <p role="alert">{error}</p>}
          <div className="account">
            <Button disabled={busy}>{busy ? "Saving…" : "Save new PIN"}</Button>
            <button type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
