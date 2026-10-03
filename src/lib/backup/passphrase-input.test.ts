/**
 * The shared passphrase reader (ruling R37): what a passphrase FILE's bytes
 * become. The end-to-end proofs (a BOM file seals a backup that the typed
 * passphrase opens) are in scripts/full-backup-cli.test.ts and
 * scripts/full-restore-cli.test.ts.
 */
import { describe, expect, it } from "vitest";
import { decodePassphraseInput, PassphraseInputError } from "./passphrase-input";

const PASS = "correct horse battery staple é";
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const utf8 = (s: string) => Buffer.from(s, "utf8");

describe("decodePassphraseInput", () => {
  it("returns the text as typed: no line ending, LF and CRLF all give the same passphrase", () => {
    for (const input of [PASS, `${PASS}\n`, `${PASS}\r\n`]) expect(decodePassphraseInput(utf8(input))).toBe(PASS);
  });

  it("drops exactly ONE leading UTF-8 BOM, with or without a line ending", () => {
    expect(decodePassphraseInput(Buffer.concat([BOM, utf8(PASS)]))).toBe(PASS);
    expect(decodePassphraseInput(Buffer.concat([BOM, utf8(`${PASS}\r\n`)]))).toBe(PASS);
    // A second one is the user's own character and stays.
    expect(decodePassphraseInput(Buffer.concat([BOM, BOM, utf8(PASS)]))).toBe(`﻿${PASS}`);
    // Only at the very start.
    expect(decodePassphraseInput(utf8(`ab﻿${PASS}`))).toBe(`ab﻿${PASS}`);
  });

  it("drops exactly ONE trailing line ending and nothing else", () => {
    expect(decodePassphraseInput(utf8(`${PASS}\n\n`))).toBe(`${PASS}\n`);
    expect(decodePassphraseInput(utf8(` ${PASS} \n`))).toBe(` ${PASS} `);
    expect(decodePassphraseInput(utf8(`${PASS}\r`))).toBe(`${PASS}\r`);
  });

  it("does not normalise: NFC and NFD forms come back as given (the sealer normalises both to one key)", () => {
    const nfc = "pässphräse with accents".normalize("NFC");
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);
    expect(decodePassphraseInput(utf8(nfc))).toBe(nfc);
    expect(decodePassphraseInput(utf8(nfd))).toBe(nfd);
  });

  it.each([
    ["UTF-16LE with a BOM (PowerShell 5.1's >)", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${PASS}\r\n`, "utf16le")])],
    ["UTF-16LE without a BOM", Buffer.from(PASS, "utf16le")],
    ["UTF-16BE with a BOM", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(PASS, "utf16le").swap16()])],
    ["a lone continuation byte", Buffer.concat([utf8("valid start "), Buffer.from([0x80]), utf8(" valid end")])],
    ["a truncated multi-byte sequence", Buffer.concat([utf8("twelve chars and more "), Buffer.from([0xe2, 0x82])])],
    ["Latin-1 bytes", Buffer.from("pässwörd long enough", "latin1")],
    ["a NUL inside valid UTF-8", utf8("twelve chars\u0000and more")],
  ])("refuses %s, telling the user to save the file as UTF-8, without echoing any of it", (_name, bytes) => {
    let thrown: unknown;
    try {
      decodePassphraseInput(bytes);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PassphraseInputError);
    const message = (thrown as Error).message;
    expect(message).toMatch(/not UTF-8 text/);
    expect(message).toMatch(/Save the passphrase file as UTF-8/);
    for (const word of ["correct", "horse", "twelve", "valid", "sswörd"]) expect(message).not.toContain(word);
  });

  it("refuses empty input, and input that is only a BOM and/or one line ending", () => {
    for (const bytes of [Buffer.alloc(0), utf8("\n"), utf8("\r\n"), BOM, Buffer.concat([BOM, utf8("\r\n")])]) {
      expect(() => decodePassphraseInput(bytes)).toThrow(/no passphrase was supplied/);
    }
  });
});
