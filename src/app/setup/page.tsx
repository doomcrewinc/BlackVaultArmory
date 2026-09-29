import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AuthCard } from "@/components/auth/AuthCard";
import { SetupForm } from "@/components/auth/SetupForm";

// Decided per request: a build-time prerender would freeze whatever the user count was then.
export const dynamic = "force-dynamic";

/**
 * Spec: once any admin exists, /setup returns 404. Signed-in visitors never get here (the proxy
 * sends them to /); this covers signed-out visitors. An exact count, not the cached
 * hasAnyUser(), whose 5-second negative cache could still render the form just after setup.
 */
export default async function SetupPage() {
  if ((await prisma.user.count()) > 0) notFound();
  return (
    <AuthCard title="Set up BlackVault" subtitle="Create the first admin account">
      <SetupForm />
    </AuthCard>
  );
}
