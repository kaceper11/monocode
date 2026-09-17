// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { Popover } from "./Popover";
import { LAYER } from "../lib/layers";
import { Modal, ModalPanel } from "./Modal";

describe("ModalPanel", () => {
  it("names the dialog and close action", () => {
    const markup = renderToStaticMarkup(
      createElement(ModalPanel, {
        title: "Example",
        description: "A reusable shell",
        onClose: vi.fn(),
        children: "Body",
      }),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("modal-panel");
    expect(markup).toContain("Example");
    expect(markup).toContain("A reusable shell");
    expect(markup).toContain("Body");
    expect(markup).toContain('aria-label="Close"');
  });

  it("can preserve an accessible title with a minimal visual header", () => {
    const markup = renderToStaticMarkup(
      createElement(ModalPanel, {
        title: "Authentication required",
        description: "Sign in to continue.",
        minimalHeader: true,
        onClose: vi.fn(),
        children: "Provider login",
      }),
    );

    expect(markup).toContain('class="sr-only"');
    expect(markup).toContain("Authentication required");
    expect(markup).toContain("Provider login");
  });
});


it("keeps dialog menus and flyouts above the dialog and dismisses the menu first", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  function Menu() {
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(true);
    return createElement("div", null,
      createElement("button", { ref: anchor }, "Project"),
      open && createElement(Popover, { anchor, onDismiss: () => setOpen(false), "aria-label": "Projects" }, "Projects"),
      open && createElement(Popover, { anchor, layer: LAYER.submenu, "aria-label": "Flyout" }, "Flyout"),
    );
  }
  try {
    await act(async () => root.render(createElement(Modal, { title: "Choose", onClose, children: createElement(Menu) })));
    expect(document.querySelector('[aria-label="Projects"]')?.parentElement?.style.zIndex).toBe("91");
    expect(document.querySelector('[aria-label="Flyout"]')?.parentElement?.style.zIndex).toBe("92");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector('[aria-label="Projects"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
