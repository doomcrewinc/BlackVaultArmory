/**
 * The ONE reader for a backup passphrase that arrives as bytes on standard
 * input (the full-backup, `--verify` and full-restore programs; backup.sh /
 * backup.bat / restore.sh / restore.bat send a passphrase FILE's bytes
 * unchanged). It turns those bytes into the text a person would TYPE, so
 * that a backup sealed from a file opens with the passphrase typed later,
 * and the other way round:
 *
 * - exactly ONE leading UTF-8 byte order mark is dropped (Windows editors
 *   and `Set-Content -Encoding UTF8` write one; nobody types one);
 * - exactly ONE trailing line ending (LF or CRLF) is dropped;
 * - input that is not valid UTF-8, or that contains a NUL, is REFUSED. That
 *   is what a UTF-16 file looks like (PowerShell 5.1's `>` writes UTF-16):
 *   decoding it loosely would seal the backup with a string no keyboard
 *   can produce.
 *
 * Nothing else is changed here: inner and other leading/trailing whitespace
 * is part of the passphrase, and NFC normalisation belongs to the sealer
 * (src/lib/encryption/core.mjs), which every caller goes through.
 *
 * No message ever contains any part of the input.
 */

/** A passphrase input that cannot be used; `message` is the user-facing text. */
export class PassphraseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassphraseInputError";
  }
}

const NOT_UTF8 =
  "the passphrase is not UTF-8 text (it looks like UTF-16 or binary data). Save the passphrase file as UTF-8 text and try again.";

/** The passphrase a person would type, from the bytes of a passphrase file or a pipe. Throws PassphraseInputError. */
export function decodePassphraseInput(bytes: Uint8Array): string {
  let text: string;
  try {
    // fatal: a malformed sequence throws instead of becoming U+FFFD.
    // ignoreBOM: the decoder leaves the BOM in the text; it is removed below, exactly once.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PassphraseInputError(NOT_UTF8);
  }
  if (text.includes("\u0000")) throw new PassphraseInputError(NOT_UTF8);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r?\n$/, "");
  if (text.length === 0) throw new PassphraseInputError("no passphrase was supplied on standard input.");
  return text;
}

/**
 * Reads standard input to its end and decodes it with `decodePassphraseInput`.
 * `wrapper` names the script that normally supplies the input (for the
 * message shown when stdin is a terminal: these programs never prompt).
 */
export async function readPassphraseFromStdin(stdin: NodeJS.ReadStream, wrapper: string): Promise<string> {
  if (stdin.isTTY) {
    throw new PassphraseInputError(
      `the passphrase must be supplied on standard input (${wrapper} does this for you); it is never read from the terminal here.`,
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return decodePassphraseInput(Buffer.concat(chunks));
}
