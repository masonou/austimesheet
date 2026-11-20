import Image from "next/image";
import { KioskScreen } from "@/components/kiosk-clock";

export default function Kiosk() {
  return (
    <div className="kiosk">
      <header className="topbar">
        <span className="brand">
          <Image src="/shiftbook.svg" alt="" width={36} height={36} />
          Shiftbook
        </span>
      </header>
      <main className="kiosk-card">
        <KioskScreen />
      </main>
    </div>
  );
}
