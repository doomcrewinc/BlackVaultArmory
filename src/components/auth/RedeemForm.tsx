"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { StandardButton } from "@/components/shared/StandardButton";

const INPUT_CLASS =
  "w-full bg-vault-surface border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint transition-colors";
const LABEL_CLASS = "block text-xs font-medium uppercase tracking-widest text-vault-text-muted mb-1.5";
const PASSWORD_MIN = 12;

/**
 * Redeems an INVITE (create account: username, display name, password) or a RESET (password
 * only) token via POST /api/auth/redeem. Both post to the same endpoint; the server tells them
 * apart by what the token itself is.
 */
export function RedeemForm({ kind, token }: { kind: "INVITE" | "RESET"; token: string }) {
  const isInvite = kind === "INVITE";
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (password.length < PASSWORD_MIN) {
      setError(`Password must be at least ${PASSWORD_MIN} characters`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);
    try {
      const body: Record<string, string> = isInvite ? { token, username, displayName, password } : { token, password };
      const response = await fetch("/api/auth/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 409) {
        setError("That username is taken");
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof data.error === "string" ? data.error : "Something went wrong");
        return;
      }
      window.location.assign(typeof data.next === "string" ? data.next : "/");
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="flex items-center gap-3 bg-[#E53935]/10 border border-[#E53935]/30 rounded-lg px-4 py-3">
          <AlertCircle className="w-4 h-4 text-[#E53935] shrink-0" />
          <p className="text-sm text-[#E53935]">{error}</p>
        </div>
      )}
      {isInvite && (
        <>
          <div>
            <label htmlFor="redeem-username" className={LABEL_CLASS}>
              Username
            </label>
            <input
              id="redeem-username"
              name="username"
              autoComplete="username"
              className={INPUT_CLASS}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="redeem-display-name" className={LABEL_CLASS}>
              Display name
            </label>
            <input
              id="redeem-display-name"
              name="displayName"
              className={INPUT_CLASS}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </div>
        </>
      )}
      <div>
        <label htmlFor="redeem-password" className={LABEL_CLASS}>
          Password
        </label>
        <input
          id="redeem-password"
          name="password"
          type="password"
          autoComplete="new-password"
          className={INPUT_CLASS}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="redeem-confirm-password" className={LABEL_CLASS}>
          Confirm password
        </label>
        <input
          id="redeem-confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          className={INPUT_CLASS}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
        />
      </div>
      <StandardButton
        type="submit"
        variant="primary"
        className="w-full"
        loading={loading}
        loadingLabel={isInvite ? "Creating…" : "Resetting…"}
      >
        {isInvite ? "Create account" : "Reset password"}
      </StandardButton>
    </form>
  );
}
