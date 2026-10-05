import { AlertTriangle, Check, Loader2 } from "lucide-react";

export type CaptureEntry = {
  id: number;
  name: string;
  status: "sending" | "sent" | "failed";
  message?: string;
};

export function CaptureUploadList({
  entries,
  onRetry,
}: Readonly<{
  entries: CaptureEntry[];
  onRetry: (id: number) => void;
}>) {
  if (entries.length === 0) return null;
  return (
    <section aria-label="Sent from this phone" className="space-y-2">
      <h2 className="text-sm font-semibold text-vault-text">This visit</h2>
      <ul className="space-y-2">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="rounded-lg border border-vault-border bg-vault-surface px-3 py-3 text-sm"
          >
            <p className="truncate text-vault-text">{entry.name}</p>
            {entry.status === "sending" && (
              <output className="mt-1 flex items-center gap-2 text-vault-text-muted">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Sending…
              </output>
            )}
            {entry.status === "sent" && (
              <p className="mt-1 flex items-center gap-2 text-[#00C853]">
                <Check className="h-4 w-4" aria-hidden="true" />
                Sent
              </p>
            )}
            {entry.status === "failed" && (
              <div className="mt-1 space-y-2">
                <p className="flex items-start gap-2 text-[#E53935]">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Failed — {entry.message}</span>
                </p>
                <button
                  type="button"
                  onClick={() => onRetry(entry.id)}
                  className="min-h-12 w-full rounded-lg border border-[#E53935]/40 text-[#E53935] font-medium"
                >
                  Retry
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
