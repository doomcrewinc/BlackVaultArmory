"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { StandardButton } from "@/components/shared/StandardButton";

const INPUT_CLASS =
  "w-full bg-vault-surface border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint transition-colors";
const LABEL_CLASS = "block text-xs font-medium uppercase tracking-widest text-vault-text-muted mb-1.5";
const PASSWORD_MIN = 12;

/** Creates the first ADMIN with the one-time setup code printed at container startup. */
export function SetupForm() {
  const [setupCode, setSetupCode] = useState("");
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
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setupCode, username, displayName, password }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(typeof data.error === "string" ? data.error : "Something went wrong");
        return;
      }
      window.location.assign("/");
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
      <div>
        <label htmlFor="setup-code" className={LABEL_CLASS}>
          Setup code
        </label>
        <input
          id="setup-code"
          name="setupCode"
          className={INPUT_CLASS}
          value={setupCode}
          onChange={(e) => setSetupCode(e.target.value)}
          required
        />
        <p className="mt-1.5 text-xs text-vault-text-faint">
          Printed in the container log:{" "}
          <code className="text-vault-text-muted">
            docker compose logs blackvault | grep &quot;Setup token&quot;
          </code>
        </p>
      </div>
      <div>
        <label htmlFor="setup-username" className={LABEL_CLASS}>
          Username
        </label>
        <input
          id="setup-username"
          name="username"
          autoComplete="username"
          className={INPUT_CLASS}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="setup-display-name" className={LABEL_CLASS}>
          Display name
        </label>
        <input
          id="setup-display-name"
          name="displayName"
          className={INPUT_CLASS}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="setup-password" className={LABEL_CLASS}>
          Password
        </label>
        <input
          id="setup-password"
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
        <label htmlFor="setup-confirm-password" className={LABEL_CLASS}>
          Confirm password
        </label>
        <input
          id="setup-confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          className={INPUT_CLASS}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
        />
      </div>
      <StandardButton type="submit" variant="primary" className="w-full" loading={loading} loadingLabel="Creating…">
        Create admin account
      </StandardButton>
    </form>
  );
}
