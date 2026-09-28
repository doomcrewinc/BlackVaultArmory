import { AuthCard } from "@/components/auth/AuthCard";
import { LoginForm } from "@/components/auth/LoginForm";

/**
 * `next` is read from the query as-is and handed to the login API unchanged — the server
 * sanitises it with safeNextPath. Never decoded here.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <AuthCard title="Sign in" subtitle="Welcome back to BlackVault">
      <LoginForm next={next ?? null} />
    </AuthCard>
  );
}
