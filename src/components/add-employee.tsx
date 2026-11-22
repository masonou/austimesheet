"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createEmployee } from "@/app/workspace/employee-actions";
import { useIssuedPassword } from "./issued-password";
import { PinChoice } from "./pin-choice";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function AddEmployee({ org }: { org: string }) {
  const { showPassword, notice } = useIssuedPassword();
  const dialog = useRef<HTMLDialogElement>(null);
  const [id, setId] = useState(""),
    [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [added, setAdded] = useState<{ id: string; message: string } | null>(null);
  useEffect(() => {
    if (id) dialog.current?.showModal();
  }, [id]);
  return (
    <>
      <Button
        onClick={() => {
          setError("");
          setManual(false);
          setAdded(null);
          showPassword();
          setId(crypto.randomUUID());
        }}
      >
        Add Employee
      </Button>
      {added && (
        <p role="status">
          {added.message}{" "}
          <Link
            className="quiet-link"
            href={"/workspace/" + org + "/admin?view=staff&person=" + added.id}
          >
            Open profile
          </Link>
        </p>
      )}
      {notice}
      {id && (
        <dialog
          className="shift-dialog"
          ref={dialog}
          aria-labelledby="add-employee-title"
          onCancel={(e) => {
            e.preventDefault();
            if (!busy) setId("");
          }}
        >
          <h2 id="add-employee-title">Add Employee</h2>
          <form
            method="post"
            className="shift-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              const fields = new FormData(e.currentTarget);
              setBusy(true);
              setError("");
              try {
                const r = await createEmployee(org, id, fields);
                if (r.message) {
                  showPassword(r.credentials);
                  setAdded({ id, message: r.message });
                  setId("");
                } else
                  setError(r.error ?? "Check the directory before retrying.");
              } catch {
                setError(
                  "Save could not be confirmed. Check the directory before retrying.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Full name
              <Input name="name" maxLength={120} required autoComplete="off" />
            </label>
            <label>
              Login email (optional)
              <Input
                name="email"
                type="email"
                maxLength={254}
                autoComplete="off"
              />
            </label>
            <small>
              Add an email to generate a separate dashboard password.
            </small>
            <PinChoice manual={manual} onChange={setManual} />
            {error && <p role="alert">{error}</p>}
            <div className="shift-controls">
              <Button disabled={busy}>Save employee</Button>
              <button type="button" disabled={busy} onClick={() => setId("")}>
                Cancel
              </button>
            </div>
          </form>
        </dialog>
      )}
    </>
  );
}
