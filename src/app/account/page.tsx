"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { LogOut } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { SectionCard } from "@/components/shared/SectionCard";
import { FormField, INPUT_CLASS } from "@/components/shared/FormField";
import { StandardButton } from "@/components/shared/StandardButton";
import { StatusMessage } from "@/components/shared/StatusMessage";
import { LoadingState } from "@/components/shared/LoadingState";
import { PasswordFields } from "@/components/auth/PasswordFields";
import { checkNewPassword } from "@/components/auth/checkNewPassword";
import { formatTimestamp } from "@/lib/date";

type SessionRow = {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
};

/**
 * A short, human summary of a stored user-agent string — not a device fingerprint, just
 * enough to tell "this laptop" from "my phone" apart in a session list.
 */
export function summarizeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";

  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isMac = /Macintosh/.test(ua);
  const isWindows = /Windows/.test(ua);
  const isLinux = /Linux/.test(ua) && !isAndroid;

  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua)) browser = "Opera";
  else if (/CriOS\//.test(ua) || (/Chrome\//.test(ua) && !/Chromium/.test(ua))) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";

  let os = "Unknown OS";
  if (isIOS) os = "iOS";
  else if (isAndroid) os = "Android";
  else if (isMac) os = "macOS";
  else if (isWindows) os = "Windows";
  else if (isLinux) os = "Linux";

  return `${browser} on ${os}`;
}

export default function AccountPage() {
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<"ADMIN" | "USER" | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSuccess, setNameSuccess] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [endingId, setEndingId] = useState<string | null>(null);
  const [endSessionError, setEndSessionError] = useState<string | null>(null);
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const [logoutAllError, setLogoutAllError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/account")
      .then((r) => r.json())
      .then((data) => {
        setDisplayName(typeof data.displayName === "string" ? data.displayName : "");
        setRole(data.role === "ADMIN" || data.role === "USER" ? data.role : null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/account/sessions")
      .then((r) => r.json())
      .then((data) => setSessions(data.sessions ?? []))
      .catch(() => setSessionsError("Failed to load sessions."))
      .finally(() => setSessionsLoading(false));
  }, []);

  async function handleSaveName(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setNameError(null);
    setNameSuccess(false);
    setNameSaving(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNameError(typeof data.error === "string" ? data.error : "Could not save");
        return;
      }
      if (typeof data.displayName === "string") setDisplayName(data.displayName);
      setNameSuccess(true);
      setTimeout(() => setNameSuccess(false), 3000);
    } catch {
      setNameError("Could not save");
    } finally {
      setNameSaving(false);
    }
  }

  async function handleChangePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);
    const validationError = checkNewPassword(newPassword, confirmPassword);
    if (validationError) {
      setPasswordError(validationError);
      return;
    }
    setPasswordSaving(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPasswordError(typeof data.error === "string" ? data.error : "Could not change password");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordSuccess(true);
      setTimeout(() => setPasswordSuccess(false), 3000);
    } catch {
      setPasswordError("Could not change password");
    } finally {
      setPasswordSaving(false);
    }
  }

  async function handleEndSession(id: string, isCurrent: boolean) {
    setEndingId(id);
    setEndSessionError(null);
    try {
      const res = await fetch(`/api/account/sessions/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setEndSessionError("Could not end that session. Try again.");
        return;
      }
      if (isCurrent) {
        window.location.assign("/login");
        return;
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch {
      setEndSessionError("Could not end that session. Try again.");
    } finally {
      setEndingId(null);
    }
  }

  async function handleLogoutEverywhere() {
    setLoggingOutAll(true);
    setLogoutAllError(null);
    try {
      const res = await fetch("/api/auth/logout?all=1", { method: "POST" });
      // A 401 here means there were no sessions to end anyway — /login is still the
      // right place to land. Anything else (a real server error, a network failure)
      // is a genuine failure: stay put and say so.
      if (res.ok || res.status === 401) {
        window.location.assign("/login");
        return;
      }
      setLogoutAllError("Could not log out everywhere. Try again.");
    } catch {
      setLogoutAllError("Could not log out everywhere. Try again.");
    } finally {
      setLoggingOutAll(false);
    }
  }

  if (loading) return <LoadingState label="Loading account…" />;

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6 sm:px-6">
      <PageHeader title="Your account" subtitle={role === "ADMIN" ? "Administrator" : "Member"} />

      <SectionCard title="Display name">
        <form onSubmit={handleSaveName} className="space-y-3">
          {nameError && <StatusMessage tone="error" message={nameError} />}
          {nameSuccess && <StatusMessage tone="success" message="Saved" />}
          <FormField label="Display name">
            <input
              className={INPUT_CLASS}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={64}
              required
            />
          </FormField>
          <StandardButton type="submit" variant="primary" loading={nameSaving} loadingLabel="Saving…">
            Save
          </StandardButton>
        </form>
      </SectionCard>

      <SectionCard title="Change password">
        <form onSubmit={handleChangePassword} className="space-y-3">
          {passwordError && <StatusMessage tone="error" message={passwordError} />}
          {passwordSuccess && <StatusMessage tone="success" message="Password changed" />}
          <FormField label="Current password">
            <input
              type="password"
              autoComplete="current-password"
              className={INPUT_CLASS}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </FormField>
          <PasswordFields
            idPrefix="account"
            password={newPassword}
            confirmPassword={confirmPassword}
            onPasswordChange={setNewPassword}
            onConfirmPasswordChange={setConfirmPassword}
          />
          <StandardButton type="submit" variant="primary" loading={passwordSaving} loadingLabel="Changing…">
            Change password
          </StandardButton>
        </form>
      </SectionCard>

      <SectionCard
        title="Your sessions"
        actions={
          <StandardButton
            type="button"
            variant="danger"
            icon={<LogOut className="h-4 w-4" />}
            loading={loggingOutAll}
            loadingLabel="Logging out…"
            onClick={handleLogoutEverywhere}
          >
            Log out everywhere
          </StandardButton>
        }
      >
        {sessionsError && <StatusMessage tone="error" message={sessionsError} />}
        {logoutAllError && <StatusMessage tone="error" message={logoutAllError} />}
        {endSessionError && <StatusMessage tone="error" message={endSessionError} />}
        {sessionsLoading ? (
          <p className="text-sm text-vault-text-muted">Loading…</p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-md border border-vault-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-sm text-vault-text">
                    {summarizeUserAgent(s.userAgent)}
                    {s.current && (
                      <span className="rounded-full border border-[#00C2FF]/30 bg-[#00C2FF]/10 px-2 py-0.5 text-[10px] text-[#00C2FF]">
                        This device
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-vault-text-faint">Last seen {formatTimestamp(s.lastSeenAt)}</p>
                </div>
                <StandardButton
                  type="button"
                  variant="ghost"
                  loading={endingId === s.id}
                  loadingLabel="Ending…"
                  onClick={() => handleEndSession(s.id, s.current)}
                >
                  End
                </StandardButton>
              </li>
            ))}
            {sessions.length === 0 && <p className="text-sm text-vault-text-muted">No active sessions.</p>}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
