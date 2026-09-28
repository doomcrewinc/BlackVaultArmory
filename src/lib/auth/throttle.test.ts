import { describe, expect, it } from "vitest";
import { createThrottle } from "./throttle";

describe("createThrottle", () => {
  it("allows 5 failures freely, then waits 1, 2, 4… seconds, capped at 900", () => {
    let t = 0;
    const th = createThrottle({ now: () => t });
    for (let i = 0; i < 5; i++) {
      expect(th.check("jeff")).toEqual({ allowed: true });
      th.fail("jeff");
    }
    expect(th.check("jeff")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    t += 1000;
    expect(th.check("jeff")).toEqual({ allowed: true });
    th.fail("jeff");
    expect(th.check("jeff")).toEqual({ allowed: false, retryAfterSeconds: 2 });
    for (let i = 0; i < 20; i++) {
      t += 1_000_000;
      th.fail("jeff");
    }
    expect(th.check("jeff")).toEqual({ allowed: false, retryAfterSeconds: 900 });
  });

  it("never locks out: after the wait, an attempt is always allowed", () => {
    let t = 0;
    const th = createThrottle({ now: () => t });
    for (let i = 0; i < 50; i++) th.fail("admin");
    t += 900_000;
    expect(th.check("admin")).toEqual({ allowed: true });
  });

  it("success resets; keys are independent", () => {
    let t = 0;
    const th = createThrottle({ now: () => t });
    for (let i = 0; i < 6; i++) th.fail("a");
    expect(th.check("b")).toEqual({ allowed: true });
    th.succeed("a");
    expect(th.check("a")).toEqual({ allowed: true });
  });
});
