import { describe, expect, it } from "vitest";
import { describeError } from "./errors";

describe("describeError", () => {
  it.each([
    [Object.assign(new Error("m"), { code: "ENOSPC" }), "Error ENOSPC"],
    [Object.assign(new TypeError("m"), { code: 5 }), "TypeError 5"],
    [new RangeError("m"), "RangeError"],
    ["text", "string"],
    [null, "object"],
  ])("%j gives %j and never the message", (e, expected) => {
    expect(describeError(e)).toBe(expected);
  });
});
