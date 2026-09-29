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
    const t = 0;
    const th = createThrottle({ now: () => t });
    for (let i = 0; i < 6; i++) th.fail("a");
    expect(th.check("b")).toEqual({ allowed: true });
    th.succeed("a");
    expect(th.check("a")).toEqual({ allowed: true });
  });

  it("a full map never evicts a throttled key to make room (no backoff reset by spraying)", () => {
    let t = 0;
    const th = createThrottle({ now: () => t, maxKeys: 3 });
    for (let i = 0; i < 5; i++) th.fail("u:admin");
    expect(th.check("u:admin")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    for (let i = 0; i < 50; i++) th.fail(`u:spray-${i}`);
    expect(th.check("u:admin")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    t += 1000;
    expect(th.check("u:admin")).toEqual({ allowed: true });
  });

  it("evicts the non-throttled key with the fewest failures", () => {
    const th = createThrottle({ now: () => 0, maxKeys: 2 });
    for (let i = 0; i < 4; i++) th.fail("four");
    th.fail("one");
    th.fail("new");
    // "four" survived (one more failure throttles it); "one" was the victim.
    th.fail("four");
    expect(th.check("four")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    for (let i = 0; i < 4; i++) th.fail("one");
    expect(th.check("one")).toEqual({ allowed: true });
  });

  it("when every tracked key is throttled, a new key is simply not tracked", () => {
    const th = createThrottle({ now: () => 0, maxKeys: 2 });
    for (let i = 0; i < 5; i++) th.fail("a");
    for (let i = 0; i < 5; i++) th.fail("b");
    for (let i = 0; i < 10; i++) th.fail("c");
    expect(th.check("c")).toEqual({ allowed: true });
    expect(th.check("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(th.check("b")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});
