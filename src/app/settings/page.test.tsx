import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentUser } = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser }));
vi.mock("./SettingsView", () => ({ SettingsView: () => null }));

import SettingsPage from "./page";

beforeEach(() => getCurrentUser.mockReset());

async function isAdminProp() {
  const element = await SettingsPage();
  return (element.props as { isAdmin: boolean }).isAdmin;
}

describe("SettingsPage — passes the signed-in role to the view", () => {
  it("ADMIN → isAdmin true", async () => {
    getCurrentUser.mockResolvedValue({ id: "a", role: "ADMIN" });
    expect(await isAdminProp()).toBe(true);
  });

  it("USER → isAdmin false", async () => {
    getCurrentUser.mockResolvedValue({ id: "u", role: "USER" });
    expect(await isAdminProp()).toBe(false);
  });

  it("no session → isAdmin false", async () => {
    getCurrentUser.mockResolvedValue(null);
    expect(await isAdminProp()).toBe(false);
  });
});
