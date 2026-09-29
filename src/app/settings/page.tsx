export const dynamic = "force-dynamic";

import { getCurrentUser } from "@/lib/server/auth";
import { SettingsView } from "./SettingsView";

/**
 * The role is read here, on the server, so the client view renders admin controls (or their
 * read-only form) on first paint without a second fetch. Cosmetic only: every write this page
 * makes is refused with 403 by the admin-guarded API routes for a plain user.
 */
export default async function SettingsPage() {
  const user = await getCurrentUser();
  return <SettingsView isAdmin={user?.role === "ADMIN"} />;
}
