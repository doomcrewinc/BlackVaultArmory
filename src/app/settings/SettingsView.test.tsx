// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsView } from "./SettingsView";

type DirectAccess = { allowed: boolean; source: "env" | "setting" };

/**
 * Stubs the two loads the page makes plus the direct-access PUT, which echoes the requested
 * value the way the real route does.
 */
function stubFetch(
  directAccess: DirectAccess,
  { publicUrl = "https://vault.example", trustedProxiesConfigured = true }: { publicUrl?: string; trustedProxiesConfigured?: boolean } = {},
) {
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
          publicUrl,
          trustedProxiesConfigured,
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
  Object.defineProperty(window, "isSecureContext", { value: undefined, configurable: true });
});

/** jsdom doesn't implement isSecureContext (always undefined); stub it directly to test the M5 signal. */
function stubSecureContext(value: boolean) {
  Object.defineProperty(window, "isSecureContext", { value, configurable: true });
}

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

  it("turning it off first asks for confirmation — connected over another address, it says how to get back in", async () => {
    // jsdom's origin is http://localhost:3000, not the public URL: this browser uses direct access.
    const fetchMock = stubFetch({ allowed: true, source: "setting" }, { publicUrl: "https://vault.example" });
    await renderLoaded(true);

    fireEvent.click(screen.getByRole("switch", { name: /direct access/i }));
    const confirm = screen.getByTestId("direct-access-confirm");
    expect(confirm).toHaveTextContent("You're connected over this address. You'll lose access in a few seconds.");
    expect(confirm).toHaveTextContent(
      "To get back in, open https://vault.example, or set BLACKVAULT_ALLOW_DIRECT_ACCESS=true in .env and restart.",
    );
    expect(directAccessPuts(fetchMock)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /turn off direct access/i }));
    await waitFor(() => expect(directAccessPuts(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(directAccessPuts(fetchMock)[0][1]?.body))).toEqual({ allowDirectAccess: false });
    await waitFor(() => expect(screen.getByRole("switch", { name: /direct access/i })).toHaveAttribute("aria-checked", "false"));
  });

  it("turning it off from the public URL gets the shorter confirm", async () => {
    const fetchMock = stubFetch({ allowed: true, source: "setting" }, { publicUrl: window.location.origin });
    await renderLoaded(true);

    fireEvent.click(screen.getByRole("switch", { name: /direct access/i }));
    const confirm = screen.getByTestId("direct-access-confirm");
    expect(confirm).toHaveTextContent("http://10.0.0.5:3000 will stop working");
    expect(confirm).not.toHaveTextContent("You're connected over this address");
    expect(directAccessPuts(fetchMock)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(directAccessPuts(fetchMock)).toHaveLength(0);
    expect(screen.getByRole("switch", { name: /direct access/i })).toHaveAttribute("aria-checked", "true");
  });

  it("with no trusted proxy configured, the off-confirm warns there may be no other way in", async () => {
    stubFetch({ allowed: true, source: "setting" }, { publicUrl: window.location.origin, trustedProxiesConfigured: false });
    await renderLoaded(true);
    fireEvent.click(screen.getByRole("switch", { name: /direct access/i }));
    expect(screen.getByTestId("direct-access-confirm")).toHaveTextContent(
      "No trusted proxy is configured, so there may be no way in except",
    );
  });

  it("with a trusted proxy configured, the no-proxy warning is absent", async () => {
    stubFetch({ allowed: true, source: "setting" }, { publicUrl: window.location.origin, trustedProxiesConfigured: true });
    await renderLoaded(true);
    fireEvent.click(screen.getByRole("switch", { name: /direct access/i }));
    expect(screen.getByTestId("direct-access-confirm")).not.toHaveTextContent("No trusted proxy is configured");
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

describe("SettingsView — plain-HTTP warning (review M5)", () => {
  it("shows the warning when the page is not a secure context", async () => {
    stubSecureContext(false);
    stubFetch({ allowed: true, source: "setting" });
    await renderLoaded(true);
    expect(screen.getAllByText(/not using HTTPS/i).length).toBeGreaterThan(0);
  });

  it("hides the warning on a secure context (e.g. localhost, which the brief's own signal — isSecureContext — already treats as secure)", async () => {
    stubSecureContext(true);
    stubFetch({ allowed: true, source: "setting" });
    await renderLoaded(true);
    expect(screen.queryByText(/not using HTTPS/i)).toBeNull();
  });
});

describe("SettingsView — restore", () => {
  // Spec §Restore: the RESTORE audit event names the backup file. The file
  // name travels URI-encoded in X-Backup-Filename; the body is unchanged.
  it("sends the chosen file's name, URI-encoded, in X-Backup-Filename", async () => {
    const base = stubFetch({ allowed: true, source: "setting" });
    const restoreCalls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/backup/restore" && init?.method === "POST") {
          restoreCalls.push(init);
          return { ok: true, json: async () => ({ success: true, counts: {} }) } as Response;
        }
        return base(url, init);
      }),
    );
    await renderLoaded(true);

    const backup = { meta: { version: "1.1" } };
    const file = new File([JSON.stringify(backup)], "my backup (é).json", { type: "application/json" });
    fireEvent.change(document.getElementById("restore-file-input")!, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^restore$/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^restore$/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, restore/i }));

    await waitFor(() => expect(restoreCalls).toHaveLength(1));
    const headers = restoreCalls[0].headers as Record<string, string>;
    expect(headers["X-Backup-Filename"]).toBe(encodeURIComponent("my backup (é).json"));
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(restoreCalls[0].body))).toEqual(backup);
  });

  // File.name is a USVString, so browsers already replace lone surrogates; the
  // guard is defensive. If encoding ever throws, the header is dropped and the
  // restore still goes ahead.
  it("still restores when the file name cannot be URI-encoded, without the header", async () => {
    vi.stubGlobal("encodeURIComponent", () => {
      throw new URIError("URI malformed");
    });
    const base = stubFetch({ allowed: true, source: "setting" });
    const restoreCalls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/backup/restore" && init?.method === "POST") {
          restoreCalls.push(init);
          return { ok: true, json: async () => ({ success: true, counts: {} }) } as Response;
        }
        return base(url, init);
      }),
    );
    await renderLoaded(true);

    const backup = { meta: { version: "1.1" } };
    const file = new File([JSON.stringify(backup)], "backup.json", { type: "application/json" });
    fireEvent.change(document.getElementById("restore-file-input")!, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^restore$/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^restore$/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, restore/i }));

    await waitFor(() => expect(restoreCalls).toHaveLength(1));
    const headers = restoreCalls[0].headers as Record<string, string>;
    expect(headers).not.toHaveProperty("X-Backup-Filename");
    expect(JSON.parse(String(restoreCalls[0].body))).toEqual(backup);
  });

  // A plain (unsealed) file: the yellow warning shows, no passphrase field,
  // and the body sent is the plain backup JSON unchanged.
  it("warns that a plain backup file is unencrypted, and restores it without a passphrase", async () => {
    const base = stubFetch({ allowed: true, source: "setting" });
    const restoreCalls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/backup/restore" && init?.method === "POST") {
          restoreCalls.push(init);
          return { ok: true, json: async () => ({ success: true, counts: {} }) } as Response;
        }
        return base(url, init);
      }),
    );
    await renderLoaded(true);

    const backup = { meta: { version: "1.1" } };
    const file = new File([JSON.stringify(backup)], "plain-backup.json", { type: "application/json" });
    fireEvent.change(document.getElementById("restore-file-input")!, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/not encrypted/i)).toBeTruthy());
    expect(document.getElementById("restorePassphrase")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^restore$/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, restore/i }));

    await waitFor(() => expect(restoreCalls).toHaveLength(1));
    expect(JSON.parse(String(restoreCalls[0].body))).toEqual(backup);
  });

  // A sealed envelope: the passphrase field appears instead of the plain-file
  // warning, and the request wraps it as { sealed, passphrase }.
  it("detects a sealed backup file, asks for its passphrase, and sends { sealed, passphrase }", async () => {
    const base = stubFetch({ allowed: true, source: "setting" });
    const restoreCalls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/backup/restore" && init?.method === "POST") {
          restoreCalls.push(init);
          return { ok: true, json: async () => ({ success: true, counts: {} }) } as Response;
        }
        return base(url, init);
      }),
    );
    await renderLoaded(true);

    const envelope = {
      format: "blackvault-sealed-backup",
      version: 1,
      kdf: { name: "scrypt", N: 65536, r: 8, p: 1, salt: "AAAA" },
      cipher: "aes-256-gcm",
      iv: "AAAA",
      tag: "AAAA",
      data: "AAAA",
    };
    const file = new File([JSON.stringify(envelope)], "sealed-backup.json", { type: "application/json" });
    fireEvent.change(document.getElementById("restore-file-input")!, { target: { files: [file] } });

    await waitFor(() => expect(document.getElementById("restorePassphrase")).toBeTruthy());
    expect(screen.queryByText(/not encrypted/i)).toBeNull();
    // Review M4: never "current-password" — that invites a password manager
    // to offer the admin's own LOGIN password here. Browsers ignore a bare
    // autocomplete="off" on password fields, so it needs a distinctive name too.
    expect(document.getElementById("restorePassphrase")).toHaveAttribute("autocomplete", "off");
    expect(document.getElementById("restorePassphrase")).not.toHaveAttribute("name", "password");
    // The Restore button only appears once the file is parsed; disabled
    // because no passphrase has been entered yet — nothing to send to it.
    fireEvent.click(screen.getByRole("button", { name: /^restore$/i }));
    fireEvent.change(document.getElementById("restorePassphrase")!, { target: { value: "a correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: /yes, restore/i }));

    await waitFor(() => expect(restoreCalls).toHaveLength(1));
    expect(JSON.parse(String(restoreCalls[0].body))).toEqual({
      sealed: envelope,
      passphrase: "a correct horse battery",
    });
  });

  // Found via the manual browser check: after a wrong-passphrase 400 the
  // Restore button must come back (restoreStatus is "error", not "idle"),
  // or the only way to retry is re-choosing the file.
  it("lets the user retry with a different passphrase after a wrong-passphrase error", async () => {
    const base = stubFetch({ allowed: true, source: "setting" });
    const restoreCalls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/backup/restore" && init?.method === "POST") {
          restoreCalls.push(init);
          const { passphrase } = JSON.parse(String(init.body));
          if (passphrase !== "the real passphrase") {
            return { ok: false, json: async () => ({ error: "Wrong passphrase or damaged file." }) } as Response;
          }
          return { ok: true, json: async () => ({ success: true, counts: {} }) } as Response;
        }
        return base(url, init);
      }),
    );
    await renderLoaded(true);

    const envelope = {
      format: "blackvault-sealed-backup",
      version: 1,
      kdf: { name: "scrypt", N: 65536, r: 8, p: 1, salt: "AAAA" },
      cipher: "aes-256-gcm",
      iv: "AAAA",
      tag: "AAAA",
      data: "AAAA",
    };
    const file = new File([JSON.stringify(envelope)], "sealed-backup.json", { type: "application/json" });
    fireEvent.change(document.getElementById("restore-file-input")!, { target: { files: [file] } });
    await waitFor(() => expect(document.getElementById("restorePassphrase")).toBeTruthy());

    fireEvent.change(document.getElementById("restorePassphrase")!, { target: { value: "wrong one" } });
    fireEvent.click(screen.getByRole("button", { name: /^restore$/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, restore/i }));
    await waitFor(() => expect(screen.getByText("Wrong passphrase or damaged file.")).toBeTruthy());

    // The Restore button must still be there — no re-upload required.
    fireEvent.change(document.getElementById("restorePassphrase")!, { target: { value: "the real passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: /^restore$/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, restore/i }));

    await waitFor(() => expect(restoreCalls).toHaveLength(2));
    expect(JSON.parse(String(restoreCalls[1].body)).passphrase).toBe("the real passphrase");
    await waitFor(() => expect(screen.getByText(/Restore complete/i)).toBeTruthy());
  });
});

describe("SettingsView — sealed backup creation", () => {
  it("keeps the backup-creation fields as new-password (review M4 only changes the restore field)", async () => {
    stubFetch({ allowed: true, source: "setting" });
    await renderLoaded(true);
    expect(document.getElementById("backupPassphrase")).toHaveAttribute("autocomplete", "new-password");
    expect(document.getElementById("backupPassphraseConfirm")).toHaveAttribute("autocomplete", "new-password");
  });

  it("rejects a passphrase under 12 characters without calling the API", async () => {
    const base = stubFetch({ allowed: true, source: "setting" });
    const backupCalls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/backup" && init?.method === "POST") {
          backupCalls.push(init);
          return { ok: true, blob: async () => new Blob(["{}"]), headers: new Headers() } as unknown as Response;
        }
        return base(url, init);
      }),
    );
    await renderLoaded(true);

    fireEvent.change(document.getElementById("backupPassphrase")!, { target: { value: "short" } });
    fireEvent.change(document.getElementById("backupPassphraseConfirm")!, { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /backup now/i }));

    expect(screen.getByText("Passphrase must be at least 12 characters.")).toBeTruthy();
    expect(backupCalls).toHaveLength(0);
  });

  it("rejects a passphrase/confirmation mismatch without calling the API", async () => {
    const base = stubFetch({ allowed: true, source: "setting" });
    const backupCalls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/backup" && init?.method === "POST") {
          backupCalls.push(init);
          return { ok: true, blob: async () => new Blob(["{}"]), headers: new Headers() } as unknown as Response;
        }
        return base(url, init);
      }),
    );
    await renderLoaded(true);

    fireEvent.change(document.getElementById("backupPassphrase")!, { target: { value: "correct horse battery" } });
    fireEvent.change(document.getElementById("backupPassphraseConfirm")!, { target: { value: "correct horse staple" } });
    fireEvent.click(screen.getByRole("button", { name: /backup now/i }));

    expect(screen.getByText(/do not match/i)).toBeTruthy();
    expect(backupCalls).toHaveLength(0);
  });

  it("sends the passphrase and downloads the sealed envelope the server returns", async () => {
    const base = stubFetch({ allowed: true, source: "setting" });
    const backupCalls: RequestInit[] = [];
    const sealedBody = JSON.stringify({ format: "blackvault-sealed-backup", version: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/backup" && init?.method === "POST") {
          backupCalls.push(init);
          return {
            ok: true,
            blob: async () => new Blob([sealedBody]),
            headers: new Headers({ "X-Backup-Filename": "blackvault-backup-20260930.sealed.json" }),
          } as unknown as Response;
        }
        return base(url, init);
      }),
    );
    // jsdom has no createObjectURL; the download mechanics are not what this
    // test is about, so they are stubbed rather than left to throw.
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:mock"), revokeObjectURL: vi.fn() });
    await renderLoaded(true);

    fireEvent.change(document.getElementById("backupPassphrase")!, { target: { value: "correct horse battery" } });
    fireEvent.change(document.getElementById("backupPassphraseConfirm")!, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: /backup now/i }));

    await waitFor(() => expect(backupCalls).toHaveLength(1));
    expect(JSON.parse(String(backupCalls[0].body))).toEqual({ passphrase: "correct horse battery" });
    await waitFor(() => expect(screen.getByText("blackvault-backup-20260930.sealed.json")).toBeTruthy());
  });
});

describe("SettingsView - full backup panel", () => {
  const IDLE = { state: "idle", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 };
  const PASS = "correct horse battery";

  /** A status endpoint the test steps through, and a POST it can observe. */
  function stubFullBackup(statuses: object[], post: { status: number; body: object } = { status: 202, body: { jobId: "j1" } }) {
    let i = 0;
    const posts: RequestInit[] = [];
    let statusCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/backup/full/status") {
          statusCalls += 1;
          const s = statuses[Math.min(i, statuses.length - 1)];
          i += 1;
          return { ok: true, json: async () => s } as Response;
        }
        if (url === "/api/backup/full" && init?.method === "POST") {
          posts.push(init);
          return { ok: post.status < 300, status: post.status, json: async () => post.body } as Response;
        }
        throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    return { posts, statusCalls: () => statusCalls };
  }

  async function renderPanel(isAdmin = true) {
    const { FullBackupPanel } = await import("@/components/settings/FullBackupPanel");
    render(<FullBackupPanel isAdmin={isAdmin} />);
  }
  const type = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } });
  const tick = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  afterEach(() => vi.useRealTimers());

  it("is rendered inside the Settings page for an admin, with new-password fields", async () => {
    stubFetch({ allowed: false, source: "setting" });
    await renderLoaded(true);
    expect(screen.getByTestId("full-backup-panel")).toBeTruthy();
    expect(document.getElementById("fullBackupPassphrase")).toHaveAttribute("autocomplete", "new-password");
    expect(document.getElementById("fullBackupPassphraseConfirm")).toHaveAttribute("autocomplete", "new-password");
  });

  it("a mismatched confirm blocks the request", async () => {
    const { posts } = stubFullBackup([IDLE]);
    await renderPanel();
    type("fullBackupPassphrase", PASS);
    type("fullBackupPassphraseConfirm", PASS + "x");
    fireEvent.click(screen.getByRole("button", { name: /start full backup/i }));
    expect(await screen.findByText("Passphrases do not match.")).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it("a short passphrase blocks the request", async () => {
    const { posts } = stubFullBackup([IDLE]);
    await renderPanel();
    type("fullBackupPassphrase", "short");
    type("fullBackupPassphraseConfirm", "short");
    fireEvent.click(screen.getByRole("button", { name: /start full backup/i }));
    expect(await screen.findByText(/at least 12 characters\.$/, { selector: "p" })).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it("sends the passphrase, clears both fields, then shows each phase with its own bar and stops polling at the end", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = (extra: object) => ({ jobId: "j1", state: "running", ...extra });
    const stub = stubFullBackup([
      IDLE,
      run({ phase: "writing", filesDone: 2, filesTotal: 4, bytesDone: 50, bytesTotal: 100 }),
      run({ phase: "verifying", filesDone: 0, filesTotal: 4, bytesDone: 0, bytesTotal: 4000 }),
      { jobId: "j1", state: "succeeded", file: "blackvault-full-20261002-180405.bvb", files: 4, bytes: 4000, skipped: [], warnings: [] },
    ]);
    await renderPanel();
    type("fullBackupPassphrase", PASS);
    type("fullBackupPassphraseConfirm", PASS);
    fireEvent.click(screen.getByRole("button", { name: /start full backup/i }));
    await waitFor(() => expect(stub.posts).toHaveLength(1));
    expect(JSON.parse(String(stub.posts[0].body))).toEqual({ passphrase: PASS });
    expect(document.getElementById("fullBackupPassphrase")).toHaveValue("");
    expect(document.getElementById("fullBackupPassphraseConfirm")).toHaveValue("");

    await tick();
    expect(screen.getByRole("progressbar", { name: "Writing the archive" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("2 of 4 files")).toBeTruthy();

    await tick();
    // New phase, new bar: restarts at 0 under a new label rather than jumping.
    expect(screen.getByRole("progressbar", { name: "Verifying the archive" })).toHaveAttribute("aria-valuenow", "0");

    await tick();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("Backup complete")).toBeTruthy();
    expect(screen.getByText("blackvault-full-20261002-180405.bvb")).toBeTruthy();
    expect(screen.getByText(/4 files, 3\.9 KiB of uploads/)).toBeTruthy();

    const calls = stub.statusCalls();
    await tick(5000);
    expect(stub.statusCalls()).toBe(calls); // no polling once the job is done
  });

  it.each([
    [512, "512 B"],
    [5 * 1024 * 1024, "5.0 MiB"],
    [3 * 1024 * 1024 * 1024, "3.00 GiB"],
  ])("labels a %i byte backup in binary units (%s)", async (bytes, label) => {
    stubFullBackup([
      { jobId: "j1", state: "succeeded", file: "blackvault-full-20261002-180405.bvb", files: 2, bytes, skipped: [], warnings: [] },
    ]);
    await renderPanel();
    expect(await screen.findByText(new RegExp(`2 files, ${label} of uploads`))).toBeTruthy();
  });

  it("picks up a job that is already running on page load", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFullBackup([{ jobId: "j9", state: "running", phase: "writing", filesDone: 1, filesTotal: 10, bytesDone: 10, bytesTotal: 100 }]);
    await renderPanel();
    expect(await screen.findByRole("progressbar", { name: "Writing the archive" })).toHaveAttribute("aria-valuenow", "10");
    expect(screen.getByRole("button", { name: /backup running/i })).toBeDisabled();
  });

  it("a backup that skipped an unreadable file is flagged as incomplete; vanished files and warnings are shown", async () => {
    stubFullBackup([
      {
        jobId: "j1", state: "succeeded", file: "blackvault-full-20261002-180405.bvb", files: 1, bytes: 10,
        skipped: [
          { path: "files/documents/b.pdf", reason: "unreadable: EACCES", kind: "unreadable" },
          { path: "files/images/a.jpg", reason: "vanished", kind: "vanished" },
        ],
        warnings: ["The folder could not be fsynced."],
      },
    ]);
    await renderPanel();
    expect(await screen.findByText("Backup finished, but it is INCOMPLETE")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("1 file was unreadable and is NOT in this backup.");
    expect(alert).toHaveTextContent("files/documents/b.pdf");
    expect(alert).toHaveTextContent("EACCES");
    expect(screen.getByText(/1 file was deleted while the backup ran/)).toBeTruthy();
    expect(screen.getByText("files/images/a.jpg")).toBeTruthy();
    expect(screen.getByText("The folder could not be fsynced.")).toBeTruthy();
  });

  it("a failed job renders its error", async () => {
    stubFullBackup([{ jobId: "j1", state: "failed", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, error: "The backup folder /app/backups is not writable (EACCES)." }]);
    await renderPanel();
    expect(await screen.findByText(/backup folder \/app\/backups is not writable/)).toBeTruthy();
  });

  it("a 409 from the server shows its message", async () => {
    stubFullBackup([IDLE], { status: 409, body: { error: "A full backup is already running." } });
    await renderPanel();
    type("fullBackupPassphrase", PASS);
    type("fullBackupPassphraseConfirm", PASS);
    fireEvent.click(screen.getByRole("button", { name: /start full backup/i }));
    expect(await screen.findByText("A full backup is already running.")).toBeTruthy();
  });

  it("stops polling and says so when the status endpoint keeps failing (e.g. 401)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url !== "/api/backup/full/status") throw new Error(`unexpected fetch: ${url}`);
        calls += 1;
        if (calls === 1) {
          return { ok: true, json: async () => ({ jobId: "j", state: "running", phase: "writing", filesDone: 0, filesTotal: 2, bytesDone: 0, bytesTotal: 10 }) } as Response;
        }
        return { ok: false, status: 401, json: async () => ({ error: "Authentication required" }) } as Response;
      }),
    );
    await renderPanel();
    await screen.findByRole("progressbar");
    await tick(10_000);
    expect(screen.getByText(/Could not read the backup status/)).toBeTruthy();
    const after = calls;
    expect(after).toBeLessThanOrEqual(6); // 1 good + a handful of failures, not one per second forever
    await tick(10_000);
    expect(calls).toBe(after);
  });

  it("does not keep polling after a failed read when the last known state was not running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return { ok: false, status: 401, json: async () => ({}) } as Response;
      }),
    );
    await renderPanel();
    await tick(10_000);
    expect(calls).toBe(1);
  });

  it("a non-admin does not poll the status endpoint and cannot start a backup", async () => {
    const stub = stubFullBackup([IDLE]);
    await renderPanel(false);
    expect(stub.statusCalls()).toBe(0);
    expect(screen.getByRole("button", { name: /start full backup/i })).toBeDisabled();
  });
});
