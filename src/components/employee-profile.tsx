"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  assignPin,
  revealPin,
  renameEmployee,
} from "@/app/workspace/kiosk-actions";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

type Profile = {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  pinStatus: "legacy" | "assigned" | "none";
};
export function EmployeeProfile({
  org,
  profile: p,
}: {
  org: string;
  profile: Profile;
}) {
  const [editor, setEditor] = useState<"name" | "pin" | null>(null);
  const [pin, setPin] = useState("");
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!pin) return;
    const hide = () => setPin("");
    const timer = setTimeout(hide, 30000);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", hide);
    };
  }, [pin]);
  const edit = (which: typeof editor) => {
    setPin("");
    setEditor(which);
    setMessage("");
  };
  async function reveal() {
    if (pin) {
      setPin("");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const r = await revealPin(org, p.id);
      if (r.pin && !document.hidden) setPin(r.pin);
      else setMessage(r.error ?? "PIN hidden.");
    } catch {
      setMessage("Unable to reveal PIN.");
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      fields = new FormData(form);
    setBusy(true);
    setPin("");
    setMessage("");
    try {
      const r =
        editor === "name"
          ? await renameEmployee(org, p.id, String(fields.get("name") ?? ""))
          : await assignPin(
              org,
              p.id,
              manual ? String(fields.get("pin") ?? "") : null,
            );
      if (r.error) setMessage(r.error);
      else {
        form.reset();
        setEditor(null);
        setMessage(
          editor === "pin"
            ? "PIN saved. Use Reveal PIN to view it."
            : "Name saved.",
        );
      }
    } catch {
      setMessage(
        "Save could not be confirmed. Refresh the profile before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link
        className="quiet-link"
        href={"/workspace/" + org + "/admin?view=staff"}
      >
        Back to employees
      </Link>
      <h1>{p.name}</h1>
      <section className="panel device-section profile-panel">
        <div className="section-head">
          <h2>Employee profile</h2>
          <span className={"status " + (p.active ? "reviewed" : "archived")}>
            {p.active ? "Active" : "Inactive"}
          </span>
        </div>
        <div className="profile-line">
          <div>
            <small>Name</small>
            <p>{p.name}</p>
          </div>
          <button
            className="quiet-link"
            disabled={busy}
            onClick={() => edit("name")}
          >
            Edit name
          </button>
        </div>
        <div className="profile-line">
          <div>
            <small>Login email</small>
            <p>{p.email || "No linked email"}</p>
          </div>
        </div>
        <div className="profile-line">
          <div>
            <small>Assigned PIN</small>
            <p
              className={p.pinStatus === "assigned" ? "issued-pin" : undefined}
            >
              {p.pinStatus === "assigned"
                ? pin || "••••••"
                : p.pinStatus === "legacy"
                  ? "Reset required"
                  : "No PIN assigned"}
            </p>
          </div>
          <div className="account">
            {p.pinStatus === "assigned" && (
              <button disabled={busy} className="quiet-link" onClick={reveal}>
                {pin ? "Hide PIN" : "Reveal PIN"}
              </button>
            )}
            {p.active && (
              <button
                className="quiet-link"
                disabled={busy}
                onClick={() => edit("pin")}
              >
                {p.pinStatus === "none" ? "Assign PIN" : "Change PIN"}
              </button>
            )}
          </div>
        </div>
        {p.pinStatus === "legacy" && (
          <p>
            The existing PIN works for attendance. Reassign it to enable reveal.
          </p>
        )}
        {editor && (
          <form className="kiosk-form" method="post" onSubmit={save}>
            {editor === "name" ? (
              <label>
                Employee name
                <Input
                  name="name"
                  defaultValue={p.name}
                  maxLength={120}
                  required
                />
              </label>
            ) : (
              <>
                <label>
                  New PIN
                  <select
                    value={manual ? "manual" : "random"}
                    onChange={(e) => setManual(e.target.value === "manual")}
                  >
                    <option value="random">Generate randomly</option>
                    <option value="manual">Choose six digits</option>
                  </select>
                </label>
                {manual && (
                  <Input
                    name="pin"
                    aria-label="New six-digit PIN"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                  />
                )}
              </>
            )}
            <div className="account">
              <Button disabled={busy}>
                {editor === "name" ? "Save name" : "Save new PIN"}
              </Button>
              <button type="button" disabled={busy} onClick={() => edit(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {message && <p role="status">{message}</p>}
      </section>
    </>
  );
}
