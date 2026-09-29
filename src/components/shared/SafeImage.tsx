"use client";

import { useState, type ReactNode } from "react";
import Image, { type ImageProps } from "next/image";

type SafeImageSource = ImageProps["src"] | null | undefined;

interface SafeImageProps extends Omit<ImageProps, "src" | "alt"> {
  src?: SafeImageSource;
  alt: string;
  fallback: ReactNode;
}

function sourceKey(src: SafeImageSource): string | null {
  if (!src) return null;
  if (typeof src === "string") return src;
  return (src as { src?: string }).src ?? null;
}

/**
 * Uploaded photos (`/uploads/...`) and API-served images are behind login. Loaded straight from
 * the browser they always carry the session cookie; through `/_next/image` the server fetches
 * them itself, and whether that internal fetch carries the cookie past proxy.ts is unproven.
 * So local sources skip optimisation; remote URLs keep it.
 */
function isLocalSource(source: string): boolean {
  return source.startsWith("/uploads/") || source.startsWith("/api/");
}

export function SafeImage({ src, fallback, onError, alt, unoptimized, ...imageProps }: SafeImageProps) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const currentSource = sourceKey(src);

  if (!currentSource || failedSource === currentSource) {
    return <>{fallback}</>;
  }

  return (
    <>
      {!loaded && (
        <div className="absolute inset-0 bg-vault-border/30 animate-pulse rounded" />
      )}
      <Image
        {...imageProps}
        src={src as ImageProps["src"]}
        alt={alt}
        unoptimized={unoptimized || isLocalSource(currentSource)}
        onLoad={() => setLoaded(true)}
        onError={(event) => {
          setFailedSource(currentSource);
          onError?.(event);
        }}
      />
    </>
  );
}
