"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, FileText, Loader2, X } from "lucide-react";
import { MAX_PHOTO_LABEL_LENGTH, photoFileError } from "@/lib/photos/client-constants";
import {
  DOC_TYPE_OPTIONS,
  loadPassInfo,
  sendUpload,
  type DocTypeValue,
  type PassInfo,
  type UploadFields,
} from "@/lib/capture/client";
import { CaptureUploadList, type CaptureEntry } from "./CaptureUploadList";

type Kind = "photo" | "paperwork";
type Job = CaptureEntry & { file: File; fields: UploadFields };
type Load =
  | { state: "loading" }
  | { state: "ready"; info: PassInfo }
  | { state: "blocked"; message: string; retryable: boolean };

const BIG_BUTTON =
  "flex min-h-16 w-full items-center justify-center gap-3 rounded-xl border border-[#00C2FF]/40 bg-[#00C2FF]/10 text-lg font-semibold text-[#00C2FF] active:bg-[#00C2FF]/20 disabled:opacity-50";
const FIELD =
  "min-h-12 w-full rounded-lg border border-vault-border bg-vault-bg px-3 text-base text-vault-text placeholder-vault-text-faint focus:border-[#00C2FF] focus:outline-none";

function usesLeft(n: number): string {
  return `${n} ${n === 1 ? "upload" : "uploads"} left`;
}

export function CaptureScreen({ token }: { token: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [remaining, setRemaining] = useState(0);
  const [kind, setKind] = useState<Kind>("photo");
  const [chosen, setChosen] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [docType, setDocType] = useState<DocTypeValue>("RECEIPT");
  const [formError, setFormError] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);

  const applyLoad = useCallback((result: Awaited<ReturnType<typeof loadPassInfo>>) => {
    if (result.ok) {
      setRemaining(result.info.remaining);
      setLoad({ state: "ready", info: result.info });
    } else {
      setLoad({ state: "blocked", message: result.message, retryable: result.retryable });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadPassInfo(token).then((result) => {
      if (!cancelled) applyLoad(result);
    });
    return () => {
      cancelled = true;
    };
  }, [token, applyLoad]);

  async function reload() {
    setLoad({ state: "loading" });
    applyLoad(await loadPassInfo(token));
  }

  function patchJob(id: number, change: Partial<CaptureEntry>) {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...change } : j)));
  }

  async function run(id: number, file: File, fields: UploadFields) {
    patchJob(id, { status: "sending", message: undefined });
    const result = await sendUpload(token, file, fields);
    if (result.ok) {
      setRemaining((prev) =>
        Math.max(0, result.remaining === null ? prev - 1 : Math.min(prev, result.remaining)),
      );
      patchJob(id, { status: "sent" });
    } else if (result.ended) {
      setEnded(result.message);
      patchJob(id, { status: "failed", message: result.message });
    } else {
      patchJob(id, { status: "failed", message: result.message });
    }
  }

  function reset() {
    setChosen(null);
    setLabel("");
    setDocType("RECEIPT");
    setFormError(null);
  }

  function choose(next: Kind) {
    setKind(next);
    inputRef.current?.click();
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    const problem = photoFileError(file);
    if (problem) {
      setChosen(null);
      setFormError(problem);
      return;
    }
    setFormError(null);
    setChosen(file);
  }

  function send() {
    if (!chosen) return;
    const fields: UploadFields =
      kind === "photo" ? { kind, label } : { kind, docType };
    const id = nextId.current++;
    setJobs((prev) => [{ id, name: chosen.name, status: "sending", file: chosen, fields }, ...prev]);
    reset();
    void run(id, chosen, fields);
  }

  function retry(id: number) {
    const job = jobs.find((j) => j.id === id);
    if (job) void run(id, job.file, job.fields);
  }

  if (load.state === "loading") {
    return (
      <div className="flex min-h-svh items-center justify-center" role="status" aria-label="Loading">
        <Loader2 className="h-8 w-8 animate-spin text-[#00C2FF]" />
      </div>
    );
  }

  if (load.state === "blocked") {
    return (
      <div className="mx-auto max-w-md space-y-4 p-4 pt-10">
        <p role="alert" className="rounded-lg border border-[#E53935]/30 bg-[#E53935]/10 p-4 text-base text-[#E53935]">
          {load.message}
        </p>
        {load.retryable && (
          <button type="button" onClick={() => void reload()} className={BIG_BUTTON}>
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-5 p-4 pb-10">
      <header className="pt-4">
        <h1 className="break-words text-2xl font-bold text-vault-text">{load.info.itemName}</h1>
        <p className="mt-1 text-sm text-vault-text-muted">{usesLeft(remaining)}</p>
      </header>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Choose a file"
        className="sr-only"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {ended !== null || remaining <= 0 ? (
        <p role="alert" className="rounded-lg border border-vault-border bg-vault-surface p-4 text-base text-vault-text">
          {ended ?? "This pass is full. Make a new one on the computer."}
        </p>
      ) : (
        <div className="space-y-3">
          <button type="button" onClick={() => choose("photo")} className={BIG_BUTTON}>
            <Camera className="h-6 w-6" aria-hidden="true" />
            Photo
          </button>
          <button type="button" onClick={() => choose("paperwork")} className={BIG_BUTTON}>
            <FileText className="h-6 w-6" aria-hidden="true" />
            Paperwork
          </button>
        </div>
      )}

      {formError && ended === null && (
        <p role="alert" className="rounded-lg border border-[#E53935]/30 bg-[#E53935]/10 p-3 text-sm text-[#E53935]">
          {formError}
        </p>
      )}

      {chosen && ended === null && (
        <div className="space-y-3 rounded-xl border border-vault-border bg-vault-surface p-4">
          <p className="truncate text-sm text-vault-text">
            {kind === "photo" ? "Photo" : "Paperwork"}: {chosen.name}
          </p>
          {kind === "photo" ? (
            <input
              type="text"
              value={label}
              maxLength={MAX_PHOTO_LABEL_LENGTH}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (optional)"
              aria-label="Label"
              className={FIELD}
            />
          ) : (
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value as DocTypeValue)}
              aria-label="Type"
              className={FIELD}
            >
              {DOC_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={send} className={BIG_BUTTON}>
            Send
          </button>
          <button
            type="button"
            onClick={reset}
            aria-label="Cancel"
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-vault-border text-vault-text-muted"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Cancel
          </button>
        </div>
      )}

      <CaptureUploadList entries={jobs} onRetry={retry} />
    </div>
  );
}
