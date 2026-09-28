import { AuthCard } from "./AuthCard";

/** Rendered when an invite/reset token is missing, used, expired, or not the expected kind. */
export function LinkExpired() {
  return (
    <AuthCard title="Link expired">
      <p className="text-sm text-vault-text-muted text-center">
        This link has expired or was already used. Ask your admin for a new one.
      </p>
    </AuthCard>
  );
}
