import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { getCurrentUser } from "@/lib/server/auth";
import { listAdmins } from "@/lib/auth/admins";

/**
 * proxy.ts rewrites here (with a 403 status) when a plain USER opens an admin-only page
 * (auth-gate.ts, Rule 4). Reached only for a signed-in user — decideAuth already requires
 * a session for any non-public path before the admin check runs.
 */
export default async function AdminsOnlyPage() {
  const user = await getCurrentUser();
  const admins = await listAdmins();

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6 rounded-lg border border-vault-border bg-vault-surface p-6 text-center sm:p-8">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-[#E53935]/30 bg-[#E53935]/10 ring-4 ring-[#E53935]/10">
          <ShieldAlert className="h-6 w-6 text-[#E53935]" />
        </div>

        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold text-vault-text">Restricted — admins only</h1>
          <p className="text-sm text-vault-text-muted">
            You&rsquo;re signed in as{" "}
            <strong className="font-semibold text-vault-text">{user?.displayName ?? "you"}</strong>. This area is
            for administrators.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-vault-text-faint">Ask an admin</p>
          <div className="flex flex-wrap justify-center gap-2">
            {admins.map((admin, index) => (
              <span
                key={`${admin.displayName}-${index}`}
                className="rounded-full border border-vault-border bg-vault-surface-2 px-3 py-1 text-xs text-vault-text-muted"
              >
                {admin.displayName}
              </span>
            ))}
          </div>
        </div>

        <Link
          href="/"
          className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-[#00C2FF]/35 bg-[#00C2FF]/12 px-4 py-2.5 text-sm font-medium text-[#00C2FF] transition-colors hover:bg-[#00C2FF]/20 focus:outline-none focus:ring-2 focus:ring-[#00C2FF]/50"
        >
          Back to Command Center
        </Link>
      </div>
    </div>
  );
}
