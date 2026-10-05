import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Sidebar } from "@/components/layout/Sidebar";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { GlobalSearch } from "@/components/search/GlobalSearch";
import { DatabaseStatusProvider } from "@/components/layout/DatabaseStatusProvider";
import { headers } from "next/headers";
import { getCurrentUser } from "@/lib/server/auth";
import { CAPTURE_PAGE_HEADER } from "@/lib/server/capture-page";

export const viewport: Viewport = {
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "BlackVault",
  description: "Tactical firearm inventory & build management platform",
  manifest: "/site.webmanifest",
  icons: {
    icon: "/favicon.svg",
    apple: "/favicon.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The chrome depends on whether someone is signed in. The signed-in user
  // is passed down to Sidebar/MobileHeader for the account block, Log out and
  // the admin-only "Users" link. Auth pages (/login,
  // /setup, /invite/*, /reset/*) render with no chrome at all: no Sidebar, no
  // MobileHeader, no GlobalSearch, no ThemeToggle.
  // The phone capture page is a bare page for everyone, signed in or not: no
  // chrome and no database-status provider (see src/lib/server/capture-page.ts).
  if ((await headers()).get(CAPTURE_PAGE_HEADER) === "1") {
    return (
      <html lang="en" suppressHydrationWarning>
        <body className="antialiased bg-vault-bg text-vault-text">
          <main className="min-h-svh">{children}</main>
        </body>
      </html>
    );
  }

  const user = await getCurrentUser();
  // NavUser (Sidebar.tsx) is deliberately just { displayName, role } — id and
  // sessionId never need to reach a client component, so they're never passed.
  const navUser = user ? { displayName: user.displayName, role: user.role } : null;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply saved theme before first paint to prevent flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('vault-theme');if(t==='light')document.documentElement.setAttribute('data-theme','light');}catch(e){}})()`,
          }}
        />
      </head>
      <body className="antialiased bg-vault-bg text-vault-text">
        <ThemeProvider>
          {/* Everything the user can touch lives inside this provider, which
              marks it inert during a database outage — that is what makes the
              app read-only — and renders the notice outside it. */}
          <DatabaseStatusProvider>
            {user ? (
              <div className="flex min-h-svh">
                <Sidebar user={navUser} />
                <div className="flex flex-col flex-1 min-w-0 min-h-svh overflow-x-clip">
                  <MobileHeader user={navUser} />
                  {/* The document is what scrolls: this element grows with its
                      content. It must not set overscroll-behavior — a browser
                      then stops the wheel from reaching the document, even
                      though this element has nothing of its own to scroll. */}
                  <main className="flex-1 min-h-0 overflow-y-auto overflow-x-clip min-w-0 pb-safe">
                    <ErrorBoundary>{children}</ErrorBoundary>
                  </main>
                </div>
              </div>
            ) : (
              <main className="min-h-svh">
                <ErrorBoundary>{children}</ErrorBoundary>
              </main>
            )}
            {user && <ThemeToggle />}
          </DatabaseStatusProvider>
        </ThemeProvider>
        {user && <GlobalSearch />}
      </body>
    </html>
  );
}
