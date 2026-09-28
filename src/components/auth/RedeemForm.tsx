"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { StandardButton } from "@/components/shared/StandardButton";
import { INPUT_CLASS, LABEL_CLASS } from "./form-styles";
import { PasswordFields } from "./PasswordFields";
import { checkNewPassword } from "./checkNewPassword";

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

    const passwordError = checkNewPassword(password, confirmPassword);
    if (passwordError) {
      setError(passwordError);
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
      <PasswordFields
        idPrefix="redeem"
        password={password}
        confirmPassword={confirmPassword}
        onPasswordChange={setPassword}
        onConfirmPasswordChange={setConfirmPassword}
      />
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
