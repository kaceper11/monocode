// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useProviderAccountIdentities } from "./providerAccountIdentity";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("never displays native identity or a late guest reply after switching hosts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const accounts = [{ id: "default", provider: "claude" as const, label: "Default" }];
  function Identity({ cwd }: { cwd?: string }) {
    const identity = useProviderAccountIdentities(accounts, undefined, cwd)["claude:default"];
    return createElement("span", null, identity?.email ?? "unknown");
  }
  let finishGuest!: (value: unknown) => void;
  try {
    vi.mocked(invoke).mockResolvedValueOnce({ email: "native@example.com" });
    await act(async () => root.render(createElement(Identity)));
    expect(container.textContent).toBe("native@example.com");
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { finishGuest = resolve; }));
    const cwd = "//wsl.localhost/Ubuntu/home/me/repo";
    await act(async () => root.render(createElement(Identity, { cwd })));
    expect(container.textContent).toBe("unknown");
    expect(invoke).toHaveBeenLastCalledWith("provider_account_identity", { provider: "claude", accountId: "default", cwd });
    vi.mocked(invoke).mockResolvedValueOnce({ email: "other@example.com" });
    await act(async () => root.render(createElement(Identity, { cwd: "//wsl.localhost/Debian/home/me/repo" })));
    await act(async () => finishGuest({ email: "old-guest@example.com" }));
    expect(container.textContent).toBe("other@example.com");
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});
