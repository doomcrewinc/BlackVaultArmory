import { describe, expect, it } from "vitest";
import { normaliseAddress } from "./client-address";

describe("normaliseAddress", () => {
  it.each([
    ["1.2.3.4", "1.2.3.4"],
    ["1.2.3.4:5678", "1.2.3.4"],
    ["::1", "::1"],
    ["[::1]", "::1"],
    ["[::1]:443", "::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["[2001:db8::1]:8443", "2001:db8::1"],
    ["::ffff:1.2.3.4", "::ffff:1.2.3.4"],
    ["fe80::1%eth0", "fe80::1%eth0"],
    ["unknown", null],
    ["", null],
    ["1.2.3.4:notaport", null],
    ["999.1.1.1", null],
    ["999.1.1.1:80", null],
    ["../etc/passwd", null],
    ["1.2.3.4/../x", null],
    ["a/b:80", null],
    ["[unknown]:80", null],
    ["[::1]:abc", null],
  ])("%j -> %j", (raw, want) => {
    expect(normaliseAddress(raw)).toBe(want);
  });
});
