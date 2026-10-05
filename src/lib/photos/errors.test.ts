import { describe, expect, it } from "vitest";
import { UPLOADS_NOT_WRITABLE_MESSAGE, describeError, uploadFailureMessage } from "./errors";

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

describe("uploadFailureMessage", () => {
  it.each(["EACCES", "EPERM", "EROFS"])("%s gives the permissions message", (code) => {
    expect(uploadFailureMessage(Object.assign(new Error("m"), { code }), "Failed")).toBe(UPLOADS_NOT_WRITABLE_MESSAGE);
  });

  it.each([Object.assign(new Error("m"), { code: "ENOSPC" }), Object.assign(new Error("m"), { code: 13 }), new Error("m"), null, "EACCES"])(
    "%j gives the fallback",
    (e) => {
      expect(uploadFailureMessage(e, "Failed")).toBe("Failed");
    },
  );
});
