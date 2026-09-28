import { AuthCard } from "@/components/auth/AuthCard";
import { SetupForm } from "@/components/auth/SetupForm";

export default function SetupPage() {
  return (
    <AuthCard title="Set up BlackVault" subtitle="Create the first admin account">
      <SetupForm />
    </AuthCard>
  );
}
