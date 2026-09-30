// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuditRow } from "./AuditRow";
import { REDACTED } from "@/lib/audit/redact";
import type { AuditEventDto } from "@/lib/audit/query";

afterEach(cleanup);

const BASE: AuditEventDto = {
  id: "e1",
  at: "2026-09-29T12:00:00.000Z",
  actorId: "u1",
  actorName: "Jeff (@jeff)",
  actorIp: "10.0.0.5",
  action: "UPDATE",
  entityType: "Firearm",
  entityId: "f1",
  entityLabel: "Glock 19",
  changes: { status: ["Active", "Sold"] },
};

describe("AuditRow", () => {
  it("shows when, who, action, item label and the one-line summary, collapsed by default", () => {
    render(<AuditRow event={BASE} />);
    expect(screen.getByText(/jeff \(@jeff\)/i)).toBeTruthy();
    expect(screen.getByText("UPDATE")).toBeTruthy();
    expect(screen.getByText("Glock 19")).toBeTruthy();
    expect(screen.getByText(/status active → sold/i)).toBeTruthy();
    // Collapsed: no before/after detail rows yet.
    expect(screen.queryByText(/^Active$/)).toBeNull();
  });

  it("expands to show every changed field's before/after on click", () => {
    render(<AuditRow event={BASE} />);
    fireEvent.click(screen.getByRole("button", { name: /view/i }));
    expect(screen.getByText(/^status$/i)).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Sold")).toBeTruthy();
  });

  it("collapses again on a second click", () => {
    render(<AuditRow event={BASE} />);
    const toggle = screen.getByRole("button", { name: /view/i });
    fireEvent.click(toggle);
    expect(screen.getByText("Active")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("never reveals a redacted field's value, expanded or not", () => {
    const event: AuditEventDto = {
      ...BASE,
      changes: { serialNumber: [REDACTED, REDACTED] },
    };
    render(<AuditRow event={event} />);
    fireEvent.click(screen.getByRole("button", { name: /view/i }));
    expect(screen.queryByText(REDACTED)).toBeNull();
    // Both the summary line and the detail row say "changed" — the detail row's is the
    // lone standalone occurrence with the italic "changed" styling.
    expect(screen.getByText("changed", { selector: ".italic" })).toBeTruthy();
  });

  it("shows cascaded child counts for a DELETE with children, expanded", () => {
    const event: AuditEventDto = {
      ...BASE,
      action: "DELETE",
      changes: { name: "Glock 19", _children: { MaintenanceLog: 2 } },
    };
    render(<AuditRow event={event} />);
    expect(screen.getByText(/2 maintenance entries/i)).toBeTruthy();
  });

  it("shows a dash for a null item label", () => {
    const event: AuditEventDto = { ...BASE, entityLabel: null };
    render(<AuditRow event={event} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("shows the time of day, not just the date (Fix round 1, item 1a)", () => {
    render(<AuditRow event={BASE} />);
    expect(screen.getByText(/\d{1,2}:\d{2}\s*(AM|PM)/i)).toBeTruthy();
  });

  it("shows 'redacted', not 'changed', for a redacted field in a CREATE/DELETE snapshot (Fix round 1, item 7)", () => {
    const event: AuditEventDto = {
      ...BASE,
      action: "CREATE",
      changes: { serialNumber: REDACTED, name: "Glock 19" },
    };
    render(<AuditRow event={event} />);
    fireEvent.click(screen.getByRole("button", { name: /view/i }));
    expect(screen.getByText("redacted", { selector: ".italic" })).toBeTruthy();
    expect(screen.queryByText("changed", { selector: ".italic" })).toBeNull();
  });

  it("still shows 'changed', not 'redacted', for a redacted field in an UPDATE diff", () => {
    const event: AuditEventDto = { ...BASE, changes: { serialNumber: [REDACTED, REDACTED] } };
    render(<AuditRow event={event} />);
    fireEvent.click(screen.getByRole("button", { name: /view/i }));
    expect(screen.getByText("changed", { selector: ".italic" })).toBeTruthy();
    expect(screen.queryByText("redacted", { selector: ".italic" })).toBeNull();
  });

  it("renders a date-only field as a bare calendar day, and a timestamp field as local date + time, not raw ISO", () => {
    const event: AuditEventDto = {
      ...BASE,
      entityType: "Firearm",
      changes: {
        acquisitionDate: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
        createdAt: "2026-09-30T02:32:04.000Z",
      },
    };
    render(<AuditRow event={event} />);
    fireEvent.click(screen.getByRole("button", { name: /view/i }));
    expect(screen.queryByText(/2026-09-01T00:00:00/)).toBeNull();
    expect(screen.queryByText(/2026-09-30T02:32:04/)).toBeNull();
    expect(screen.getByText("Sep 1, 2026")).toBeTruthy();
    expect(screen.getByText(/Sep 29, 2026, 8:32\s*PM/)).toBeTruthy();
  });
});
