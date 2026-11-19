"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="single">
      <p className="eyebrow">Shiftbook</p>
      <h1>Workspace unavailable</h1>
      <p className="lead">Try again or contact your workplace administrator.</p>
      <div className="error-actions">
        <button className="button" onClick={reset}>
          Try again
        </button>
        <Link href="/">Back to sign in</Link>
      </div>
    </main>
  );
}
