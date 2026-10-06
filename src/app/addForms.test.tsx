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
import { NewAccessoryForm } from "./accessories/new/NewAccessoryForm";
import { NewGearForm } from "./gear/new/NewGearForm";
import { NewSupplyForm } from "./supplies/new/NewSupplyForm";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, back: vi.fn() }),
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
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

type Form = {
  render: (section?: string | null) => ReactElement;
  field: "type" | "category";
  api: string;
  genericTitle: string;
  genericSubmit: string;
  genericBack: string;
  itemPage: string;
};

const FORMS: Record<string, Form> = {
  accessory: {
    render: (section) => <NewAccessoryForm section={section} />,
    field: "type",
    api: "/api/accessories",
    genericTitle: "Add accessory",
    genericSubmit: "Add accessory",
    genericBack: "/accessories",
    itemPage: "/accessories/created-1",
  },
  gear: {
    render: (section) => <NewGearForm section={section} />,
    field: "category",
    api: "/api/gear",
    genericTitle: "Add gear",
    genericSubmit: "Add gear",
    genericBack: "/gear",
    itemPage: "/gear/item/created-1",
  },
  supply: {
    render: (section) => <NewSupplyForm section={section} />,
    field: "category",
    api: "/api/supplies",
    genericTitle: "Add supply",
    genericSubmit: "Add supply",
    genericBack: "/",
    itemPage: "/supplies/item/created-1",
  },
};

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
    render(form.render(section));
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
    render(<NewAccessoryForm section="magazines" />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Add magazine" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add magazine" }),
    ).toBeInTheDocument();
    expect(document.getElementById("type")).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByTestId("type-fixed")).toHaveTextContent("Magazine");
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
    render(<NewAccessoryForm section="optics" />);
    expect(optionValues("type")).toEqual(["OPTIC", "OPTIC_MOUNT"]);
    expect((document.getElementById("type") as HTMLSelectElement).value).toBe(
      "OPTIC",
    );
  });

  it("offers Parts every type no other section claims", () => {
    render(<NewAccessoryForm section="parts" />);
    const values = optionValues("type");
    expect(values).toContain("STOCK");
    expect(values).not.toContain("MAGAZINE");
    expect(values).not.toContain("OPTIC");
  });

  it("shows the suppressor paperwork when the fixed type is a suppressor", () => {
    render(<NewAccessoryForm section="suppressors" />);
    expect(screen.getByTestId("type-fixed")).toHaveTextContent("Suppressor");
    expect(document.getElementById("nfaTransferMethod")).not.toBeNull();
  });
});

describe.each([
  ["gear", "knives", "knife", "KNIFE", "/gear/knives"],
  ["gear", "armor", "armor piece", "ARMOR", "/prep/armor"],
  ["supply", "cleaning", "cleaning supply", "CLEANING", "/gear/cleaning"],
  ["supply", "medical", "medical supply", "MEDICAL", "/prep/medical"],
] as const)(
  "%s add form opened from %s",
  (kind, slug, singular, category, returnHref) => {
    const form = FORMS[kind];

    it("fixes the category, titles the page and returns to the section", async () => {
      render(form.render(slug));
      expect(
        screen.getByRole("heading", { level: 1, name: `Add ${singular}` }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: `Add ${singular}` }),
      ).toBeInTheDocument();
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

describe("a section holding several categories", () => {
  it.each([
    ["gear", "tools-fire", ["TOOL", "FIRE", "LIGHT", "SIGNALING"]],
    ["supply", "food-water", ["FOOD", "WATER", "FILTER"]],
  ] as const)(
    "limits the %s form from %s to its values, preset to the first",
    (kind, slug, expected) => {
      render(FORMS[kind].render(slug));
      expect(screen.queryByTestId("category-fixed")).toBeNull();
      expect(optionValues("category").sort()).toEqual([...expected].sort());
      const select = document.getElementById("category") as HTMLSelectElement;
      expect(expected).toContain(select.value);
    },
  );
});
