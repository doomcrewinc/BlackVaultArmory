/**
 * The full-backup CLI (spec 3c §2). Bundled by scripts/build-scripts.mjs to
 * dist/scripts/full-backup.mjs and run inside the app container as uid 1001:
 *
 *   node dist/scripts/full-backup.mjs [--dir <folder>]            make a backup
 *   node dist/scripts/full-backup.mjs [--dir <folder>] --verify <file>
 *
 * This is the contract backup.sh / backup.bat build on:
 *
 * PASSPHRASE  Read from standard input, and only from there — never from
 *             argv or the environment. Everything up to end-of-input is the
 *             passphrase, minus ONE trailing line ending (LF or CRLF).
 *
 * --dir       The backup folder. Default /app/backups.
 * --verify    Stream-decrypts <file> and checks every file's sha256 against
 *             the manifest. Writes nothing. A bare file name is looked up in
 *             the backup folder; a path is used as given.
 *
 * STDOUT      Exactly one line on success, nothing on failure:
 *               BLACKVAULT_FULL_BACKUP_OK file=<name> files=<n> bytes=<n> archive_bytes=<n> skipped=<n> unreadable=<n>
 *               BLACKVAULT_FULL_BACKUP_VERIFIED file=<name> files=<n> bytes=<n> archive_bytes=<n>
 *             <name> is the archive's file name (no folder, no spaces).
 *             `files`/`bytes` count the uploaded files inside and their total
 *             plaintext size; `archive_bytes` is the .bvb file's own size.
 *             `skipped` counts every file left out; `unreadable` is how
 *             many of those exist but could not be read or decrypted.
 * STDERR      Human-readable: one `full-backup: <message>` line on failure.
 *             On success: `full-backup: skipped <path>: <reason>` per file
 *             that vanished mid-run, and for files that could not be read
 *             `WARNING: skipped <path>: <reason>` each, then one
 *             `WARNING: <n> file(s) could not be read ... NOT in this backup.`
 *             The exit code is still 0.
 *
 * EXIT CODE   0 ok · 1 failed · 2 another backup is already running.
 *
 * Nothing here imports the database for --verify: the engine (and with it
 * the Prisma client) is loaded only when a backup is actually made.
 */
import path from "node:path";
import { DEFAULT_FULL_BACKUP_DIR, FullBackupAlreadyRunningError } from "@/lib/backup/full-lock";
import { verifyFullBackup } from "@/lib/backup/full-verify";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_ALREADY_RUNNING = 2;

class UsageError extends Error {}

interface Args {
  dir: string;
  verify: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: DEFAULT_FULL_BACKUP_DIR, verify: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dir" || flag === "--verify") {
      const value = argv[++i];
      if (!value) throw new UsageError(`${flag} needs a value.`);
      if (flag === "--dir") args.dir = value;
      else args.verify = value;
    } else {
      // Deliberately does not echo the argument back: if someone puts a
      // passphrase on the command line by mistake, it must not be repeated.
      throw new UsageError("unknown argument. Usage: full-backup [--dir <folder>] [--verify <file>]; the passphrase is read from standard input.");
    }
  }
  return args;
}

async function readPassphrase(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError("the passphrase must be supplied on standard input (backup.sh does this for you); it is never read from the terminal here.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (text.length === 0) throw new UsageError("no passphrase was supplied on standard input.");
  return text;
}

function oneLine(message: string): string {
  return message.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const passphrase = await readPassphrase();
  const dir = path.resolve(args.dir);

  if (args.verify !== null) {
    const file = /[\\/]/.test(args.verify) ? path.resolve(args.verify) : path.join(dir, args.verify);
    const result = await verifyFullBackup(file, passphrase);
    console.log(
      `BLACKVAULT_FULL_BACKUP_VERIFIED file=${path.basename(file)} files=${result.files} bytes=${result.bytes} archive_bytes=${result.archiveBytes}`,
    );
    return EXIT_OK;
  }

  const [{ runFullBackup }, { prisma }] = await Promise.all([import("@/lib/backup/full-backup"), import("@/lib/prisma")]);
  try {
    const result = await runFullBackup({ passphrase, dir });
    // A vanished file is normal on a live install; an unreadable one is not,
    // and the backup is incomplete without it — say so, loudly (ruling R9).
    let unreadable = 0;
    for (const skipped of result.skipped) {
      if (skipped.kind === "unreadable") {
        unreadable += 1;
        console.error(`WARNING: skipped ${skipped.path}: ${oneLine(skipped.reason)}`);
      } else console.error(`full-backup: skipped ${skipped.path}: ${oneLine(skipped.reason)}`);
    }
    if (unreadable > 0) {
      console.error(`WARNING: ${unreadable} ${unreadable === 1 ? "file could not be read and is" : "files could not be read and are"} NOT in this backup.`);
    }
    console.log(
      `BLACKVAULT_FULL_BACKUP_OK file=${result.file} files=${result.files} bytes=${result.bytes} archive_bytes=${result.archiveBytes} skipped=${result.skipped.length} unreadable=${unreadable}`,
    );
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
    console.error(`full-backup: ${oneLine(message)}`);
    return e instanceof FullBackupAlreadyRunningError ? EXIT_ALREADY_RUNNING : EXIT_FAILED;
  })
  .then((code) => {
    // Flush both streams before exiting (a pipe to a shell wrapper is async).
    process.exitCode = code;
    process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  });
