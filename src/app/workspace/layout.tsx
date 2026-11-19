import { getAccount } from "@/lib/workspace";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await getAccount();
  return children;
}
