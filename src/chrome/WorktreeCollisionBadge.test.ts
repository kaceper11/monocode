// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeCollisionBadge } from "./WorktreeCollisionBadge";
import type { CollisionFile } from "../lib/worktreeCollisions";

const files: CollisionFile[] = [
  {
    relative: "src/app.ts",
    peers: [
      {
        path: "/repo-wt",
        name: "feature",
        sessions: ["codex · feature work"],
      },
    ],
  },
];

function Badge(props: { files?: readonly CollisionFile[] | null }) {
  return createElement(WorktreeCollisionBadge, {
    files: props.files === undefined ? files : props.files,
  });
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document
    .querySelectorAll("body > div")
    .forEach((el) => el !== host && el.remove());
  vi.unstubAllGlobals();
});

const badge = () =>
  host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]');
const popover = () =>
  document.querySelector<HTMLElement>('[role="dialog"]');

describe("WorktreeCollisionBadge", () => {
  it("renders nothing without overlapping files", async () => {
    await act(async () => root.render(createElement(Badge, { files: null })));
    expect(badge()).toBeNull();
    await act(async () => root.render(createElement(Badge, { files: [] })));
    expect(badge()).toBeNull();
  });

  it("exposes the overlap as an accessible name with a count", async () => {
    await act(async () => root.render(createElement(Badge)));
    expect(badge()?.getAttribute("aria-label")).toBe(
      "1 file also changed in feature",
    );
    expect(badge()?.textContent).toContain("1");
  });

  it("opens a focusable dialog listing the path, sibling and session", async () => {
    await act(async () => root.render(createElement(Badge)));
    await act(async () => badge()!.click());
    const dialog = popover();
    expect(dialog?.textContent).toContain("src/app.ts");
    expect(dialog?.textContent).toContain("feature");
    expect(dialog?.textContent).toContain("codex · feature work");
    expect(dialog?.textContent).toContain("not a guaranteed conflict");
    expect(document.activeElement).toBe(dialog);
  });

  it("closes on Escape and returns focus to the badge", async () => {
    await act(async () => root.render(createElement(Badge)));
    await act(async () => badge()!.click());
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(badge());
  });

  it("closes on an outside pointer without stealing focus back", async () => {
    await act(async () => root.render(createElement(Badge)));
    await act(async () => badge()!.click());
    const outside = document.createElement("button");
    document.body.append(outside);
    await act(async () =>
      window.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
      ),
    );
    expect(popover()).toBeNull();
    outside.remove();
  });

  it("does not propagate its click to the owning row", async () => {
    const onSelect = vi.fn();
    await act(async () =>
      root.render(
        createElement(
          "div",
          { onClick: onSelect },
          createElement(Badge),
        ),
      ),
    );
    await act(async () => badge()!.click());
    expect(onSelect).not.toHaveBeenCalled();
  });
});
