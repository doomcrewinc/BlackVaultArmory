// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuditList } from "./AuditList";
import type { AuditEventDto } from "@/lib/audit/query";

afterEach(cleanup);

function makeEvent(overrides: Partial<AuditEventDto>): AuditEventDto {
  return {
    id: "e1",
    at: "2026-09-29T12:00:00.000Z",
    actorId: "u1",
    actorName: "Jeff (@jeff)",
    actorIp: null,
    action: "CREATE",
    entityType: "Firearm",
    entityId: "f1",
    entityLabel: "Glock 19",
    changes: { name: "Glock 19" },
    ...overrides,
  };
}

describe("AuditList", () => {
  it("renders one row per event, newest first as given", () => {
    render(<AuditList events={[makeEvent({ id: "e1" }), makeEvent({ id: "e2", entityLabel: "AR-15" })]} />);
    expect(screen.getByText("Glock 19")).toBeTruthy();
    expect(screen.getByText("AR-15")).toBeTruthy();
  });

  it("shows an empty state with no events", () => {
    render(<AuditList events={[]} />);
    expect(screen.getByText(/no.*events/i)).toBeTruthy();
  });

  it("shows a Load more button when hasMore is true, and calls onLoadMore", () => {
    const onLoadMore = vi.fn();
    render(<AuditList events={[makeEvent({})]} hasMore onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("hides Load more when hasMore is false", () => {
    render(<AuditList events={[makeEvent({})]} hasMore={false} />);
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });

  it("shows a loading indicator while loading, without hiding existing rows", () => {
    render(<AuditList events={[makeEvent({})]} loading />);
    expect(screen.getByText("Glock 19")).toBeTruthy();
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });
});
