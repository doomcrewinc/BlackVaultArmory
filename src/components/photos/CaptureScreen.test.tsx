// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CaptureScreen } from "./CaptureScreen";

const TOKEN = "tok-secret-123";
type Reply = { status: number; body?: Record<string, unknown> } | Error;

/** First reply answers the info GET, the rest answer uploads in order (the last repeats). */
function stubFetch(info: Reply, uploads: Reply[] = []) {
  let n = 0;
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const isUpload = init?.method === "POST";
    const reply = isUpload ? uploads[Math.min(n++, uploads.length - 1)] : info;
    if (reply instanceof Error) throw reply;
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body ?? {} };
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const INFO: Reply = { status: 200, body: { itemName: "Glock 19", entityType: "firearm", remaining: 12 } };
const SENT = (remaining: number): Reply => ({ status: 201, body: { kind: "photo", id: "x", remaining } });

const uploadCalls = (m: ReturnType<typeof stubFetch>) => m.mock.calls.filter(([, i]) => i?.method === "POST");
const formOf = (call: unknown[]) => (call[1] as RequestInit).body as FormData;

async function ready() {
  render(<CaptureScreen token={TOKEN} />);
  await screen.findByRole("heading", { name: "Glock 19" });
}

function pick(name = "shot.jpg", type = "image/jpeg", size = 10) {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  fireEvent.change(screen.getByLabelText("Choose a file"), { target: { files: [file] } });
  return file;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CaptureScreen, loading the pass", () => {
  it.each([
    [{ status: 404, body: { error: "This link is not valid." } }, "This link is not valid."],
    [{ status: 410, body: { error: "This pass was closed. Make a new one on the computer.", reason: "closed" } }, "This pass was closed. Make a new one on the computer."],
    [{ status: 429, body: { error: "x" } }, "Too many attempts. Wait a moment and try again."],
    [new Error("offline"), "Could not load. Check your connection and retry."],
  ] as [Reply, string][])("shows the message for %#", async (reply, message) => {
    stubFetch(reply);
    render(<CaptureScreen token={TOKEN} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("button", { name: "Photo" })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("offers Retry only where trying again can help", async () => {
    stubFetch({ status: 429 });
    render(<CaptureScreen token={TOKEN} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    cleanup();
    stubFetch({ status: 404 });
    render(<CaptureScreen token={TOKEN} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows the item name, the uploads left and two large buttons, and calls only the capture endpoint", async () => {
    const fetchMock = stubFetch(INFO);
    await ready();
    expect(screen.getByText("12 uploads left")).toBeInTheDocument();
    for (const name of ["Photo", "Paperwork"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-16", "w-full");
    }
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([`/api/capture/${TOKEN}`]);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says 1 upload left in the singular", async () => {
    stubFetch({ status: 200, body: { itemName: "Glock 19", remaining: 1 } });
    await ready();
    expect(screen.getByText("1 upload left")).toBeInTheDocument();
  });

  it("opens the camera input for either button", async () => {
    stubFetch(INFO);
    await ready();
    const input = screen.getByLabelText("Choose a file") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "Photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Paperwork" }));
    expect(click).toHaveBeenCalledTimes(2);
    expect(input).toHaveAttribute("accept", "image/*");
    expect(input).toHaveAttribute("capture", "environment");
  });
});

describe("CaptureScreen, sending", () => {
  it("posts a photo with its label, updates the count and resets the form", async () => {
    const fetchMock = stubFetch(INFO, [SENT(11)]);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Photo" }));
    const file = pick();
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "  Left side " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("Sent");
    const [url, init] = uploadCalls(fetchMock)[0] as [string, RequestInit];
    expect(url).toBe(`/api/capture/${TOKEN}/upload`);
    const form = init.body as FormData;
    expect(form.get("kind")).toBe("photo");
    expect(form.get("label")).toBe("Left side");
    expect(form.get("file")).toBe(file);
    expect(screen.getByText("11 uploads left")).toBeInTheDocument();
    expect(screen.queryByLabelText("Label")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("posts paperwork with its type, Receipt by default", async () => {
    const fetchMock = stubFetch(INFO, [SENT(11), SENT(10)]);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Paperwork" }));
    pick("a.jpg");
    expect(screen.getByLabelText("Type")).toHaveValue("RECEIPT");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Receipt", "NFA Tax Stamp", "Photo", "Other"]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(uploadCalls(fetchMock)).toHaveLength(1));
    expect(formOf(uploadCalls(fetchMock)[0]).get("kind")).toBe("paperwork");
    expect(formOf(uploadCalls(fetchMock)[0]).get("docType")).toBe("RECEIPT");
    expect(formOf(uploadCalls(fetchMock)[0]).has("label")).toBe(false);

    await screen.findByText("Sent");
    fireEvent.click(screen.getByRole("button", { name: "Paperwork" }));
    pick("b.jpg");
    expect(screen.getByLabelText("Type")).toHaveValue("RECEIPT");
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "NFA_TAX_STAMP" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(uploadCalls(fetchMock)).toHaveLength(2));
    expect(formOf(uploadCalls(fetchMock)[1]).get("docType")).toBe("NFA_TAX_STAMP");
  });

  it("shows a busy state while a send is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        await gate;
        return { ok: true, status: 201, json: async () => ({ remaining: 3 }) };
      }
      return { ok: true, status: 200, json: async () => ({ itemName: "Glock 19", remaining: 4 }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Photo" }));
    pick();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sending…");
    release();
    await screen.findByText("Sent");
    expect(screen.queryByText("Sending…")).toBeNull();
  });

  it.each([
    ["a network failure", new Error("offline"), "Could not send. Check your connection and retry."],
    ["a rate limit", { status: 429, body: { error: "rate" } }, "Too many attempts. Wait a moment and try again."],
    ["a server message", { status: 400, body: { error: "That is not a picture." } }, "That is not a picture."],
  ] as [string, Reply, string][])("keeps the file after %s and Retry re-sends the same file and fields", async (_n, failure, message) => {
    const fetchMock = stubFetch(INFO, [failure, SENT(9)]);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Photo" }));
    const file = pick();
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Rear" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(`Failed — ${message}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Sent");

    const calls = uploadCalls(fetchMock);
    expect(calls).toHaveLength(2);
    expect(formOf(calls[1]).get("file")).toBe(file);
    expect(formOf(calls[1]).get("label")).toBe("Rear");
    expect(screen.getByText("9 uploads left")).toBeInTheDocument();
  });

  it("replaces the buttons with the server's message when the pass ends during the visit", async () => {
    stubFetch(INFO, [{ status: 410, body: { error: "This pass has expired. Make a new one on the computer.", reason: "expired" } }]);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Photo" }));
    pick();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This pass has expired. Make a new one on the computer.");
    expect(screen.queryByRole("button", { name: "Photo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Paperwork" })).toBeNull();
  });

  it("rejects a file over 25MB before sending", async () => {
    const fetchMock = stubFetch(INFO);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Photo" }));
    pick("big.jpg", "image/jpeg", 25 * 1024 * 1024 + 1);
    expect(screen.getByRole("alert")).toHaveTextContent("File too large. Maximum size is 25MB.");
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(uploadCalls(fetchMock)).toHaveLength(0);
  });

  it("says the pass is full at zero uploads left and hides the buttons", async () => {
    stubFetch(INFO, [SENT(0)]);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Photo" }));
    pick();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("This pass is full. Make a new one on the computer.");
    expect(screen.queryByRole("button", { name: "Photo" })).toBeNull();
  });

  it("Cancel drops the chosen file without sending", async () => {
    const fetchMock = stubFetch(INFO);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Photo" }));
    pick();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(uploadCalls(fetchMock)).toHaveLength(0);
  });

  it("never shows the token on screen", async () => {
    stubFetch(INFO, [new Error(`offline ${TOKEN}`)]);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Photo" }));
    pick();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/Failed/);
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
