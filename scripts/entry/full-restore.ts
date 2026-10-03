/**
 * The full-restore CLI (spec 3c §3 step 4). Bundled by
 * scripts/build-scripts.mjs to dist/scripts/full-restore.mjs and run by
 * restore.sh / restore.bat in a one-off container, with the app STOPPED and
 * a snapshot already taken:
 *
 *   node dist/scripts/full-restore.mjs [--dir <folder>] [--stamp <ts>] <file>
 *
 * It REPLACES every backup record and the images/ and documents/ folders
 * with the archive's. The engine (src/lib/backup/full-restore.ts) has the
 * steps and what it undoes itself on failure.
 *
 * PASSPHRASE  Read from standard input, and only from there — never from
 *             argv or the environment. Everything up to end-of-input is the
 *             passphrase, minus ONE trailing line ending (LF or CRLF).
 * <file>      The archive. A bare file name is looked up in the backup
 *             folder; a path is used as given.
 * --dir       The backup folder. Default /app/backups.
 * --stamp     <ts> for uploads/.restore-<ts> and uploads/.pre-restore-<ts>
 *             (YYYYmmdd-HHMMSS). The wrapper passes its own so that its
 *             rollback knows which folders are this run's. Default: now.
 *
 * STDOUT      Exactly one line on success, nothing on failure:
 *               BLACKVAULT_FULL_RESTORE_OK file=<name> files=<n> bytes=<n> pre_restore=<folder name>
 * STDERR      One `full-restore: <message>` line on failure; the message
 *             says whether the database was changed. `WARNING: <message>`
 *             on success for anything that went wrong after the restore
 *             was complete.
 * EXIT CODE   0 restored · 1 failed. After a 1 (or any other non-zero
 *             status) the wrapper restores its snapshot, whatever the
 *             message says.
 */
import path from "node:path";
import { DEFAULT_FULL_BACKUP_DIR } from "@/lib/backup/full-lock";

const EXIT_OK = 0;
const EXIT_FAILED = 1;

class UsageError extends Error {}

interface Args {
  dir: string;
  stamp: string | null;
  file: string;
}

const USAGE = "Usage: full-restore [--dir <folder>] [--stamp <YYYYmmdd-HHMMSS>] <file>; the passphrase is read from standard input.";

function parseArgs(argv: string[]): Args {
  let dir = DEFAULT_FULL_BACKUP_DIR;
  let stamp: string | null = null;
  let file: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir" || arg === "--stamp") {
      const value = argv[++i];
      if (!value) throw new UsageError(`${arg} needs a value. Nothing was changed.`);
      if (arg === "--dir") dir = value;
      else stamp = value;
    } else if (arg.startsWith("-") || file !== null) {
      // Deliberately does not echo the argument back: if someone puts a
      // passphrase on the command line by mistake, it must not be repeated.
      throw new UsageError(`unknown argument. ${USAGE} Nothing was changed.`);
    } else file = arg;
  }
  if (file === null) throw new UsageError(`no backup file was given. ${USAGE} Nothing was changed.`);
  return { dir, stamp, file };
}

async function readPassphrase(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError("the passphrase must be supplied on standard input (restore.sh does this for you); it is never read from the terminal here. Nothing was changed.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (text.length === 0) throw new UsageError("no passphrase was supplied on standard input. Nothing was changed.");
  return text;
}

function oneLine(message: string): string {
  return message.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const passphrase = await readPassphrase();
  const dir = path.resolve(args.dir);
  const file = /[\\/]/.test(args.file) ? path.resolve(args.file) : path.join(dir, args.file);

  const [{ runFullRestore }, { prisma }] = await Promise.all([import("@/lib/backup/full-restore"), import("@/lib/prisma")]);
  try {
    const result = await runFullRestore({ file, passphrase, ...(args.stamp ? { stamp: args.stamp } : {}) });
    for (const warning of result.warnings) console.error(`WARNING: ${oneLine(warning)}`);
    console.log(`BLACKVAULT_FULL_RESTORE_OK file=${result.file} files=${result.files} bytes=${result.bytes} pre_restore=${result.preRestore}`);
    return EXIT_OK;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main()
  .catch((e: unknown) => {
    // The error's own message is the user-facing text (SealError's code alone
    // does not tell "wrong passphrase" from "damaged or incomplete").
    const message = e instanceof Error ? e.message : String(e);
    console.error(`full-restore: ${oneLine(message)}`);
    return EXIT_FAILED;
  })
  .then((code) => {
    // Flush both streams before exiting (a pipe to a shell wrapper is async).
    process.exitCode = code;
    process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  });
