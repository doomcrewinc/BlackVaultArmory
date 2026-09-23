import { NextResponse } from "next/server";
import { APP_VERSION } from "@/lib/version";
import { prisma } from "@/lib/prisma";

// The container healthcheck hits this route: it must run on every request, not
// be prerendered at build time (the build runs against a throwaway SQLite file).
export const dynamic = "force-dynamic";

// Shorter than the 10s timeout on the compose healthcheck, so an unreachable
// database answers 503 instead of leaving wget to time out on its own.
const DB_TIMEOUT_MS = 5_000;

/** Counting the settings singleton proves the database answers AND that its
 *  schema is there — a bare `SELECT 1` passes on a SQLite file Prisma just
 *  created empty. */
async function checkDatabase(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const query = prisma.appSettings.count();
  try {
    await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${DB_TIMEOUT_MS}ms`)),
          DB_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // On timeout the query is still in flight; its later rejection is nobody's.
    void Promise.resolve(query).catch(() => {});
  }
}

export async function GET() {
  try {
    await checkDatabase();
  } catch (error) {
    // Prisma errors can carry the connection string, so log it and keep the
    // response generic.
    console.error("[health] database check failed:", error);
    return NextResponse.json(
      {
        status: "error",
        database: "unreachable",
        timestamp: new Date().toISOString(),
        version: APP_VERSION,
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      status: "ok",
      database: "ok",
      timestamp: new Date().toISOString(),
      version: APP_VERSION,
    },
    { status: 200 },
  );
}
