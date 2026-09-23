// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CiBadge } from "./DeliveryControls";
import type { WorkstreamStatus } from "./boardData";

it("shows failed checks above running ones and opens their details", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onFix = vi.fn();
  const status = {
    fetchedAt: Date.now(),
    checks: [
      {
        name: "Tests",
        state: "FAILURE",
        bucket: "fail",
        url: "https://example.com/tests",
      },
      { name: "Build", state: "PENDING", bucket: "pending", url: "" },
    ],
  } as WorkstreamStatus;
  try {
    await act(async () =>
      root.render(createElement(CiBadge, { status, onFix })),
    );
    const trigger = host.querySelector("button")!;
    expect(trigger.textContent).toContain("1 failed");
    expect(trigger.className).toContain("text-red");
    await act(async () => trigger.click());
    expect(document.body.textContent).toContain("0/2 passed");
    expect(document.querySelector('[aria-label="Open Tests"]')).not.toBeNull();
    const fix = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Fix CI with an agent"),
    )!;
    await act(async () => fix.click());
    expect(onFix).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(
        createElement(CiBadge, {
          status: { ...status, fetchedAt: Date.now() - 90_000 },
          onFix,
        }),
      ),
    );
    expect(trigger.textContent).toContain("CI unavailable");
    await act(async () => trigger.click());
    expect(document.body.textContent).not.toContain("Fix CI with an agent");
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
