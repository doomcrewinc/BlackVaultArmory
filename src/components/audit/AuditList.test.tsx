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

  it("keeps Load more on an empty page that still has a cursor, instead of saying there are no matches", () => {
    const onLoadMore = vi.fn();
    render(<AuditList events={[]} hasMore onLoadMore={onLoadMore} emptyMessage="Nothing here." />);
    expect(screen.queryByText("Nothing here.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("after a page that added nothing but still has a cursor: the rows stay, and a line above Load more says no further match was found so far", () => {
    render(<AuditList events={[makeEvent({})]} hasMore onLoadMore={() => undefined} lastPageEmpty />);
    expect(screen.getByText("Glock 19")).toBeTruthy();
    expect(screen.getByText("No further matches in the entries searched so far.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  });

  it("no such line when the last page added rows, when there is nothing more to load, or while loading", () => {
    const { rerender } = render(<AuditList events={[makeEvent({})]} hasMore onLoadMore={() => undefined} />);
    expect(screen.queryByText(/No further matches/)).toBeNull();
    rerender(<AuditList events={[makeEvent({})]} lastPageEmpty />);
    expect(screen.queryByText(/No further matches/)).toBeNull();
    rerender(<AuditList events={[makeEvent({})]} hasMore onLoadMore={() => undefined} lastPageEmpty loading />);
    expect(screen.queryByText(/No further matches/)).toBeNull();
  });

  it("an empty FIRST page with a cursor keeps its own wording", () => {
    render(<AuditList events={[]} hasMore onLoadMore={() => undefined} lastPageEmpty />);
    expect(screen.getByText("No matches yet in the entries searched so far.")).toBeTruthy();
    expect(screen.queryByText(/No further matches/)).toBeNull();
  });

  it("says there are no matches only when an empty page has no cursor", () => {
    render(<AuditList events={[]} emptyMessage="Nothing here." />);
    expect(screen.getByText("Nothing here.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});
