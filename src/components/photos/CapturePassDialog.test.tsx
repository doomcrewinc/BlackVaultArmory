// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const qr = vi.hoisted(() => ({ toDataURL: vi.fn(async () => "data:image/png;base64,QR") }));
vi.mock("qrcode", () => ({ toDataURL: qr.toDataURL, default: { toDataURL: qr.toDataURL } }));

import { CapturePassDialog } from "./CapturePassDialog";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const TOKEN_PATH = "/capture/tok123";
const LAN = "http://192.168.1.5:3000";

type Json = Record<string, unknown>;
type Reply = { status?: number; body?: Json } | Error;

const photo = {
  id: "p1",
  url: "/u/p1.jpg",
  previewUrl: "/u/thumbs/p1.webp",
  label: "Front",
  width: 1,
  height: 1,
  fileSize: 1,
  viaPass: true,
  createdAt: "2026-10-04T12:00:01.000Z",
  isMain: false,
};

function net(over: Json = {}): Json {
  return { url: LAN, publicUrl: "https://vault.example.com", directAccess: { allowed: true, source: "setting" }, ...over };
}

/** Routes a stubbed fetch by method and path; each route may be a reply or a function giving one. */
function stubFetch(routes: {
  create?: () => Reply;
  poll?: () => Reply;
  del?: () => Reply;
  local?: () => Reply;
}) {
  const ok = (body: Json): Reply => ({ status: 200, body });
  const defaults = {
    create: () => ({ status: 201, body: { id: "pass1", token: "tok123", path: TOKEN_PATH, expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString() } }),
    poll: () => ok({ status: "open", uploadCount: 0, remaining: 50, photos: [], documents: [] }),
    del: () => ok({ success: true }),
    local: () => ok(net()),
  };
  const r = { ...defaults, ...routes };
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    let reply: Reply;
    if (url === "/api/capture-passes" && method === "POST") reply = r.create();
    else if (url === "/api/network/local-access") reply = r.local();
    else if (url.startsWith("/api/capture-passes/") && method === "DELETE") reply = r.del();
    else if (url.startsWith("/api/capture-passes/")) reply = r.poll();
    else throw new Error(`unexpected fetch ${method} ${url}`);
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body ?? {} };
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const calls = (mock: ReturnType<typeof stubFetch>, pred: (url: string, method: string) => boolean) =>
  mock.mock.calls.filter(([u, i]) => pred(String(u), i?.method ?? "GET")).length;
const polls = (m: ReturnType<typeof stubFetch>) => calls(m, (u, method) => u === "/api/capture-passes/pass1" && method === "GET");

function setOrigin(origin: string) {
  vi.stubGlobal("location", { ...window.location, origin });
}

async function open(onClose = vi.fn()) {
  render(<CapturePassDialog entityType="firearm" entityId="f1" onClose={onClose} />);
  await advance(0);
  return onClose;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  qr.toDataURL.mockClear();
  setOrigin("http://localhost:3000");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CapturePassDialog, creating the pass and its address", () => {
  it("posts the item, reads the network address from a loopback origin and builds the QR from it", async () => {
    const fetchMock = stubFetch({});
    await open();

    const post = fetchMock.mock.calls.find(([u]) => u === "/api/capture-passes")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ entityType: "firearm", entityId: "f1" });
    expect(qr.toDataURL).toHaveBeenCalledWith(LAN + TOKEN_PATH, expect.objectContaining({ width: 200 }));
    expect(screen.getByText(LAN + TOKEN_PATH)).toBeInTheDocument();
    expect(screen.getByAltText(/qr code/i)).toHaveAttribute("src", "data:image/png;base64,QR");
    expect(screen.getByText("The pass stays open until it expires or you close it.")).toBeInTheDocument();
  });

  it("uses the public URL from a loopback origin when direct access is off", async () => {
    stubFetch({ local: () => ({ body: net({ directAccess: { allowed: false, source: "setting" } }) }) });
    await open();
    expect(qr.toDataURL).toHaveBeenCalledWith("https://vault.example.com" + TOKEN_PATH, expect.anything());
  });

  it("keeps the address in the bar and never asks for the network address from a real host", async () => {
    setOrigin("https://vault.example.com");
    const fetchMock = stubFetch({});
    await open();
    expect(calls(fetchMock, (u) => u === "/api/network/local-access")).toBe(0);
    expect(qr.toDataURL).toHaveBeenCalledWith("https://vault.example.com" + TOKEN_PATH, expect.anything());
  });

  it.each([
    ["the address cannot be detected", () => ({ body: net({ url: null }) }) as Reply],
    ["the lookup fails", () => new Error("offline")],
  ])("shows the message and no QR code from a loopback origin when %s", async (_name, local) => {
    stubFetch({ local });
    await open();
    expect(screen.getByText('Your phone cannot reach "localhost". Open BlackVault on this computer by its network address, then try again.')).toBeInTheDocument();
    expect(screen.queryByAltText(/qr code/i)).toBeNull();
    expect(qr.toDataURL).not.toHaveBeenCalled();
  });

  it.each([
    ["no id", { token: "t", path: TOKEN_PATH, expiresAt: "2026-10-04T12:15:00.000Z" }],
    ["an empty id", { id: "", path: TOKEN_PATH, expiresAt: "2026-10-04T12:15:00.000Z" }],
    ["a garbage expiresAt", { id: "pass1", path: TOKEN_PATH, expiresAt: "not a date" }],
    ["no expiresAt", { id: "pass1", path: TOKEN_PATH }],
  ])("shows an error and never polls or counts down with %s in the create response", async (_name, body) => {
    const fetchMock = stubFetch({ create: () => ({ status: 201, body }) });
    await open();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not create a pass.");
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.queryByAltText(/qr code/i)).toBeNull();
    await advance(10_000);
    expect(polls(fetchMock)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still shows the link and Copy when the QR code cannot be made", async () => {
    qr.toDataURL.mockRejectedValueOnce(new Error("boom"));
    stubFetch({});
    await open();
    expect(screen.queryByAltText(/qr code/i)).toBeNull();
    expect(screen.getByText(LAN + TOKEN_PATH)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("explains a 429 when creating", async () => {
    stubFetch({ create: () => ({ status: 429, body: { error: "slow down" } }) });
    await open();
    expect(screen.getByRole("alert")).toHaveTextContent("Too many passes. Wait a minute and try again.");
    expect(screen.queryByAltText(/qr code/i)).toBeNull();
  });

  it("has an accessible dialog frame", async () => {
    stubFetch({});
    await open();
    const dialog = screen.getByRole("dialog", { name: "Continue on phone" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeInTheDocument();
  });
});

describe("CapturePassDialog, countdown", () => {
  it("counts down mm:ss from the clock and shows Pass ended. at zero without another poll", async () => {
    const fetchMock = stubFetch({
      create: () => ({ status: 201, body: { id: "pass1", token: "t", path: TOKEN_PATH, expiresAt: new Date(NOW.getTime() + 65_000).toISOString() } }),
    });
    await open();
    expect(screen.getByRole("timer")).toHaveTextContent("01:05");

    await advance(1000);
    expect(screen.getByRole("timer")).toHaveTextContent("01:04");

    await advance(2000); // 3 s: one poll
    expect(polls(fetchMock)).toBe(1);
    expect(screen.getByRole("timer")).toHaveTextContent("01:02");

    await advance(61_900); // 64.9 s: just before the end
    expect(screen.queryByText("Pass ended.")).toBeNull();
    const before = polls(fetchMock);
    await advance(100);
    expect(screen.getByText("Pass ended.")).toBeInTheDocument();
    expect(screen.queryByRole("timer")).toBeNull();
    await advance(10_000);
    expect(polls(fetchMock)).toBe(before);
  });

  it("follows the clock, not the tick count, after a stalled timer", async () => {
    stubFetch({});
    await open();
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    await advance(1000);
    expect(screen.getByRole("timer")).toHaveTextContent("04:59");
  });
});

describe("CapturePassDialog, polling", () => {
  it("shows what has arrived", async () => {
    let body: Json = { status: "open", uploadCount: 0, remaining: 50, photos: [], documents: [] };
    stubFetch({ poll: () => ({ body }) });
    await open();
    expect(screen.getByText("Nothing received yet.")).toBeInTheDocument();

    body = {
      status: "open",
      uploadCount: 2,
      remaining: 48,
      photos: [photo],
      documents: [{ id: "d1", name: "Receipt 2026-10-04", type: "RECEIPT", createdAt: "x" }],
    };
    await advance(3000);
    expect(screen.getByAltText("Front")).toHaveAttribute("src", photo.previewUrl);
    expect(screen.getByText("Receipt 2026-10-04")).toBeInTheDocument();
    expect(screen.getByText("2 received")).toBeInTheDocument();
  });

  it("polls every 3 seconds", async () => {
    const fetchMock = stubFetch({});
    await open();
    await advance(2999);
    expect(polls(fetchMock)).toBe(0);
    await advance(1);
    expect(polls(fetchMock)).toBe(1);
    await advance(3000);
    expect(polls(fetchMock)).toBe(2);
  });

  it.each(["expired", "closed", "full"])("stops polling and shows Pass ended. when the status is %s", async (status) => {
    const fetchMock = stubFetch({ poll: () => ({ body: { status, photos: [], documents: [] } }) });
    await open();
    await advance(3000);
    expect(screen.getByText("Pass ended.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New pass" })).toBeInTheDocument();
    await advance(9000);
    expect(polls(fetchMock)).toBe(1);
  });

  it.each([
    ["a network error", () => new Error("offline") as Reply],
    ["a server error", () => ({ status: 500, body: {} }) as Reply],
  ])("keeps the pass open and keeps polling after %s", async (_name, failing) => {
    let reply: () => Reply = failing;
    const fetchMock = stubFetch({ poll: () => reply() });
    await open();
    await advance(3000);
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.queryByText("Pass ended.")).toBeNull();

    reply = () => ({ status: 200, body: { status: "open", photos: [photo], documents: [] } });
    await advance(3000);
    expect(polls(fetchMock)).toBe(2);
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(screen.getByAltText("Front")).toBeInTheDocument();
  });
});

describe("CapturePassDialog, ending and leaving", () => {
  it("Close pass sends DELETE, ends the pass and stops polling", async () => {
    const fetchMock = stubFetch({});
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Close pass" }));
    await advance(0);

    expect(calls(fetchMock, (u, m) => u === "/api/capture-passes/pass1" && m === "DELETE")).toBe(1);
    expect(screen.getByText("Pass ended.")).toBeInTheDocument();
    await advance(9000);
    expect(polls(fetchMock)).toBe(0);
  });

  it("keeps the pass open and says so when Close pass fails", async () => {
    stubFetch({ del: () => ({ status: 500, body: {} }) });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Close pass" }));
    await advance(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not close the pass.");
    expect(screen.queryByText("Pass ended.")).toBeNull();
  });

  it("New pass creates another pass", async () => {
    const fetchMock = stubFetch({ poll: () => ({ body: { status: "closed", photos: [], documents: [] } }) });
    await open();
    await advance(3000);
    fireEvent.click(screen.getByRole("button", { name: "New pass" }));
    await advance(0);
    expect(calls(fetchMock, (u, m) => u === "/api/capture-passes" && m === "POST")).toBe(2);
  });

  it.each([
    ["the close button", () => fireEvent.click(screen.getByRole("button", { name: "Close dialog" }))],
    ["Escape", () => fireEvent.keyDown(document, { key: "Escape" })],
  ])("%s closes the dialog but not the pass", async (_name, act_) => {
    const fetchMock = stubFetch({});
    const onClose = await open();
    act_();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls(fetchMock, (_u, m) => m === "DELETE")).toBe(0);
  });

  it("stops every timer when it unmounts", async () => {
    const fetchMock = stubFetch({});
    await open();
    cleanup();
    await advance(20_000);
    expect(polls(fetchMock)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
