import { peekToken } from "@/lib/auth/tokens";
import { AuthCard } from "@/components/auth/AuthCard";
import { LinkExpired } from "@/components/auth/LinkExpired";
import { RedeemForm } from "@/components/auth/RedeemForm";

/** Server component: peeks the token (never consumes it) to decide what to render. */
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const peeked = await peekToken(token);
  // A SETUP code happening to peek here (or any other unexpected kind) renders as expired too —
  // only a RESET token is redeemable on this page.
  if (!peeked || peeked.kind !== "RESET") return <LinkExpired />;

  return (
    <AuthCard title="Reset your password" subtitle="Choose a new password for your account">
      <RedeemForm kind="RESET" token={token} />
    </AuthCard>
  );
}
