"use client";

import { useState, type FormEvent } from "react";
import { activateDevice, revokeDevice } from "@/app/workspace/kiosk-actions";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

export type Device = {
  id: string;
  name: string;
  activated_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

export function KioskAdmin({
  org,
  devices,
  zone,
  asOf,
}: {
  org: string;
  devices: Device[];
  zone: string;
  asOf: number;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState("");
  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    setBusy(true);
    setMessage("");
    try {
      const result = await activateDevice(org, name);
      if (result.error) setMessage(result.error);
      else window.location.replace("/kiosk");
    } catch {
      setMessage("Activation could not be confirmed. Check your kiosk list.");
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    setMessage("");
    try {
      const result = await revokeDevice(org, id);
      setMessage(result.error || "Kiosk access revoked.");
    } catch {
      setMessage("Revocation could not be confirmed. Refresh the kiosk list.");
    } finally {
      setBusy(false);
      setConfirm("");
    }
  }
  return (
    <>
      <p className="eyebrow">
        <span className="rule" /> Workplace devices
      </p>
      <h1>Kiosks</h1>
      <p className="lead">
        Activate this browser for staff attendance or revoke a registered kiosk.
      </p>
      <section className="panel device-section">
        <h2>Activate this browser</h2>
        <form method="post" className="kiosk-form" onSubmit={activate}>
          <label>
            Kiosk name
            <Input
              name="name"
              maxLength={80}
              required
              placeholder="Front Counter Tablet"
            />
          </label>
          <small>
            Activation lasts 30 days and signs your staff account out of this
            browser.
          </small>
          <Button disabled={busy}>Activate and sign out</Button>
        </form>
      </section>
      {message && (
        <p className="device-section" role="status">
          {message}
        </p>
      )}
      <section className="panel">
        <div className="section-head">
          <h2>Registered kiosks</h2>
        </div>
        {!devices.length && <p className="empty">No registered kiosks yet.</p>}
        {devices.map((d) => {
          const active =
            !d.revoked_at && d.expires_at && Date.parse(d.expires_at) > asOf;
          const status = d.revoked_at
            ? "Revoked"
            : active
              ? "Active"
              : d.expires_at
                ? "Expired"
                : "Inactive";
          return (
            <div className="directory-row" key={d.id}>
              <div>
                <strong>{d.name}</strong>
                <p>
                  {status}
                  {active &&
                    " · Expires " +
                      new Intl.DateTimeFormat("en-AU", {
                        timeZone: zone,
                        dateStyle: "medium",
                      }).format(new Date(d.expires_at!))}
                </p>
              </div>
              {active &&
                (confirm === d.id ? (
                  <div className="account">
                    <button disabled={busy} onClick={() => revoke(d.id)}>
                      Confirm revocation
                    </button>
                    <button disabled={busy} onClick={() => setConfirm("")}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="quiet-link"
                    disabled={busy}
                    onClick={() => setConfirm(d.id)}
                  >
                    Revoke access
                  </button>
                ))}
            </div>
          );
        })}
      </section>
    </>
  );
}
