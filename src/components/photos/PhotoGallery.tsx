"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Loader2, Smartphone, Upload, X } from "lucide-react";
import type { PhotoDto } from "@/lib/photos/store";
import {
  MAX_PHOTO_LABEL_LENGTH,
  photoFileError,
  type PhotoEntityType,
} from "@/lib/photos/client-constants";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { PhotoCard } from "./PhotoCard";
import { PhotoOverlay } from "./PhotoOverlay";
import { CapturePassDialog } from "./CapturePassDialog";

interface PhotoGalleryProps {
  entityType: PhotoEntityType;
  entityId: string;
  /** Shows "Continue on phone" and its dialog. On by default. */
  withPhonePass?: boolean;
  /** Called after a change that alters the item's main picture. */
  onMainChange?: () => void;
}

const HEADER_BUTTON =
  "flex items-center gap-1.5 text-xs bg-[#00C2FF]/10 border border-[#00C2FF]/30 text-[#00C2FF] hover:bg-[#00C2FF]/20 px-2.5 py-1.5 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

async function errorFrom(res: Response, fallback: string): Promise<string> {
  const json = await res.json().catch(() => null);
  return typeof json?.error === "string" ? json.error : fallback;
}

export function PhotoGallery({
  entityType,
  entityId,
  withPhonePass = true,
  onMainChange,
}: PhotoGalleryProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [photos, setPhotos] = useState<PhotoDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<PhotoDto | null>(null);
  const [deleting, setDeleting] = useState<PhotoDto | null>(null);
  const [phoneOpen, setPhoneOpen] = useState(false);

  const mainChanged = useCallback(() => {
    if (onMainChange) onMainChange();
    else router.refresh();
  }, [onMainChange, router]);

  const loadPhotos = useCallback(() => {
    let cancelled = false;
    const query = new URLSearchParams({ entityType, entityId });
    fetch(`/api/photos?${query}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data?.photos)) setPhotos(data.photos);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load photos.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId]);

  useEffect(() => loadPhotos(), [loadPhotos]);

  const closePhoneDialog = useCallback(() => {
    setPhoneOpen(false);
    loadPhotos();
    // A phone upload can make the item's first photo its main picture.
    mainChanged();
  }, [loadPhotos, mainChanged]);

  function chooseFile(file: File | undefined) {
    if (!file) return;
    const problem = photoFileError(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setPending(file);
    setLabel("");
  }

  function cancelPending() {
    setPending(null);
    setLabel("");
  }

  async function upload() {
    if (!pending) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("entityType", entityType);
      form.append("entityId", entityId);
      form.append("file", pending);
      if (label.trim()) form.append("label", label.trim());
      const res = await fetch("/api/photos", { method: "POST", body: form });
      if (!res.ok) {
        setError(await errorFrom(res, "Upload failed."));
        return;
      }
      const { photo } = (await res.json()) as { photo: PhotoDto };
      setPhotos((prev) => [...prev, photo]);
      cancelPending();
      if (photo.isMain) mainChanged();
    } catch {
      setError("Network error. Could not upload the photo.");
    } finally {
      setUploading(false);
    }
  }

  async function patch(photo: PhotoDto, body: object, failure: string) {
    setBusyId(photo.id);
    setError(null);
    try {
      const res = await fetch(`/api/photos/${photo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await errorFrom(res, failure));
        return false;
      }
      return true;
    } catch {
      setError(`Network error. ${failure}`);
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function makeMain(photo: PhotoDto) {
    if (!(await patch(photo, { main: true }, "Could not change the main picture."))) return;
    setPhotos((prev) => prev.map((p) => ({ ...p, isMain: p.id === photo.id })));
    mainChanged();
  }

  async function saveLabel(photo: PhotoDto, next: string) {
    if (!(await patch(photo, { label: next }, "Could not save the label."))) return false;
    setPhotos((prev) =>
      prev.map((p) => (p.id === photo.id ? { ...p, label: next || null } : p)),
    );
    return true;
  }

  async function remove(photo: PhotoDto) {
    setBusyId(photo.id);
    setError(null);
    try {
      const res = await fetch(`/api/photos/${photo.id}`, { method: "DELETE" });
      if (!res.ok) {
        setError(await errorFrom(res, "Could not delete the photo."));
        return;
      }
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      if (photo.isMain) mainChanged();
    } catch {
      setError("Network error. Could not delete the photo.");
    } finally {
      setBusyId(null);
    }
  }

  const closeViewer = useCallback(() => {
    setViewing(null);
    openerRef.current?.focus();
  }, []);

  return (
    <div className="rounded-xl border border-vault-border bg-vault-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-vault-border flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-vault-text">Photos</h3>
          <p className="text-xs text-vault-text-faint">{photos.length} attached</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            aria-label="Choose a photo"
            className="sr-only"
            onChange={(e) => {
              chooseFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className={HEADER_BUTTON}
          >
            {uploading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Camera className="w-3.5 h-3.5" />
            )}
            Add photo
          </button>
          {withPhonePass && (
            <button type="button" onClick={() => setPhoneOpen(true)} className={HEADER_BUTTON}>
              <Smartphone className="w-3.5 h-3.5" />
              Continue on phone
            </button>
          )}
        </div>
      </div>

      {pending && (
        <div className="p-4 border-b border-vault-border bg-vault-bg/50 space-y-3">
          <p className="text-sm text-vault-text truncate">{pending.name}</p>
          <input
            type="text"
            value={label}
            maxLength={MAX_PHOTO_LABEL_LENGTH}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            aria-label="Label (optional)"
            className="w-full bg-vault-bg border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={uploading}
              onClick={() => void upload()}
              className={HEADER_BUTTON}
            >
              {uploading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Upload className="w-3.5 h-3.5" />
              )}
              Upload
            </button>
            <button
              type="button"
              disabled={uploading}
              onClick={cancelPending}
              className="flex items-center gap-1.5 text-xs border border-vault-border text-vault-text-muted hover:bg-vault-border px-2.5 py-1.5 rounded transition-colors disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mx-4 mt-4 rounded-md border border-[#E53935]/30 bg-[#E53935]/10 px-3 py-2 text-xs text-[#E53935]"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-8 flex justify-center">
          <div className="w-5 h-5 border-2 border-[#00C2FF]/30 border-t-[#00C2FF] rounded-full animate-spin" />
        </div>
      ) : photos.length === 0 ? (
        <div className="p-6 text-center">
          <Camera className="w-8 h-8 text-vault-border mx-auto mb-2" />
          <p className="text-xs text-vault-text-faint">No photos yet.</p>
        </div>
      ) : (
        <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {photos.map((photo) => (
            <PhotoCard
              key={photo.id}
              photo={photo}
              busy={busyId === photo.id}
              onOpen={(p, trigger) => {
                openerRef.current = trigger;
                setViewing(p);
              }}
              onMakeMain={(p) => void makeMain(p)}
              onDelete={setDeleting}
              onSaveLabel={saveLabel}
            />
          ))}
        </div>
      )}

      {phoneOpen && (
        <CapturePassDialog entityType={entityType} entityId={entityId} onClose={closePhoneDialog} />
      )}

      {viewing && <PhotoOverlay photo={viewing} onClose={closeViewer} />}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this photo?"
        description="The picture is removed permanently."
        confirmLabel="Delete"
        dangerous
        onConfirm={() => {
          if (deleting) void remove(deleting);
        }}
      />
    </div>
  );
}
