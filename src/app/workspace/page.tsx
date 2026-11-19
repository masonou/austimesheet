import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { signOut } from "@/app/auth-actions";
import { getAccount } from "@/lib/workspace";

export default async function Workplaces() {
  const { memberships } = await getAccount();
  const path = (m: (typeof memberships)[number]) =>
    "/workspace/" + m.organisations.id + "/" + m.role;
  if (memberships.length === 1) redirect(path(memberships[0]));
  return (
    <>
      <header className="topbar">
        <Brand />
        <form action={signOut}>
          <button>Sign out</button>
        </form>
      </header>
      <main className="single">
        <p className="eyebrow">Staff workspace</p>
        <h1>Your workplaces</h1>
        {memberships.length ? (
          memberships.map((m) => (
            <Link
              className="workplace-link"
              href={path(m)}
              key={m.organisations.id}
            >
              <strong>{m.organisations.name}</strong>
              <span>{m.role}</span>
            </Link>
          ))
        ) : (
          <p className="lead">
            Your account has no active workplace access. Ask your administrator
            to link your account.
          </p>
        )}
      </main>
    </>
  );
}
