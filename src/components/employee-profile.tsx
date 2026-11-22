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

import type { IssuedCredentials } from "@/lib/employee-login";
import { useIssuedPassword } from "./issued-password";
import { PinChoice } from "./pin-choice";
import {
  manageLogin,
  setEmployeeActive,
} from "@/app/workspace/employee-actions";

type Profile = {
  accountStatus: string;
  canManageLogin: boolean;
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
  const { showPassword, notice } = useIssuedPassword();
  const [editor, setEditor] = useState<
    "name" | "pin" | "login" | "reset" | "status" | null
  >(null);
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
    showPassword();
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
      const r: { error?: string; credentials?: IssuedCredentials } =
        editor === "name"
          ? await renameEmployee(org, p.id, String(fields.get("name") ?? ""))
          : editor === "login" || editor === "reset"
            ? await manageLogin(
                org,
                p.id,
                editor === "reset"
                  ? "reset"
                  : p.accountStatus === "Linked"
                    ? "email"
                    : "enable",
                String(fields.get("email") ?? ""),
              )
            : editor === "status"
              ? await setEmployeeActive(org, p.id, !p.active)
              : await assignPin(
                  org,
                  p.id,
                  manual ? String(fields.get("pin") ?? "") : null,
                );
      if (r.error) setMessage(r.error);
      else {
        showPassword(r.credentials);
        form.reset();
        setEditor(null);
        setMessage(
          editor === "pin"
            ? "PIN saved. Use Reveal PIN to view it."
            : editor === "login" || editor === "reset"
              ? "Dashboard login updated."
              : editor === "status"
                ? "Employee status updated."
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
            <p>{p.email || "Unassigned"}</p>
          </div>
        </div>
        <div className="profile-line">
          <div>
            <small>Dashboard account</small>
            <p>{p.accountStatus}</p>
          </div>
          {p.active && p.canManageLogin && (
            <div className="account">
              <button
                className="quiet-link"
                disabled={busy}
                onClick={() => edit("login")}
              >
                {p.accountStatus === "Kiosk only"
                  ? "Enable dashboard access"
                  : "Change login email"}
              </button>
              {p.accountStatus === "Linked" && (
                <button
                  className="quiet-link"
                  disabled={busy}
                  onClick={() => edit("reset")}
                >
                  Reset dashboard password
                </button>
              )}
            </div>
          )}
        </div>
        {notice}
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
        <div className="profile-line">
          <Link
            className="quiet-link"
            href={"/workspace/" + org + "/admin?employee=" + p.id}
          >
            View timesheets
          </Link>
          <button
            className="quiet-link"
            disabled={busy}
            onClick={() => edit("status")}
          >
            {p.active ? "Deactivate employee" : "Reactivate employee"}
          </button>
        </div>
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
            ) : editor === "pin" ? (
              <PinChoice manual={manual} onChange={setManual} />
            ) : editor === "reset" ? (
              <p>
                Replace the dashboard password for {p.email}? The new password
                will be shown once.
              </p>
            ) : editor === "login" ? (
              <label>
                Dashboard login email
                <Input
                  name="email"
                  type="email"
                  maxLength={254}
                  defaultValue={p.email ?? ""}
                  required
                />
              </label>
            ) : (
              <p>
                {p.active
                  ? "Deactivate this employee? Kiosk attendance and employee dashboard access will stop. Historical timesheets are retained."
                  : "Reactivate this employee for workplace attendance and any linked employee dashboard access?"}
              </p>
            )}
            <div className="account">
              <Button disabled={busy}>
                {editor === "name"
                  ? "Save name"
                  : editor === "reset"
                    ? "Confirm password reset"
                    : editor === "login"
                      ? "Save login email"
                      : editor === "status"
                        ? "Confirm status change"
                        : "Save new PIN"}
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
