"use client";

import { useEffect, useState } from "react";
import type { IssuedCredentials } from "@/lib/employee-login";

export function useIssuedPassword() {
  const [credentials, setCredentials] = useState<IssuedCredentials | null>(
    null,
  );
  useEffect(() => {
    const clear = () => setCredentials(null);
    const onVisibility = () => {
      if (document.hidden) clear();
    };
    window.addEventListener("pagehide", clear);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", clear);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return {
    showPassword: (value?: IssuedCredentials) =>
      setCredentials(document.hidden ? null : (value ?? null)),
    notice: credentials && (
      <section
        className="panel device-section"
        aria-label="New dashboard credentials"
      >
        <h2>Dashboard credentials</h2>
        <p>{credentials.email}</p>
        <code data-testid="issued-password">{credentials.password}</code>
        <p>
          Give this password to the employee privately. After you leave this
          screen, use Reset dashboard password to issue another.
        </p>
        <button
          type="button"
          className="quiet-link"
          onClick={() => setCredentials(null)}
        >
          Done
        </button>
      </section>
    ),
  };
}
