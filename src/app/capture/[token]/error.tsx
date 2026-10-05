"use client";

/**
 * The root error boundary reports outages to DatabaseStatusProvider, which the
 * capture page does not render inside. This one only offers a retry, and
 * logs nothing (the failing URL contains the pass token).
 */
export default function CaptureError({ reset }: Readonly<{ reset: () => void }>) {
  return (
    <div className="mx-auto max-w-md space-y-4 p-4 pt-10">
      <p role="alert" className="rounded-lg border border-[#E53935]/30 bg-[#E53935]/10 p-4 text-base text-[#E53935]">
        Something went wrong. Try again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="min-h-16 w-full rounded-xl border border-[#00C2FF]/40 bg-[#00C2FF]/10 text-lg font-semibold text-[#00C2FF]"
      >
        Retry
      </button>
    </div>
  );
}
