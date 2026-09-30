// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AuditFilters, EMPTY_AUDIT_FILTERS, type AuditFiltersState } from "./AuditFilters";
import { ACTION_GROUPS } from "@/lib/audit/query";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubUsersFetch(users: { id: string; displayName: string; username: string }[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ users }) })),
  );
}

describe("AuditFilters", () => {
  it("fetches the user list and lists each one in the user filter", async () => {
    stubUsersFetch([{ id: "u1", displayName: "Jeff", username: "jeff" }]);
    render(<AuditFilters value={EMPTY_AUDIT_FILTERS} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /jeff/i })).toBeTruthy());
  });

  it("calls onChange with the selected action group", async () => {
    stubUsersFetch();
    const onChange = vi.fn();
    render(<AuditFilters value={EMPTY_AUDIT_FILTERS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/action/i), { target: { value: "deletes" } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_AUDIT_FILTERS, action: "deletes" });
  });

  it("calls onChange with the selected item type", async () => {
    stubUsersFetch();
    const onChange = vi.fn();
    render(<AuditFilters value={EMPTY_AUDIT_FILTERS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/item type/i), { target: { value: "Firearm" } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_AUDIT_FILTERS, type: "Firearm" });
  });

  it("calls onChange with the date range", async () => {
    stubUsersFetch();
    const onChange = vi.fn();
    render(<AuditFilters value={EMPTY_AUDIT_FILTERS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: "2026-01-01" } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_AUDIT_FILTERS, from: "2026-01-01" });
    fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: "2026-01-31" } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_AUDIT_FILTERS, to: "2026-01-31" });
  });

  it("debounces the name search before calling onChange", async () => {
    vi.useFakeTimers();
    stubUsersFetch();
    const onChange = vi.fn();
    render(<AuditFilters value={EMPTY_AUDIT_FILTERS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/search/i), { target: { value: "glock" } });
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_AUDIT_FILTERS, q: "glock" });
  });

  it("offers exactly the action groups query.ts's ACTION_GROUPS defines, never a stale hardcoded copy", async () => {
    stubUsersFetch();
    render(<AuditFilters value={EMPTY_AUDIT_FILTERS} onChange={() => {}} />);
    const options = screen.getByLabelText(/^action$/i).querySelectorAll("option");
    const values = Array.from(options)
      .map((o) => (o as HTMLOptionElement).value)
      .filter(Boolean);
    expect(values.sort()).toEqual(Object.keys(ACTION_GROUPS).sort());
  });

  it("includes User (security events) in the item-type filter, Title Cased like the other options (Fix round 1, item 10)", async () => {
    stubUsersFetch();
    render(<AuditFilters value={EMPTY_AUDIT_FILTERS} onChange={() => {}} />);
    const typeSelect = screen.getByLabelText(/item type/i);
    expect(within(typeSelect).getByRole("option", { name: "User" })).toBeTruthy();
    expect(within(typeSelect).getByRole("option", { name: "Ammo Stock" })).toBeTruthy();
    expect(within(typeSelect).queryByRole("option", { name: "ammo stock" })).toBeNull();
  });

  it("reflects the current value back into each control", () => {
    stubUsersFetch();
    const value: AuditFiltersState = { ...EMPTY_AUDIT_FILTERS, action: "edits", type: "Firearm", q: "glock" };
    render(<AuditFilters value={value} onChange={() => {}} />);
    expect(screen.getByLabelText(/action/i)).toHaveValue("edits");
    expect(screen.getByLabelText(/item type/i)).toHaveValue("Firearm");
    expect(screen.getByLabelText(/search/i)).toHaveValue("glock");
  });
});
