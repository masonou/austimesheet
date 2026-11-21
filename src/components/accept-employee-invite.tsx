"use client";

import { useState } from "react";
import {
  acceptInvitation,
  verifyInvitation,
  type Invitation,
} from "@/app/auth/employee-invite/actions";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function AcceptEmployeeInvite({
  claim,
  initial,
}: {
  claim: string;
  initial: Invitation | null;
}) {
  const [details, setDetails] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      method="post"
      className="kiosk-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const fields = new FormData(e.currentTarget);
        setBusy(true);
        setError("");
        try {
          if (details) {
            const r = await acceptInvitation(
              claim,
              String(fields.get("password") ?? ""),
            );
            setError(r.error);
          } else {
            const params = new URLSearchParams(location.hash.slice(1));
            const r = await verifyInvitation(
              claim,
              params.get("token_hash") ?? "",
              params.get("type") ?? "",
            );
            if (r.details) {
              history.replaceState(null, "", location.pathname);
              setDetails(r.details);
            } else setError(r.error ?? "Invitation unavailable.");
          }
        } catch {
          setError(
            "Could not confirm access. Refresh this page to check your invitation.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <p>
        {details
          ? "Join " +
            details.organisation +
            " with " +
            details.email +
            " to view your personal timesheet."
          : "Verify the invitation from your email to continue."}
      </p>
      {details?.needsPassword && (
        <label>
          Choose a password
          <Input
            type="password"
            name="password"
            minLength={8}
            required
            autoComplete="new-password"
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      <Button disabled={busy}>
        {busy
          ? "Checking…"
          : details
            ? "Accept invitation"
            : "Verify invitation"}
      </Button>
    </form>
  );
}
