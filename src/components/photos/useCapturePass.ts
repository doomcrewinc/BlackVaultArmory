"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PhotoDto } from "@/lib/photos/store";
import type { PhotoEntityType } from "@/lib/photos/client-constants";
import { isLoopbackOrigin, passUrl, type PassNetwork } from "@/lib/capture/pass-url";

export const POLL_INTERVAL_MS = 3000;

export type PassDocument = { id: string; name: string; type: string; createdAt: string };
export type PassStatus = "open" | "expired" | "closed" | "full";
type PassState = { id: string; path: string; expiresAt: number };

export type CapturePass = {
  creating: boolean;
  error: string | null;
  link: { url: string; reachable: boolean } | null;
  secondsLeft: number;
  ended: boolean;
  reconnecting: boolean;
  closing: boolean;
  photos: PhotoDto[];
  documents: PassDocument[];
  create: () => void;
  close: () => void;
};

/** What a phone needs from /api/network/local-access; null when it cannot be read. */
async function readNetwork(): Promise<PassNetwork | null> {
  try {
    const res = await fetch("/api/network/local-access");
    if (!res.ok) return null;
    const data = await res.json();
    const direct = data?.directAccess;
    return {
      lanUrl: typeof data?.url === "string" && data.url ? data.url : null,
      publicUrl: typeof data?.publicUrl === "string" && data.publicUrl ? data.publicUrl : null,
      // The route returns { allowed, source }.
      directAccess: typeof direct === "boolean" ? direct : direct?.allowed === true,
    };
  } catch {
    return null;
  }
}

/** Creates a pass on mount, counts it down against the clock and polls what has arrived. */
export function useCapturePass(entityType: PhotoEntityType, entityId: string): CapturePass {
  const [pass, setPass] = useState<PassState | null>(null);
  const [creating, setCreating] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; reachable: boolean } | null>(null);
  const [status, setStatus] = useState<PassStatus>("open");
  const [now, setNow] = useState(() => Date.now());
  const [reconnecting, setReconnecting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [photos, setPhotos] = useState<PhotoDto[]>([]);
  const [documents, setDocuments] = useState<PassDocument[]>([]);
  const started = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    setStatus("open");
    setPhotos([]);
    setDocuments([]);
    setPass(null);
    setLink(null);
    try {
      const origin = window.location.origin;
      const [res, net] = await Promise.all([
        fetch("/api/capture-passes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entityType, entityId }),
        }),
        isLoopbackOrigin(origin) ? readNetwork() : Promise.resolve(null),
      ]);
      if (!alive.current) return;
      if (res.status === 429) {
        setError("Too many passes. Wait a minute and try again.");
        return;
      }
      const data = await res.json().catch(() => null);
      const expiresAt = new Date(data?.expiresAt).getTime();
      if (res.ok && (typeof data?.path !== "string" || typeof data?.id !== "string" || !data.id || !Number.isFinite(expiresAt))) {
        setError("Could not create a pass.");
        return;
      }
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Could not create a pass.");
        return;
      }
      setLink(passUrl(origin, data.path, net));
      setNow(Date.now());
      setPass({ id: data.id, path: data.path, expiresAt });
    } catch {
      if (alive.current) setError("Could not create a pass.");
    } finally {
      if (alive.current) setCreating(false);
    }
  }, [entityType, entityId]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void create();
  }, [create]);

  const secondsLeft = pass ? Math.max(0, Math.ceil((pass.expiresAt - now) / 1000)) : 0;
  const ended = pass !== null && (status !== "open" || secondsLeft <= 0);

  useEffect(() => {
    if (!pass || ended) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pass, ended]);

  useEffect(() => {
    if (!pass || ended) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/capture-passes/${pass.id}`);
        if (!res.ok) throw new Error("poll failed");
        const data = await res.json();
        if (cancelled) return;
        setReconnecting(false);
        if (Array.isArray(data.photos)) setPhotos(data.photos);
        if (Array.isArray(data.documents)) setDocuments(data.documents);
        if (data.status && data.status !== "open") setStatus(data.status);
      } catch {
        if (!cancelled) setReconnecting(true);
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pass, ended]);

  const close = useCallback(async () => {
    if (!pass) return;
    setClosing(true);
    setError(null);
    try {
      const res = await fetch(`/api/capture-passes/${pass.id}`, { method: "DELETE" });
      if (!alive.current) return;
      if (res.ok) setStatus("closed");
      else setError("Could not close the pass.");
    } catch {
      if (alive.current) setError("Could not close the pass.");
    } finally {
      if (alive.current) setClosing(false);
    }
  }, [pass]);

  return {
    creating,
    error,
    link,
    secondsLeft,
    ended,
    reconnecting,
    closing,
    photos,
    documents,
    create: () => void create(),
    close: () => void close(),
  };
}
