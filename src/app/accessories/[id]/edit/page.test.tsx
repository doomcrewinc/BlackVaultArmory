// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import EditAccessoryPage from "./page";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, back: vi.fn() }),
  useParams: () => ({ id: "accessory-1" }),
}));

const fetchMock = vi.fn();

function stored(overrides: Record<string, unknown>) {
  return {
    id: "accessory-1",
    name: "Thing",
    manufacturer: "Maker",
    type: "SUPPRESSOR",
    quantity: 1,
    fullAutoRating: null,
    fullAutoLimitedTo: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  push.mockReset();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

async function openWith(accessory: Record<string, unknown>) {
  fetchMock.mockResolvedValueOnce({ json: async () => accessory });
  render(<EditAccessoryPage />);
  await screen.findByLabelText("Type / Slot");
}

async function submittedBody(): Promise<Record<string, unknown>> {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
  fireEvent.submit(document.querySelector("form") as HTMLFormElement);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  return JSON.parse(fetchMock.mock.calls[1][1].body as string);
}

describe("accessory edit form Full-Auto Rated field", () => {
  const limitedTo = () => screen.queryByLabelText("Rated For") as HTMLInputElement | null;

  it.each([
    ["YES", null, "YES", null],
    ["NO", null, "NO", null],
    ["LIMITED", "5.56 NATO only", "LIMITED", "5.56 NATO only"],
    [null, null, "", null],
  ])("shows the stored %s / %s", async (rating, text, selected, shownText) => {
    await openWith(stored({ fullAutoRating: rating, fullAutoLimitedTo: text }));
    expect(screen.getByLabelText("Full-Auto Rated")).toHaveValue(selected);
    if (shownText === null) expect(limitedTo()).toBeNull();
    else expect(limitedTo()).toHaveValue(shownText);
  });

  it("is absent for an optic and the payload does not carry it", async () => {
    await openWith(stored({ type: "OPTIC" }));
    expect(screen.queryByLabelText("Full-Auto Rated")).toBeNull();
    const body = await submittedBody();
    expect(body).not.toHaveProperty("fullAutoRating");
    expect(body).not.toHaveProperty("fullAutoLimitedTo");
  });

  it.each([
    ["YES", "YES", null],
    ["NO", "NO", null],
    ["", null, null],
  ])("changing Limited to %j submits %j and drops the text", async (choice, rating, text) => {
    await openWith(stored({ fullAutoRating: "LIMITED", fullAutoLimitedTo: "5.56" }));
    fireEvent.change(screen.getByLabelText("Full-Auto Rated"), { target: { value: choice } });
    expect(limitedTo()).toBeNull();
    const body = await submittedBody();
    expect(body.fullAutoRating).toBe(rating);
    expect(body.fullAutoLimitedTo).toBe(text);
  });

  it("submits an edited Limited text", async () => {
    await openWith(stored({ fullAutoRating: "LIMITED", fullAutoLimitedTo: "5.56" }));
    fireEvent.change(limitedTo() as HTMLInputElement, { target: { value: "9mm only" } });
    const body = await submittedBody();
    expect(body.fullAutoRating).toBe("LIMITED");
    expect(body.fullAutoLimitedTo).toBe("9mm only");
  });

  it("blocks the submit when the Limited text is emptied", async () => {
    await openWith(stored({ fullAutoRating: "LIMITED", fullAutoLimitedTo: "5.56" }));
    fireEvent.change(limitedTo() as HTMLInputElement, { target: { value: " " } });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(await screen.findByText("Say which rounds it is rated for full-auto fire with.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("disappears and is not submitted when the type changes away from a suppressor", async () => {
    await openWith(stored({ fullAutoRating: "LIMITED", fullAutoLimitedTo: "5.56" }));
    fireEvent.change(screen.getByLabelText("Type / Slot"), { target: { value: "OPTIC" } });
    expect(screen.queryByLabelText("Full-Auto Rated")).toBeNull();
    const body = await submittedBody();
    expect(body.type).toBe("OPTIC");
    expect(body).not.toHaveProperty("fullAutoRating");
    expect(body).not.toHaveProperty("fullAutoLimitedTo");
  });
});
