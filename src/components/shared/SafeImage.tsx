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
 * Uploaded photos (`/uploads/...`) and API-served images are behind login, so local sources
 * MUST skip `/_next/image` — do not re-enable optimisation for them. Verified in the real Docker
 * image (Task 11): `/_next/image?url=/uploads/...` requested WITH a valid session cookie returns
 * 400, and the server logs "The requested resource isn't a valid image for /uploads/... received
 * null" — Next's internal fetch does not carry the user's cookie, so proxy.ts redirects it to
 * /login. Loaded straight from the browser, the same URL returns 200. Remote URLs keep
 * optimisation.
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
