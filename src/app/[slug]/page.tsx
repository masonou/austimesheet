import Image from "next/image";
import { KioskScreen } from "@/components/kiosk-clock";

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { expectedHost, restaurantPath } from "@/lib/hosts";
import { restaurant } from "@/lib/kiosk/server";

export default async function Kiosk({ params }: PageProps<"/[slug]">) {
  const { slug } = await params;
  if (!expectedHost(await headers(), "kiosk") || !restaurantPath("/" + slug))
    notFound();
  const workplace = await restaurant(slug);
  if (!workplace) notFound();
  return (
    <div className="kiosk">
      <header className="topbar">
        <span className="brand">
          <Image src="/shiftbook.svg" alt="" width={36} height={36} />
          Shiftbook
        </span>
      </header>
      <main className="kiosk-card">
        <p className="eyebrow">{workplace.name}</p>
        <KioskScreen key={slug} />
      </main>
    </div>
  );
}
