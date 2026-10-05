"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { PhotoDto } from "@/lib/photos/store";

type PhotoOverlayProps = Readonly<{
  photo: PhotoDto;
  onClose: () => void;
}>;

export function PhotoOverlay({ photo, onClose }: PhotoOverlayProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-50 h-full w-full cursor-default bg-black/80"
      />
      <dialog
        open
        aria-modal="true"
        aria-label={photo.label ?? "Full picture"}
        className="pointer-events-none fixed inset-0 z-50 m-0 flex h-full w-full max-h-none max-w-none items-center justify-center border-0 bg-transparent p-4 text-inherit"
      >
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close picture"
          className="pointer-events-auto absolute top-3 right-3 p-2 rounded bg-vault-surface border border-vault-border text-vault-text"
        >
          <X className="w-4 h-4" />
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photo.url}
          alt={photo.label ?? "Item photo"}
          className="pointer-events-auto max-w-full max-h-full object-contain rounded"
        />
      </dialog>
    </>
  );
}
