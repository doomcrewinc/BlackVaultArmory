"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Archive } from "lucide-react";
import { FormField, INPUT_CLASS } from "@/components/shared/FormField";
import { StandardButton } from "@/components/shared/StandardButton";
import { StatusMessage } from "@/components/shared/StatusMessage";

/** The floor the server enforces (core.mjs's MIN_PASSPHRASE) — checked here for an instant inline error. */
const MIN_PASSPHRASE_LENGTH = 12;
const POLL_MS = 1000;
/** Consecutive unreadable status responses after which polling stops and the user is told. */
const MAX_POLL_FAILURES = 5;

/** Mirrors FullBackupStatus in src/lib/backup/full-job.ts (a server module, so not imported into a client component). */
export interface FullBackupStatusDto {
  jobId?: string;
  state: "idle" | "running" | "succeeded" | "failed";
  phase?: "writing" | "verifying";
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  file?: string;
  files?: number;
  bytes?: number;
  skipped?: Array<{ path: string; reason: string; kind: "vanished" | "unreadable" }>;
  warnings?: string[];
  error?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const PHASE_LABEL = { writing: "Writing the archive", verifying: "Verifying the archive" } as const;

/**
 * The engine's byte counters change unit between phases (on-disk encrypted
 * sizes while writing, plaintext while verifying), so each phase gets its own
 * bar: inside a phase it never moves backwards, and at the switch it restarts
 * under a new label instead of pretending to be one continuous bar.
 */
function phaseProgress(s: FullBackupStatusDto): { pct: number | null; detail: string } {
  const filesDetail = s.filesTotal > 0 ? `${s.filesDone} of ${s.filesTotal} files` : "no files";
  if (s.phase === undefined) return { pct: null, detail: "Starting..." };
  if (s.bytesTotal > 0) return { pct: Math.min(100, Math.round((s.bytesDone / s.bytesTotal) * 100)), detail: filesDetail };
  if (s.filesTotal > 0) return { pct: Math.min(100, Math.round((s.filesDone / s.filesTotal) * 100)), detail: filesDetail };
  return { pct: null, detail: filesDetail };
}

export function FullBackupPanel({ isAdmin }: { isAdmin: boolean }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<FullBackupStatusDto | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const lastState = useRef<FullBackupStatusDto["state"] | null>(null);
  const failures = useRef(0);
  const [statusUnreadable, setStatusUnreadable] = useState(false);

  const stopPolling = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/backup/full/status", { cache: "no-store" });
      if (!res.ok) return null;
      const next = (await res.json()) as FullBackupStatusDto;
      lastState.current = next.state;
      failures.current = 0;
      if (alive.current) {
        setStatus(next);
        setStatusUnreadable(false);
      }
      return next;
    } catch {
      return null;
    }
  }, []);

  // Poll while a job is running; stop as soon as it is not.
  const poll = useCallback(() => {
    stopPolling();
    timer.current = setTimeout(async () => {
      const next = await refresh();
      if (!alive.current) return;
      if (next) {
        if (next.state === "running") poll();
        return;
      }
      // Unreadable (expired session, server down): retry only while the last known state was
      // "running", and give up after a few in a row, saying so.
      failures.current += 1;
      if (lastState.current !== "running") return;
      if (failures.current >= MAX_POLL_FAILURES) setStatusUnreadable(true);
      else poll();
    }, POLL_MS);
  }, [refresh, stopPolling]);

  // On load, pick up a job that is already running (or the last result).
  useEffect(() => {
    alive.current = true;
    if (isAdmin) {
      void refresh().then((s) => {
        if (alive.current && s?.state === "running") poll();
      });
    }
    return () => {
      alive.current = false;
      stopPolling();
    };
  }, [isAdmin, refresh, poll, stopPolling]);

  const running = status?.state === "running";

  async function handleStart() {
    if (Array.from(passphrase.normalize("NFC")).length < MIN_PASSPHRASE_LENGTH) {
      setFormError(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      return;
    }
    if (passphrase !== confirm) {
      setFormError("Passphrases do not match.");
      return;
    }
    setFormError(null);
    setSubmitting(true);
    const body = JSON.stringify({ passphrase });
    // The passphrase lives in the form only until it is sent.
    setPassphrase("");
    setConfirm("");
    try {
      const res = await fetch("/api/backup/full", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.status === 202) {
        // Show "starting" at once; the first poll brings the real counters.
        lastState.current = "running";
        failures.current = 0;
        if (alive.current) setStatus({ state: "running", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
        poll();
        return;
      }
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setFormError(json.error ?? "Could not start the backup.");
      if (res.status === 409) {
        // Someone else's job is running: show it.
        const next = await refresh();
        if (alive.current && next?.state === "running") poll();
      }
    } catch {
      setFormError("Network error. Could not reach the backup endpoint.");
    } finally {
      if (alive.current) setSubmitting(false);
    }
  }

  const progress = running && status ? phaseProgress(status) : null;
  const unreadable = status?.skipped?.filter((x) => x.kind === "unreadable") ?? [];
  const vanished = status?.skipped?.filter((x) => x.kind === "vanished") ?? [];

  return (
    <div className="rounded-lg border border-vault-border bg-vault-bg p-4 flex flex-col gap-3" data-testid="full-backup-panel">
      <div>
        <p className="text-sm font-medium text-vault-text">Full Backup (database + files)</p>
        <p className="mt-0.5 text-xs text-vault-text-muted">
          Backs up the database and every uploaded image and document into one archive, sealed with a passphrase only you
          know. The file is saved in the server&apos;s backup folder (not downloaded) and nothing is ever deleted. It keeps
          running if you close this page. Restore is done from the command line with the app stopped.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Passphrase" hint={`At least ${MIN_PASSPHRASE_LENGTH} characters.`}>
          <input
            id="fullBackupPassphrase"
            type="password"
            autoComplete="new-password"
            value={passphrase}
            disabled={running || submitting}
            onChange={(e) => { setPassphrase(e.target.value); setFormError(null); }}
            className={INPUT_CLASS}
            placeholder="Full backup passphrase"
          />
        </FormField>
        <FormField label="Confirm Passphrase">
          <input
            id="fullBackupPassphraseConfirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            disabled={running || submitting}
            onChange={(e) => { setConfirm(e.target.value); setFormError(null); }}
            className={INPUT_CLASS}
            placeholder="Confirm passphrase"
          />
        </FormField>
      </div>
      <p className="text-xs text-vault-text-muted">
        Keep this passphrase somewhere safe. Without it the backup cannot be restored, not even by BlackVault.
      </p>
      {formError && <StatusMessage tone="error" message={formError} />}
      <div className="flex justify-end">
        <StandardButton
          type="button"
          variant="primary"
          onClick={handleStart}
          disabled={!isAdmin || running || submitting}
          loading={submitting}
          loadingLabel="Starting..."
          icon={<Archive className="h-4 w-4" />}
        >
          {running ? "Backup running..." : "Start Full Backup"}
        </StandardButton>
      </div>

      {statusUnreadable && (
        <StatusMessage tone="warning" message="Could not read the backup status (your session may have expired). The backup may still be running on the server; reload this page to check." />
      )}

      {running && progress && status && (
        <div className="rounded-md border border-[#00C2FF]/30 bg-[#00C2FF]/10 px-3 py-2 flex flex-col gap-1.5" data-testid="full-backup-progress">
          <p className="text-xs font-medium text-[#00C2FF]">
            {status.phase ? PHASE_LABEL[status.phase] : "Starting"}
          </p>
          <div
            role="progressbar"
            aria-label={status.phase ? PHASE_LABEL[status.phase] : "Starting"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.pct ?? undefined}
            className="h-2 w-full overflow-hidden rounded bg-vault-surface-2"
          >
            <div
              className={progress.pct === null ? "h-full w-1/3 animate-pulse bg-[#00C2FF]" : "h-full bg-[#00C2FF]"}
              style={progress.pct === null ? undefined : { width: `${progress.pct}%` }}
            />
          </div>
          <p className="text-xs text-[#00C2FF]/80">{progress.detail}</p>
        </div>
      )}

      {status?.state === "failed" && (
        <StatusMessage tone="error" message={status.error ?? "The backup failed."} />
      )}

      {status?.state === "succeeded" && (
        <div className="flex flex-col gap-2" data-testid="full-backup-result">
          <div className="rounded-md border border-[#00C853]/30 bg-[#00C853]/10 px-3 py-2 flex flex-col gap-0.5">
            <p className="text-xs font-medium text-[#00C853]">
              {unreadable.length > 0 ? "Backup finished, but it is INCOMPLETE" : "Backup complete"}
            </p>
            <p className="font-mono text-xs text-[#00C853]/80">{status.file}</p>
            <p className="text-xs text-[#00C853]/70">
              {status.files ?? 0} file{status.files === 1 ? "" : "s"}, {formatBytes(status.bytes ?? 0)} of uploads. Saved in the server&apos;s backup folder.
            </p>
          </div>
          {unreadable.length > 0 && (
            <div className="rounded-lg border border-[#E53935]/30 bg-[#E53935]/10 px-4 py-3 text-sm text-[#E53935]" role="alert">
              <p className="font-medium">
                {unreadable.length} file{unreadable.length === 1 ? " was" : "s were"} unreadable and {unreadable.length === 1 ? "is" : "are"} NOT in this backup.
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {unreadable.map((x) => <li key={x.path}><span className="font-mono">{x.path}</span>: {x.reason}</li>)}
              </ul>
            </div>
          )}
          {vanished.length > 0 && (
            <div className="rounded-md border border-vault-border bg-vault-surface px-3 py-2 text-xs text-vault-text-muted">
              {vanished.length} file{vanished.length === 1 ? " was" : "s were"} deleted while the backup ran and {vanished.length === 1 ? "is" : "are"} not included.
              <ul className="mt-1 list-disc pl-5">
                {vanished.map((x) => <li key={x.path} className="font-mono">{x.path}</li>)}
              </ul>
            </div>
          )}
          {(status.warnings ?? []).map((w) => (
            <StatusMessage key={w} tone="warning" message={w} />
          ))}
        </div>
      )}
    </div>
  );
}
