"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Pencil, Star, Trash2 } from "lucide-react";
import type { PhotoDto } from "@/lib/photos/store";
import { MAX_PHOTO_LABEL_LENGTH } from "@/lib/photos/client-constants";

type PhotoCardProps = Readonly<{
  photo: PhotoDto;
  busy: boolean;
  onOpen: (photo: PhotoDto, trigger: HTMLElement) => void;
  onMakeMain: (photo: PhotoDto) => void;
  onDelete: (photo: PhotoDto) => void;
  onSaveLabel: (photo: PhotoDto, label: string) => Promise<boolean>;
}>;

const ACTION_BUTTON =
  "flex items-center gap-1 px-2 py-1 rounded border border-vault-border text-xs text-vault-text-muted hover:text-[#00C2FF] hover:border-[#00C2FF]/30 transition-colors disabled:opacity-50";

export function PhotoCard({
  photo,
  busy,
  onOpen,
  onMakeMain,
  onDelete,
  onSaveLabel,
}: PhotoCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const labelInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) labelInputRef.current?.focus();
  }, [editing]);

  const openLabel = photo.label ? `Open picture: ${photo.label}` : "Open picture";

  async function save() {
    if (await onSaveLabel(photo, draft.trim())) setEditing(false);
  }

  return (
    <div className="rounded-lg border border-vault-border bg-vault-bg overflow-hidden min-w-0">
      <button
        type="button"
        onClick={(e) => onOpen(photo, e.currentTarget)}
        aria-label={openLabel}
        className="relative block w-full aspect-square bg-vault-surface"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photo.previewUrl}
          alt={photo.label ?? "Item photo"}
          loading="lazy"
          className="w-full h-full object-cover"
        />
        {photo.isMain && (
          <span className="absolute top-1.5 left-1.5 text-[10px] px-1.5 py-0.5 rounded border border-[#00C2FF]/30 bg-vault-bg/80 text-[#00C2FF] font-mono">
            Main
          </span>
        )}
      </button>
      <div className="p-2 space-y-2">
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={draft}
              maxLength={MAX_PHOTO_LABEL_LENGTH}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") setEditing(false);
              }}
              aria-label="Photo label"
              ref={labelInputRef}
              className="min-w-0 flex-1 bg-vault-bg border border-vault-border text-vault-text rounded px-2 py-1 text-xs focus:outline-none focus:border-[#00C2FF]"
            />
            <button
              type="button"
              onClick={() => void save()}
              aria-label="Save label"
              className="p-1.5 rounded border border-vault-border text-[#00C853]"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <p className="text-xs text-vault-text truncate min-h-4">
            {photo.label ?? <span className="text-vault-text-faint">No label</span>}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {!photo.isMain && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onMakeMain(photo)}
              className={ACTION_BUTTON}
            >
              <Star className="w-3.5 h-3.5" />
              Make main picture
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(photo.label ?? "");
              setEditing(true);
            }}
            className={ACTION_BUTTON}
          >
            <Pencil className="w-3.5 h-3.5" />
            Edit label
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDelete(photo)}
            className={`${ACTION_BUTTON} hover:!text-red-400 hover:!border-red-500/30`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
