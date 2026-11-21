import Link from "next/link";
import { CalendarDays, Clock3, PanelsTopLeft } from "lucide-react";
import { Brand } from "@/components/brand";
import { LoginForm } from "@/components/login-form";

export default function Home() {
  return (
    <div className="entry">
      <header className="topbar">
        <Brand />
      </header>
      <main className="entry-grid">
        <section className="login-panel">
          <div className="login-inner">
            <p className="eyebrow">
              <span className="rule" /> Staff workspace
            </p>
            <h1>Welcome back.</h1>
            <p className="lead">Sign in to your timesheet workspace.</p>
            <LoginForm />
            <div className="preview-link">
              <Link href="/preview/admin">
                <PanelsTopLeft size={17} /> Explore the sample workspace
              </Link>
            </div>
          </div>
        </section>
        <section className="folio" aria-label="Sample weekly timesheet">
          <div className="folio-head">
            <span className="eyebrow">Shiftbook / Weekly record</span>
            <span className="folio-tag">Sample data</span>
          </div>
          <div className="folio-title">
            The weekly
            <br />
            <em>timesheet.</em>
          </div>
          <div className="paper">
            <div className="paper-top">
              <span>
                <CalendarDays size={17} />
                16–22 Nov 2026
              </span>
              <span>W47</span>
            </div>
            <div className="paper-person">
              <span className="avatar">AL</span>
              <div>
                <strong>Alex Lee</strong>
                <small>Work sessions</small>
              </div>
            </div>
            {[
              ["Mon 16", "07:00 – 13:00", "6h"],
              ["Tue 17", "08:00 – 15:30", "7h 30m"],
              ["Thu 19", "11:00 – 16:00", "5h"],
            ].map(([day, time, hours]) => (
              <div className="paper-row" key={day}>
                <b>{day}</b>
                <span>{time}</span>
                <strong>{hours}</strong>
              </div>
            ))}
            <div className="paper-total">
              <span>
                <Clock3 size={16} /> Weekly total
              </span>
              <strong>18h 30m</strong>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
