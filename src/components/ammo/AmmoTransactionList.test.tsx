// @vitest-environment jsdom
/**
 * Component test for AmmoTransactionList.
 *
 * The thing worth testing here is the SIGN: a purchase must read +N and a
 * range use −N, and a correction must not be given a direction at all. The
 * direction comes from the same type sets the transactions API writes with, so
 * a row whose newQty happens to equal its previousQty still has to render
 * correctly — which is exactly what a `newQty - previousQty` shortcut would
 * get wrong, and what a node-environment test of the page could not see.
 */
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  AmmoTransactionList,
  type AmmoTransactionRow,
} from "./AmmoTransactionList";

afterEach(() => {
  cleanup();
});

function row(overrides: Partial<AmmoTransactionRow> = {}): AmmoTransactionRow {
  return {
    id: "t1",
    type: "PURCHASE",
    quantity: 500,
    previousQty: 0,
    newQty: 500,
    note: null,
    transactedAt: new Date("2026-03-04T12:00:00.000Z"),
    ...overrides,
  };
}

describe("AmmoTransactionList", () => {
  it("says so plainly when a lot has no ledger rows", () => {
    render(<AmmoTransactionList transactions={[]} />);

    expect(
      screen.getByText("No transactions logged for this lot."),
    ).toBeInTheDocument();
  });

  it("renders a purchase as a positive movement", () => {
    render(<AmmoTransactionList transactions={[row()]} />);

    expect(screen.getByText("Purchase")).toBeInTheDocument();
    expect(screen.getByText("+500")).toBeInTheDocument();
  });

  it("renders range use, transfers and expenditure as negative movements", () => {
    render(
      <AmmoTransactionList
        transactions={[
          row({ id: "a", type: "RANGE_USE", quantity: 120, previousQty: 500, newQty: 380 }),
          row({ id: "b", type: "TRANSFER_OUT", quantity: 50, previousQty: 380, newQty: 330 }),
          row({ id: "c", type: "EXPENDED", quantity: 30, previousQty: 330, newQty: 300 }),
        ]}
      />,
    );

    expect(screen.getByText("Range Use")).toBeInTheDocument();
    expect(screen.getByText("−120")).toBeInTheDocument();
    expect(screen.getByText("−50")).toBeInTheDocument();
    expect(screen.getByText("−30")).toBeInTheDocument();
  });

  it("gives a correction no direction, even when it changes nothing", () => {
    // previousQty === newQty: a `newQty - previousQty` derivation renders this
    // as a meaningless "+0" or "−0". It must read as the resulting count.
    render(
      <AmmoTransactionList
        transactions={[
          row({
            id: "d",
            type: "INVENTORY_CORRECTION",
            quantity: 300,
            previousQty: 300,
            newQty: 300,
          }),
        ]}
      />,
    );

    expect(screen.getByText("Correction")).toBeInTheDocument();
    expect(screen.getByText("= 300")).toBeInTheDocument();
    expect(screen.queryByText("+300")).not.toBeInTheDocument();
    expect(screen.queryByText("−300")).not.toBeInTheDocument();
  });

  it("shows the running count and any note alongside each row", () => {
    render(
      <AmmoTransactionList
        transactions={[
          row({ type: "RANGE_USE", quantity: 120, previousQty: 500, newQty: 380, note: "Range session abc123" }),
        ]}
      />,
    );

    expect(screen.getByText("500 → 380")).toBeInTheDocument();
    expect(screen.getByText(/Range session abc123/)).toBeInTheDocument();
  });

  it("falls back to the raw type for a value it does not know", () => {
    render(<AmmoTransactionList transactions={[row({ type: "SOMETHING_NEW" })]} />);

    expect(screen.getByText("SOMETHING_NEW")).toBeInTheDocument();
    expect(screen.getByText("= 500")).toBeInTheDocument();
  });
});
