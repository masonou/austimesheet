"use client";

import { useState } from "react";
import { revokeDevice } from "@/app/workspace/kiosk-actions";

export type Device = {
  id: string;
  name: string;
  activated_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_seen_at: string | null;
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
        To activate a workplace device, open /kiosk on that device and sign in
        there as an administrator.
      </p>
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
                  {d.last_seen_at &&
                    " · Last active " +
                      new Intl.DateTimeFormat("en-AU", {
                        timeZone: zone,
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(d.last_seen_at))}
                  {!d.last_seen_at && " · Awaiting device check-in"}
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
