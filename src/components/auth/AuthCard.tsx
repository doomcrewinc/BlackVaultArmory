import { Shield } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Shared centered card for every auth page (/setup, /login, /invite/[token],
 * /reset/[token]). No app chrome around it — the root layout renders these
 * pages with no Sidebar/MobileHeader/GlobalSearch/ThemeToggle at all.
 */
export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-sm bg-vault-surface border border-vault-border rounded-lg p-6 space-y-5">
        <div className="flex items-center justify-center gap-2">
          <div className="w-8 h-8 rounded bg-[#00C2FF]/10 border border-[#00C2FF]/30 flex items-center justify-center">
            <Shield className="w-4 h-4 text-[#00C2FF]" />
          </div>
          <p className="text-xs font-bold text-vault-text tracking-widest uppercase">BlackVault</p>
        </div>
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-semibold text-vault-text">{title}</h1>
          {subtitle && <p className="text-sm text-vault-text-muted">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}
