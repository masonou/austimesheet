import Link from "next/link";
import { LockKeyhole, Monitor } from "lucide-react";
import { Brand } from "@/components/brand";
import { KioskClock } from "@/components/kiosk-clock";
import { currentKiosk, deviceDigest } from "@/lib/kiosk/server";

export default async function Kiosk() {
  const digest = await deviceDigest();
  let context = null;
  let unavailable = false;
  if (digest) {
    try {
      context = await currentKiosk(digest);
    } catch {
      unavailable = true;
    }
  }
  return (
    <div className="kiosk">
      <header className="topbar">
        <Brand />
        <Link className="quiet-link" href="/">
          Staff sign in
        </Link>
      </header>
      {context ? (
        <KioskClock
          name={context.name}
          zone={context.zone}
          initialTime={new Date().toISOString()}
          initialChallenge={context.challenge}
          locked={!!context.locked}
        />
      ) : (
        <main className="kiosk-card">
          <span className="device">
            <Monitor size={40} />
          </span>
          <p className="eyebrow">Workplace kiosk</p>
          <h1>{unavailable ? "Kiosk unavailable" : "Kiosk is locked"}</h1>
          <p className="lead">
            {unavailable
              ? "Check the connection and reload this page."
              : "Ask an administrator to activate this browser from the Kiosks section of your workplace."}
          </p>
          <span className="locked">
            <LockKeyhole size={17} /> Clocking unavailable
          </span>
        </main>
      )}
    </div>
  );
}
