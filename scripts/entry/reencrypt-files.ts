/**
 * The reencrypt-files CLI (full-backups spec §3). Bundled by
 * scripts/build-scripts.mjs to dist/scripts/reencrypt-files.mjs and run in
 * a one-off app container, with the app stopped:
 *
 *   node dist/scripts/reencrypt-files.mjs        (the OLD key on standard input)
 *
 * It re-encrypts, under this install's CURRENT key, every uploaded file that
 * is encrypted with the old key (src/lib/files/reencrypt.ts has the rules).
 * This is the contract reencrypt-files.sh / reencrypt-files.bat build on:
 *
 * THE OLD KEY  Read from standard input, and only from there — never from
 *              argv or the environment, and no path to it is known here.
 *              Everything up to end-of-input is the text of the old key
 *              file: 64 hex characters, the same format as the install's own
 *              key file (a byte-order mark and surrounding whitespace are
 *              ignored). It takes no arguments; any argument is refused
 *              without being echoed.
 * THE CURRENT KEY  Loaded as the app loads it (the key file the image's
 *              entrypoint places in /run/secrets, or BLACKVAULT_ENCRYPTION_KEY).
 * THE FILES    The uploads root the app uses (IMAGE_UPLOAD_DIR, else
 *              <cwd>/uploads): its images/ and documents/ folders.
 *
 * STDOUT       Exactly one line whenever the uploads folder was gone through
 *              (also when the run then stopped on an error); nothing when
 *              the old key was refused or the run could not start:
 *                BLACKVAULT_REENCRYPT_<OK|NOTHING|FAILED> reencrypted=<n> already_current=<n> unknown_key=<n> not_encrypted=<n> failed=<n>
 *              reencrypted      were under the old key, now under the current one
 *              already_current  already under the current key: skipped
 *              unknown_key      under some other key, or with a damaged
 *                               header: left untouched
 *              not_encrypted    not an encrypted file: left untouched
 *              failed           under the old key but NOT re-encrypted
 *                               (left untouched)
 * STDERR       Human-readable. `WARNING: …` for every unknown_key file and
 *              one closing WARNING with their count; `reencrypt-files: …`
 *              for everything else. The exit code is not changed by a WARNING.
 *
 * EXIT CODE    0  at least one file was under the old key, and every such
 *                 file was re-encrypted (line: OK)
 *              3  nothing was changed: no file is under the old key (line:
 *                 NOTHING — this is also what a second run reports), or the
 *                 old key is not a valid key, or it is the current key
 *              1  failed (line: FAILED when the folder was gone through).
 *                 Every file is whole, under the old key or the current one;
 *                 running it again continues with the rest.
 */
import { ReencryptError, ReencryptKeyError, parseOldKey, reencryptFiles, summaryLine } from "@/lib/files/reencrypt";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_NOTHING = 3;

const USAGE = "Usage: reencrypt-files (no arguments); the old key is read from standard input.";

function oneLine(message: string): string {
  return message.replace(/\s*[\r\n]+\s*/g, " ").trim();
}
const say = (message: string) => console.error(`reencrypt-files: ${oneLine(message)}`);

async function readOldKeyText(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("the old key must be supplied on standard input (reencrypt-files.sh does this for you); it is never read from the terminal here.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  // Deliberately does not echo the argument back: it could be a key typed on the command line by mistake.
  if (process.argv.length > 2) throw new Error(`unknown argument. ${USAGE}`);
  const oldKeys = parseOldKey(await readOldKeyText());

  const result = await reencryptFiles({ oldKeys, log: (line) => console.error(oneLine(line)), warn: (line) => console.error(oneLine(line)) });
  for (const failure of result.failures) say(failure);
  console.log(summaryLine(result));
  const c = result.counts;
  if (result.outcome === "failed") {
    say(
      `${c.failed} ${c.failed === 1 ? "file" : "files"} under the old key could not be re-encrypted and ${c.failed === 1 ? "was" : "were"} left as ${c.failed === 1 ? "it was" : "they were"} (named above); ` +
        `${c.reencrypted} ${c.reencrypted === 1 ? "file was" : "files were"} re-encrypted. BlackVault refuses to start while a file under another key is in the uploads folder: restore those files from a backup or move them out.`,
    );
    return EXIT_FAILED;
  }
  if (result.outcome === "nothing") {
    say(
      `nothing to do: no uploaded file is encrypted with the old key (key id ${oldKeys.id}). ` +
        `${c.alreadyCurrent} already under the current key, ${c.unknownKey} under another key, ${c.notEncrypted} not encrypted. Nothing was changed.`,
    );
    return EXIT_NOTHING;
  }
  say(`re-encrypted ${c.reencrypted} ${c.reencrypted === 1 ? "file" : "files"} under the current key (${c.alreadyCurrent} already were).`);
  return EXIT_OK;
}

main()
  .catch((e: unknown) => {
    if (e instanceof ReencryptError) console.log(summaryLine({ outcome: "failed", counts: e.counts }));
    say(e instanceof Error ? e.message : String(e));
    return e instanceof ReencryptKeyError ? EXIT_NOTHING : EXIT_FAILED;
  })
  .then((code) => {
    // Flush both streams before exiting (a pipe to a shell wrapper is async).
    process.exitCode = code;
    process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  });
