import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Shiftbook · Staff timesheets",
    template: "%s · Shiftbook",
  },
  description: "The timesheet workspace for Australian hospitality teams.",
  icons: { icon: "/shiftbook.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}
