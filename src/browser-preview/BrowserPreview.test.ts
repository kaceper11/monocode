// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BrowserPreview } from "./BrowserPreview";

const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: null as
    | null
    | ((event: { payload: { url: string | null; message: string } }) => void),
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    listen: async (_: string, listener: typeof api.listener) => {
      api.listener = listener;
      return api.unlisten;
    },
  }),
}));

it("controls the native page, preserves an edited address, and surfaces rejected navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  api.invoke.mockResolvedValue(undefined);
  try {
    await act(async () => root.render(createElement(BrowserPreview)));
    const button = (name: string) =>
      container.querySelector<HTMLButtonElement>(
        `button[aria-label="${name}"]`,
      )!;
    const input = container.querySelector("input")!;
    expect(button("Reload").disabled).toBe(true);
    input.blur();
    await act(async () =>
      api.listener!({
        payload: { url: "http://localhost:3000/", message: "Loaded" },
      }),
    );
    expect(input.value).toBe("http://localhost:3000/");
    expect(button("Reload").disabled).toBe(false);
    await act(async () => button("Reload").click());
    expect(api.invoke).toHaveBeenLastCalledWith("browser_preview_action", {
      action: "reload",
      url: null,
    });
    input.focus();
    await act(async () =>
      api.listener!({
        payload: { url: "http://localhost:3000/redirect", message: "Loaded" },
      }),
    );
    expect(input.value).toBe("http://localhost:3000/");
    api.invoke.mockRejectedValueOnce(
      "MonoCode's own address cannot be opened in the preview.",
    );
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(api.invoke).toHaveBeenLastCalledWith("browser_preview_action", {
      action: "navigate",
      url: "http://localhost:3000/",
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "own address",
    );
    await act(async () => button("Open externally").click());
    expect(api.invoke).toHaveBeenLastCalledWith("browser_preview_action", {
      action: "external",
      url: null,
    });
  } finally {
    await act(async () => root.unmount());
    expect(api.unlisten).toHaveBeenCalledOnce();
    container.remove();
    vi.unstubAllGlobals();
  }
});
