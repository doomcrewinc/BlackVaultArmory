"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { StandardButton } from "@/components/shared/StandardButton";

const INPUT_CLASS =
  "w-full bg-vault-surface border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint transition-colors";
const LABEL_CLASS = "block text-xs font-medium uppercase tracking-widest text-vault-text-muted mb-1.5";

/**
 * `next` arrives already percent-encoded by Next (read from the /login query as-is) and is
 * sent to the API unchanged — the server sanitises it with safeNextPath. Never decode it here.
 * After a successful sign-in, navigate with window.location.assign to whatever `next` the API
 * hands back (not the one this form sent).
 */
export function LoginForm({ next }: { next: string | null }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, next }),
      });
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("Retry-After") ?? "0") || 0;
        setError(`Too many attempts — try again in ${retryAfter} seconds`);
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof data.error === "string" ? data.error : "Invalid username or password");
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
      <div>
        <label htmlFor="login-username" className={LABEL_CLASS}>
          Username
        </label>
        <input
          id="login-username"
          name="username"
          autoComplete="username"
          className={INPUT_CLASS}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="login-password" className={LABEL_CLASS}>
          Password
        </label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          className={INPUT_CLASS}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <StandardButton
        type="submit"
        variant="primary"
        className="w-full"
        loading={loading}
        loadingLabel="Signing in…"
      >
        Sign in
      </StandardButton>
    </form>
  );
}
