import Link from "next/link";
import { LockKeyhole, Monitor } from "lucide-react";
import { Brand } from "@/components/brand";

export default function Kiosk() {
  return (
    <div className="kiosk">
      <header className="topbar">
        <Brand />
        <Link className="quiet-link" href="/">
          Staff sign in
        </Link>
      </header>
      <main className="kiosk-card">
        <span className="device">
          <Monitor size={40} />
        </span>
        <p className="eyebrow">Workplace kiosk</p>
        <h1>Kiosk is locked</h1>
        <p className="lead">
          Device activation and PIN clocking will be available in a later phase.
          This preview cannot record attendance.
        </p>
        <span className="locked">
          <LockKeyhole size={17} /> Clocking unavailable
        </span>
      </main>
    </div>
  );
}
