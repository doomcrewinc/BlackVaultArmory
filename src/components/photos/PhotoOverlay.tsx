"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { PhotoDto } from "@/lib/photos/store";

interface PhotoOverlayProps {
  photo: PhotoDto;
  onClose: () => void;
}

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
    <div
      role="dialog"
      aria-modal="true"
      aria-label={photo.label ?? "Full picture"}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80"
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close picture"
        className="absolute top-3 right-3 p-2 rounded bg-vault-surface border border-vault-border text-vault-text"
      >
        <X className="w-4 h-4" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.url}
        alt={photo.label ?? "Item photo"}
        onClick={(e) => e.stopPropagation()}
        className="max-w-full max-h-full object-contain rounded"
      />
    </div>
  );
}
