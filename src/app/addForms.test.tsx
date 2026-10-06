// @vitest-environment jsdom
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import NewAccessoryPage from "./accessories/new/page";
import NewGearPage from "./gear/new/page";
import NewSupplyPage from "./supplies/new/page";

const push = vi.hoisted(() => vi.fn());
const address = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(address.query),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ id: "created-1" }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  push.mockReset();
  address.query = "";
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

type Form = {
  page: () => ReactElement;
  field: "type" | "category";
  api: string;
  genericTitle: string;
  genericSubmit: string;
  genericBack: string;
  itemPage: string;
};

const FORMS: Record<string, Form> = {
  accessory: {
    page: () => <NewAccessoryPage />,
    field: "type",
    api: "/api/accessories",
    genericTitle: "Add Accessory",
    genericSubmit: "Add Accessory",
    genericBack: "/accessories",
    itemPage: "/accessories/created-1",
  },
  gear: {
    page: () => <NewGearPage />,
    field: "category",
    api: "/api/gear",
    genericTitle: "Add Gear",
    genericSubmit: "Add Gear",
    genericBack: "/gear",
    itemPage: "/gear/item/created-1",
  },
  supply: {
    page: () => <NewSupplyPage />,
    field: "category",
    api: "/api/supplies",
    genericTitle: "Add Supply",
    genericSubmit: "Add Supply",
    genericBack: "/",
    itemPage: "/supplies/item/created-1",
  },
};

/** Opens the form at an address carrying `?section=` (or none). */
function open(form: Form, section?: string): void {
  address.query =
    section === undefined ? "" : `section=${encodeURIComponent(section)}`;
  render(form.page());
}

function optionValues(id: string): string[] {
  return Array.from(
    (document.getElementById(id) as HTMLSelectElement).options,
  ).map((option) => option.value);
}

async function submit(): Promise<Record<string, unknown>> {
  fireEvent.change(document.getElementById("name") as HTMLInputElement, {
    target: { value: "Thing" },
  });
  fireEvent.submit(document.querySelector("form") as HTMLFormElement);
  await waitFor(() => expect(push).toHaveBeenCalled());
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

describe.each(Object.keys(FORMS))("%s add form", (name) => {
  const form = FORMS[name];

  it.each([
    ["no section", undefined],
    ["an unknown section", "no-such-section"],
    ["a firearm section", "handguns"],
    [
      "a section of another kind",
      name === "accessory" ? "knives" : "magazines",
    ],
    ["a path in place of a slug", "/vault/new"],
  ])("behaves as before with %s", async (_label, section) => {
    open(form, section);
    expect(
      screen.getByRole("heading", { level: 1, name: form.genericTitle }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: form.genericSubmit }),
    ).toBeInTheDocument();
    expect(document.getElementById(form.field)).toBeInstanceOf(
      HTMLSelectElement,
    );
    expect(optionValues(form.field).length).toBeGreaterThan(5);
    await submit();
    expect(push).toHaveBeenCalledWith(form.itemPage);
    expect(
      screen.queryByRole("link", { name: /^Back to (?!Accessories|Gear)/ }),
    ).toBeNull();
  });
});

describe("accessory add form opened from a section", () => {
  it("fixes the type, titles the page and returns to the section", async () => {
    open(FORMS.accessory, "magazines");
    expect(
      screen.getByRole("heading", { level: 1, name: "Add Magazine" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add Magazine" }),
    ).toBeInTheDocument();
    expect(document.getElementById("type")).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByTestId("type-fixed")).toHaveValue("Magazine");
    expect(
      screen.getByRole("link", { name: "Back to Magazines" }),
    ).toHaveAttribute("href", "/gear/magazines");
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute(
      "href",
      "/gear/magazines",
    );
    const body = await submit();
    expect(body.type).toBe("MAGAZINE");
    expect(push).toHaveBeenCalledWith("/gear/magazines");
  });

  it("limits the type list to the section's types, preset to the first", () => {
    open(FORMS.accessory, "optics");
    expect(optionValues("type")).toEqual(["OPTIC", "OPTIC_MOUNT"]);
    expect((document.getElementById("type") as HTMLSelectElement).value).toBe(
      "OPTIC",
    );
  });

  it("offers Parts every type no other section claims", () => {
    open(FORMS.accessory, "parts");
    const values = optionValues("type");
    expect(values).toContain("STOCK");
    expect(values).not.toContain("MAGAZINE");
    expect(values).not.toContain("OPTIC");
  });

  it("shows the suppressor paperwork when the fixed type is a suppressor", () => {
    open(FORMS.accessory, "suppressors");
    expect(screen.getByTestId("type-fixed")).toHaveValue("Suppressor");
    expect(document.getElementById("nfaTransferMethod")).not.toBeNull();
  });
});

describe.each([
  ["gear", "knives", "Knife", "KNIFE", "/gear/knives"],
  ["gear", "armor", "Armor", "ARMOR", "/prep/armor"],
  ["supply", "cleaning", "Cleaning Supply", "CLEANING", "/gear/cleaning"],
  ["supply", "medical", "Medical Supply", "MEDICAL", "/prep/medical"],
] as const)(
  "%s add form opened from %s",
  (kind, slug, singular, category, returnHref) => {
    const form = FORMS[kind];

    it("fixes the category, titles the page and returns to the section", async () => {
      open(form, slug);
      expect(
        screen.getByRole("heading", { level: 1, name: `Add ${singular}` }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: `Add ${singular}` }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Category")).toHaveAttribute("readonly");
      expect(screen.getByTestId("category-fixed")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute(
        "href",
        returnHref,
      );
      expect(screen.getByRole("link", { name: /^Back to / })).toHaveAttribute(
        "href",
        returnHref,
      );
      const body = await submit();
      expect(body.category).toBe(category);
      expect(push).toHaveBeenCalledWith(returnHref);
    });
  },
);

describe("a fixed single value", () => {
  it("is found by its label and is still submitted by a hidden input", async () => {
    open(FORMS.accessory, "magazines");
    expect(screen.getByLabelText("Type / Slot")).toHaveValue("Magazine");
    const hidden = document.getElementById("type") as HTMLInputElement;
    expect(hidden.type).toBe("hidden");
    expect(hidden.name).toBe("type");
    expect(hidden.value).toBe("MAGAZINE");
    expect((await submit()).type).toBe("MAGAZINE");
  });
});

describe.each(Object.keys(FORMS))("%s add form address edge cases", (name) => {
  const form = FORMS[name];

  it.each([
    ["an empty section", "section="],
    ["a repeated section", "section=magazines&section=knives&section=armor"],
    ["the same section twice", "section=armor&section=armor"],
  ])("treats %s as no section", async (_label, query) => {
    address.query = query;
    render(form.page());
    expect(
      screen.getByRole("heading", { level: 1, name: form.genericTitle }),
    ).toBeInTheDocument();
    expect(document.getElementById(form.field)).toBeInstanceOf(
      HTMLSelectElement,
    );
    await submit();
    expect(push).toHaveBeenCalledWith(form.itemPage);
  });
});

describe("a section holding several categories", () => {
  it.each([
    ["gear", "tools-fire", ["TOOL", "FIRE", "LIGHT", "SIGNALING"]],
    ["supply", "food-water", ["FOOD", "WATER", "FILTER"]],
  ] as const)(
    "limits the %s form from %s to its values, preset to the first",
    (kind, slug, expected) => {
      open(FORMS[kind], slug);
      expect(screen.queryByTestId("category-fixed")).toBeNull();
      expect(optionValues("category").sort()).toEqual([...expected].sort());
      const select = document.getElementById("category") as HTMLSelectElement;
      expect(expected).toContain(select.value);
    },
  );
});
