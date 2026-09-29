// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsView } from "./SettingsView";

type DirectAccess = { allowed: boolean; source: "env" | "setting" };

/**
 * Stubs the two loads the page makes plus the direct-access PUT, which echoes the requested
 * value the way the real route does.
 */
function stubFetch(directAccess: DirectAccess) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings" && !init?.method) {
      return { ok: true, json: async () => ({ manualLanHost: "", timezone: "America/Denver" }) } as Response;
    }
    if (url === "/api/network/local-access") {
      return {
        ok: true,
        json: async () => ({
          ip: "10.0.0.5",
          port: "3000",
          url: "http://10.0.0.5:3000",
          isDocker: false,
          publicUrl: "https://vault.example",
          directAccess,
        }),
      } as Response;
    }
    if (url === "/api/settings/direct-access" && init?.method === "PUT") {
      const { allowDirectAccess } = JSON.parse(String(init.body));
      return { ok: true, json: async () => ({ allowed: allowDirectAccess, source: "setting" }) } as Response;
    }
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function directAccessPuts(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter(([url, init]) => url === "/api/settings/direct-access" && init?.method === "PUT");
}

async function renderLoaded(isAdmin: boolean) {
  render(<SettingsView isAdmin={isAdmin} />);
  await waitFor(() => expect(screen.getByText("Mobile Access (Local Network)")).toBeTruthy());
  // The direct-access state arrives from the second fetch.
  await waitFor(() => expect(screen.getByTestId("direct-access-state")).toBeTruthy());
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsView — direct-access control", () => {
  it("an admin sees a toggle", async () => {
    stubFetch({ allowed: false, source: "setting" });
    await renderLoaded(true);
    const toggle = screen.getByRole("switch", { name: /direct access/i });
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("a plain user sees the status read-only, with no toggle", async () => {
    stubFetch({ allowed: true, source: "setting" });
    await renderLoaded(false);
    expect(screen.queryByRole("switch", { name: /direct access/i })).toBeNull();
    expect(screen.getByTestId("direct-access-state")).toHaveTextContent("Direct access: On");
    expect(screen.getByTestId("direct-access-admins-only")).toHaveTextContent("Admins only");
  });

  it("turning it on first shows the plain-HTTP warning and does nothing until confirmed", async () => {
    const fetchMock = stubFetch({ allowed: false, source: "setting" });
    await renderLoaded(true);

    fireEvent.click(screen.getByRole("switch", { name: /direct access/i }));
    const warning = screen.getByTestId("direct-access-confirm");
    expect(warning).toHaveTextContent("http://10.0.0.5:3000");
    expect(warning).toHaveTextContent("without HTTPS. Logins over that address are sent unencrypted.");
    expect(directAccessPuts(fetchMock)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /turn on direct access/i }));
    await waitFor(() => expect(directAccessPuts(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(directAccessPuts(fetchMock)[0][1]?.body))).toEqual({ allowDirectAccess: true });
    await waitFor(() => expect(screen.getByRole("switch", { name: /direct access/i })).toHaveAttribute("aria-checked", "true"));
    expect(screen.queryByTestId("direct-access-confirm")).toBeNull();
  });

  it("cancelling the warning sends nothing", async () => {
    const fetchMock = stubFetch({ allowed: false, source: "setting" });
    await renderLoaded(true);
    fireEvent.click(screen.getByRole("switch", { name: /direct access/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByTestId("direct-access-confirm")).toBeNull();
    expect(directAccessPuts(fetchMock)).toHaveLength(0);
    expect(screen.getByRole("switch", { name: /direct access/i })).toHaveAttribute("aria-checked", "false");
  });

  it("turning it off needs no confirmation", async () => {
    const fetchMock = stubFetch({ allowed: true, source: "setting" });
    await renderLoaded(true);
    fireEvent.click(screen.getByRole("switch", { name: /direct access/i }));
    await waitFor(() => expect(directAccessPuts(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(directAccessPuts(fetchMock)[0][1]?.body))).toEqual({ allowDirectAccess: false });
    await waitFor(() => expect(screen.getByRole("switch", { name: /direct access/i })).toHaveAttribute("aria-checked", "false"));
  });

  it("when the environment forces it on, the toggle is locked with the reason", async () => {
    const fetchMock = stubFetch({ allowed: true, source: "env" });
    await renderLoaded(true);
    const toggle = screen.getByRole("switch", { name: /direct access/i });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Forced on by the server environment/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(directAccessPuts(fetchMock)).toHaveLength(0);
  });
});

describe("SettingsView — admin-only sections", () => {
  it("are read-only for a plain user, with an Admins only note and no Save", async () => {
    stubFetch({ allowed: true, source: "setting" });
    await renderLoaded(false);

    expect(screen.getByRole("button", { name: /backup now/i })).toBeDisabled();
    expect(document.getElementById("restore-file-input")).toBeDisabled();
    expect(screen.getByRole("button", { name: /include upload references/i })).toBeDisabled();
    expect(document.getElementById("backupDestinationPath")).toBeDisabled();
    expect(document.getElementById("timezone")).toBeDisabled();
    expect(document.getElementById("defaultAmmoAlertThreshold")).toBeDisabled();
    expect(document.getElementById("expiryWarningDays")).toBeDisabled();
    expect(document.getElementById("manualLanHost")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /save settings/i })).toBeNull();
    expect(screen.getAllByText("Admins only").length).toBeGreaterThanOrEqual(2);
  });

  it("are editable for an admin, with Save", async () => {
    stubFetch({ allowed: true, source: "setting" });
    await renderLoaded(true);

    expect(screen.getByRole("button", { name: /backup now/i })).not.toBeDisabled();
    expect(document.getElementById("restore-file-input")).not.toBeDisabled();
    expect(document.getElementById("timezone")).not.toBeDisabled();
    expect(document.getElementById("manualLanHost")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /save settings/i })).toBeTruthy();
    expect(screen.queryByText("Admins only")).toBeNull();
  });
});
