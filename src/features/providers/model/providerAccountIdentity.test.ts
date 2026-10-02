// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useProviderAccountIdentities } from "./providerAccountIdentity";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("loads each account's identity and re-reads on refresh", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const accounts = [{ id: "default", provider: "claude" as const, label: "Default" }];
  function Identity({ refresh }: { refresh?: number }) {
    const identity = useProviderAccountIdentities(accounts, refresh)["claude:default"];
    return createElement("span", null, identity?.email ?? "unknown");
  }
  try {
    vi.mocked(invoke).mockResolvedValueOnce({ email: "one@example.com" });
    await act(async () => root.render(createElement(Identity)));
    expect(container.textContent).toBe("one@example.com");
    expect(invoke).toHaveBeenCalledWith("provider_account_identity", { provider: "claude", accountId: "default" });
    vi.mocked(invoke).mockResolvedValueOnce({ email: "two@example.com" });
    await act(async () => root.render(createElement(Identity, { refresh: 1 })));
    expect(container.textContent).toBe("two@example.com");
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});
