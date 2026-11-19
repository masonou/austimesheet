import Link from "next/link";
import {
  ArrowUpRight,
  Building2,
  CalendarDays,
  FlaskConical,
  LogOut,
  Monitor,
  Users,
} from "lucide-react";
import type { Role } from "@/lib/workspace";
import { signOut } from "@/app/auth-actions";
import { Brand } from "./brand";

export function WorkspaceShell({
  children,
  name,
  role,
  base,
  sample = false,
  directory = false,
  kiosks = false,
}: {
  children: React.ReactNode;
  name: string;
  role: Role;
  base: string;
  sample?: boolean;
  directory?: boolean;
  kiosks?: boolean;
}) {
  return (
    <div className="workspace">
      <header className="topbar">
        <Brand />
        <div className="account">
          {sample ? (
            <>
              <span className="sample-tag">
                <FlaskConical size={14} /> Sample data
              </span>
              <Link href="/">Sign in</Link>
            </>
          ) : (
            <>
              <Link href="/workspace">Workplaces</Link>
              <form action={signOut}>
                <button aria-label="Sign out">
                  <LogOut size={17} />
                  <span>Sign out</span>
                </button>
              </form>
            </>
          )}
        </div>
      </header>
      <div className="work-grid">
        <aside className="sidebar">
          <div className="business">
            <span className="business-icon">
              <Building2 size={20} />
            </span>
            <div>
              <strong>{name}</strong>
              <small>{role === "admin" ? "Administrator" : "Employee"}</small>
            </div>
          </div>
          <nav aria-label="Workspace">
            <Link
              href={base}
              aria-current={!directory && !kiosks ? "page" : undefined}
            >
              <CalendarDays size={18} /> Timesheets
            </Link>
            {role === "admin" && (
              <Link
                href={base + "?view=staff"}
                aria-current={directory ? "page" : undefined}
              >
                <Users size={18} /> Employees
              </Link>
            )}
            <Link
              href={
                role === "admin" && !sample ? base + "?view=kiosks" : "/kiosk"
              }
              aria-current={kiosks ? "page" : undefined}
            >
              <Monitor size={18} />{" "}
              {role === "admin" && !sample ? "Kiosks" : "Workplace kiosk"}
            </Link>
          </nav>
          {sample && (
            <Link
              className="switch-view"
              href={role === "admin" ? "/preview/employee" : "/preview/admin"}
            >
              {role === "admin" ? "Employee preview" : "Admin preview"}
              <ArrowUpRight size={16} />
            </Link>
          )}
        </aside>
        <main className="board">{children}</main>
      </div>
    </div>
  );
}
