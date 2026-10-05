import type { Metadata } from "next";
import { CaptureScreen } from "@/components/photos/CaptureScreen";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Add to BlackVault",
  robots: { index: false, follow: false },
};

/** The phone page. It renders the screen and nothing else; no session is read. */
export default async function CapturePage({ params }: Readonly<{ params: Promise<{ token: string }> }>) {
  const { token } = await params;
  return <CaptureScreen token={token} />;
}
