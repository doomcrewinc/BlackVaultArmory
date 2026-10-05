// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

vi.mock("./CapturePassDialog", () => ({
  CapturePassDialog: (p: { entityType: string; entityId: string; onClose: () => void }) => (
    <div data-testid="pass-dialog">
      {p.entityType}:{p.entityId}
      <button type="button" onClick={p.onClose}>
        close-dialog
      </button>
    </div>
  ),
}));

import { PhotoGallery } from "./PhotoGallery";

function dto(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    url: `/uploads/images/photos/${id}.jpg`,
    previewUrl: `/uploads/images/photos/thumbs/${id}.webp`,
    label: null,
    width: 10,
    height: 10,
    fileSize: 100,
    viaPass: false,
    createdAt: "2026-10-04T00:00:00.000Z",
    isMain: false,
    ...over,
  };
}

type Handler = (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown };

function stubFetch(photos: unknown[], handler?: Handler) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      return { ok: true, json: async () => ({ photos }) };
    }
    const r = handler!(url, init);
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 400), json: async () => r.body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mutations(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter(([, init]) => init?.method);
}

function pickFile(file: File) {
  const input = screen.getByLabelText("Choose a photo") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => refresh.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PhotoGallery listing", () => {
  it("loads photos for the item and shows their labels and the main badge", async () => {
    const fetchMock = stubFetch([dto("p1", { label: "Left side", isMain: true }), dto("p2")]);
    render(<PhotoGallery entityType="gear" entityId="g1" />);

    expect(await screen.findByText("Left side")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/photos?entityType=gear&entityId=g1");
    expect(screen.getByText("Main")).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getAllByRole("img")[0]).toHaveAttribute("loading", "lazy");
  });

  it("shows the empty state", async () => {
    stubFetch([]);
    render(<PhotoGallery entityType="kit" entityId="k1" />);
    expect(await screen.findByText("No photos yet.")).toBeTruthy();
  });

  it("gives the file input camera attributes", async () => {
    stubFetch([]);
    render(<PhotoGallery entityType="kit" entityId="k1" />);
    const input = screen.getByLabelText("Choose a photo");
    expect(input).toHaveAttribute("accept", "image/*");
    expect(input).toHaveAttribute("capture", "environment");
  });

  it.each([
    [undefined, true],
    [true, true],
    [false, false],
  ])("Continue on phone with withPhonePass=%s is shown: %s", async (withPhonePass, shown) => {
    stubFetch([]);
    render(<PhotoGallery entityType="ammo" entityId="a1" withPhonePass={withPhonePass} />);
    await screen.findByText("No photos yet.");
    expect(!!screen.queryByRole("button", { name: "Continue on phone" })).toBe(shown);
  });

  it("opens the pass dialog for this item and reloads the photos when it closes", async () => {
    const fetchMock = stubFetch([]);
    render(<PhotoGallery entityType="ammo" entityId="a1" />);
    await screen.findByText("No photos yet.");
    expect(screen.queryByTestId("pass-dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue on phone" }));
    expect(screen.getByTestId("pass-dialog")).toHaveTextContent("ammo:a1");
    const loads = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/photos?")).length;
    expect(loads()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "close-dialog" }));
    expect(screen.queryByTestId("pass-dialog")).toBeNull();
    await waitFor(() => expect(loads()).toBe(2));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("announces the item's attachments changed when the pass dialog closes", async () => {
    stubFetch([]);
    const heard = vi.fn();
    window.addEventListener("bv:item-attachments-changed", heard);
    render(<PhotoGallery entityType="ammo" entityId="a1" />);
    await screen.findByText("No photos yet.");
    fireEvent.click(screen.getByRole("button", { name: "Continue on phone" }));
    expect(heard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "close-dialog" }));

    window.removeEventListener("bv:item-attachments-changed", heard);
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({ entityType: "ammo", entityId: "a1" });
  });

  it("calls onMainChange instead of refreshing when given, on closing the pass dialog", async () => {
    stubFetch([]);
    const onMainChange = vi.fn();
    render(<PhotoGallery entityType="ammo" entityId="a1" onMainChange={onMainChange} />);
    await screen.findByText("No photos yet.");
    fireEvent.click(screen.getByRole("button", { name: "Continue on phone" }));
    fireEvent.click(screen.getByRole("button", { name: "close-dialog" }));
    expect(onMainChange).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("PhotoGallery upload", () => {
  it("posts multipart with the item and the file, adds the photo and refreshes for a new main picture", async () => {
    const fetchMock = stubFetch([], () => ({
      ok: true,
      status: 201,
      body: { photo: dto("new", { label: "Front", isMain: true }) },
    }));
    render(<PhotoGallery entityType="supply" entityId="s1" />);
    await screen.findByText("No photos yet.");

    const file = new File(["x"], "front.jpg", { type: "image/jpeg" });
    pickFile(file);
    fireEvent.change(screen.getByLabelText("Label (optional)"), { target: { value: "Front" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByText("Main")).toBeTruthy();
    const [url, init] = mutations(fetchMock)[0];
    expect(url).toBe("/api/photos");
    expect(init!.method).toBe("POST");
    const form = init!.body as FormData;
    expect(form.get("entityType")).toBe("supply");
    expect(form.get("entityId")).toBe("s1");
    expect(form.get("label")).toBe("Front");
    expect((form.get("file") as File).name).toBe("front.jpg");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
  });

  it("shows the server's error on a 400", async () => {
    stubFetch([], () => ({ ok: false, body: { error: "HEIC photos are not supported." } }));
    render(<PhotoGallery entityType="gear" entityId="g1" />);
    await screen.findByText("No photos yet.");
    pickFile(new File(["x"], "a.jpg", { type: "image/jpeg" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect((await screen.findByRole("alert")).textContent).toBe("HEIC photos are not supported.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["a file over 25 MB", { type: "image/jpeg", size: 25 * 1024 * 1024 + 1 }, "File too large. Maximum size is 25MB."],
    ["a file that is not an image", { type: "application/pdf", size: 10 }, "That file is not a picture. Choose an image file."],
  ])("rejects %s before any upload", async (_name, spec, message) => {
    const fetchMock = stubFetch([]);
    render(<PhotoGallery entityType="gear" entityId="g1" />);
    await screen.findByText("No photos yet.");
    const file = new File(["x"], "f", { type: spec.type });
    Object.defineProperty(file, "size", { value: spec.size });
    pickFile(file);
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(mutations(fetchMock)).toHaveLength(0);
  });
});

describe("PhotoGallery changes", () => {
  it("makes a photo the main picture with PATCH and refreshes", async () => {
    const fetchMock = stubFetch([dto("p1", { isMain: true }), dto("p2")], () => ({
      ok: true,
      body: { photo: dto("p2", { isMain: true }) },
    }));
    render(<PhotoGallery entityType="firearm" entityId="f1" />);
    await screen.findAllByRole("img");

    fireEvent.click(screen.getByRole("button", { name: "Make main picture" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const [url, init] = mutations(fetchMock)[0];
    expect(url).toBe("/api/photos/p2");
    expect(init!.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ main: true });
    expect(screen.getAllByText("Main")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Make main picture" })).toHaveLength(1);
  });

  it("saves an edited label with Enter", async () => {
    const fetchMock = stubFetch([dto("p1")], () => ({ ok: true, body: { photo: dto("p1", { label: "Muzzle" }) } }));
    render(<PhotoGallery entityType="firearm" entityId="f1" />);
    await screen.findAllByRole("img");

    fireEvent.click(screen.getByRole("button", { name: "Edit label" }));
    const input = screen.getByLabelText("Photo label");
    expect(input).toHaveAttribute("maxlength", "80");
    fireEvent.change(input, { target: { value: "Muzzle" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Muzzle")).toBeTruthy();
    expect(JSON.parse(mutations(fetchMock)[0][1]!.body as string)).toEqual({ label: "Muzzle" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["a main picture", true, 1],
    ["another picture", false, 0],
  ])("deletes %s after confirmation", async (_name, isMain, refreshes) => {
    const fetchMock = stubFetch([dto("p1", { isMain })], () => ({ ok: true, body: { success: true } }));
    render(<PhotoGallery entityType="accessory" entityId="a1" />);
    await screen.findAllByRole("img");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(mutations(fetchMock)).toHaveLength(0);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No photos yet.")).toBeTruthy();
    const [url, init] = mutations(fetchMock)[0];
    expect(url).toBe("/api/photos/p1");
    expect(init!.method).toBe("DELETE");
    expect(refresh).toHaveBeenCalledTimes(refreshes);
  });

  it("does not delete when the confirmation is cancelled", async () => {
    const fetchMock = stubFetch([dto("p1")], () => ({ ok: true, body: { success: true } }));
    render(<PhotoGallery entityType="accessory" entityId="a1" />);
    await screen.findAllByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mutations(fetchMock)).toHaveLength(0);
  });
});

describe("PhotoGallery full picture", () => {
  it("opens the full picture, closes on Escape and returns focus to the thumbnail", async () => {
    stubFetch([dto("p1", { label: "Top" })]);
    render(<PhotoGallery entityType="gear" entityId="g1" />);
    const opener = await screen.findByRole("button", { name: "Open picture: Top" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("img")).toHaveAttribute("src", "/uploads/images/photos/p1.jpg");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on a click outside the picture but not on the picture", async () => {
    stubFetch([dto("p1")]);
    render(<PhotoGallery entityType="gear" entityId="g1" />);
    fireEvent.click(await screen.findByRole("button", { name: /open picture/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("img"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close", hidden: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
