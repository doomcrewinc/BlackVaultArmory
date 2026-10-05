import { describe, expect, it, vi } from "vitest";

// Every sharp pipeline that does real work (metadata, toBuffer) is counted
// while it runs, so the test can see how many are in flight together.
const counter = vi.hoisted(() => ({ active: 0, max: 0 }));

vi.mock("sharp", async (importOriginal) => {
  const real = (await importOriginal<{ default: typeof import("sharp") }>()).default;
  const track = <T extends (...args: never[]) => Promise<unknown>>(fn: T) =>
    (async (...args: Parameters<T>) => {
      counter.active += 1;
      counter.max = Math.max(counter.max, counter.active);
      try {
        return await fn(...args);
      } finally {
        counter.active -= 1;
      }
    }) as unknown as T;
  const wrapped = ((input: unknown, options?: unknown) => {
    const instance = real(input as never, options as never);
    instance.metadata = track(instance.metadata.bind(instance) as never);
    instance.toBuffer = track(instance.toBuffer.bind(instance) as never);
    return instance;
  }) as unknown as typeof real;
  wrapped.concurrency = real.concurrency;
  return { default: wrapped };
});

import sharp from "sharp";
import { PictureRejected, processPicture } from "./process";

async function picture(side: number) {
  return sharp({
    create: { width: side, height: side, channels: 3, background: { r: 9, g: 80, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

describe("processPicture queue", () => {
  it("never works on two pictures at once", async () => {
    const inputs = await Promise.all([picture(1500), picture(1400), picture(1300)]);
    counter.max = 0;

    const results = await Promise.all(inputs.map((i) => processPicture(i, { preview: true })));

    expect(counter.max).toBe(1);
    expect(results.map((r) => r.width)).toEqual([1500, 1400, 1300]);
  });

  it("lets the next picture run after one is rejected, each caller getting its own outcome", async () => {
    const good = await picture(64);

    const [first, second] = await Promise.allSettled([
      processPicture(Buffer.from("not a picture at all")),
      processPicture(good),
    ]);

    expect(first.status).toBe("rejected");
    expect((first as PromiseRejectedResult).reason).toBeInstanceOf(PictureRejected);
    expect(second.status).toBe("fulfilled");
    expect((second as PromiseFulfilledResult<{ width: number }>).value.width).toBe(64);
  });
});
