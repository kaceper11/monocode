// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BoardCardView } from "./BoardCard";
import { CiBadge } from "./DeliveryControls";
import type { BoardCard } from "./boardData";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("summarizes tasks and expands details without opening or dragging the card", async () => {
  const onAction = vi.fn();
  const onDragStart = vi.fn();
  const card: BoardCard = {
    id: "task:one", kind: "task", title: "Checkout", sessions: [],
    hasUpdate: false, ciTotal: 0, ciFailing: 0, ciRunning: 0, updatedAt: 0, derived: "todo",
    tickets: [{ key: "ticket", title: "Linked ticket", identifier: "TASK-1" }],
    workstreams: [{ id: "repo", projectPath: "/demo/frontend", branch: "feature/checkout", base: "main", sessionIds: [], sessions: [], ciTotal: 0, ciFailing: 0, ciRunning: 0, probeError: "Missing worktree" }],
  };
  await act(async () => root.render(createElement(BoardCardView, {
    card, column: "todo", columns: [], manual: false, pinned: false,
    dragging: false, dropTarget: false, onAction, onDragStart,
  })));
  expect(container.textContent).toContain("1 repo · 0 agents · 1 ticket");
  expect(container.textContent).toContain("Worktree needs attention");
  expect(container.textContent).not.toContain("feature/checkout");
  expect(container.textContent).not.toContain("TASK-1");
  const expand = container.querySelector<HTMLButtonElement>('[aria-label="Details for Checkout"]')!;
  await act(async () => {
    expand.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expand.click();
  });
  expect(expand.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("feature/checkout");
  expect(container.textContent).toContain("TASK-1");
  expect(onAction).not.toHaveBeenCalled();
  expect(onDragStart).not.toHaveBeenCalled();
  await act(async () => expand.click());
  expect(container.textContent).not.toContain("feature/checkout");
  await act(async () => container.querySelector<HTMLElement>('[data-board-card]')!.click());
  expect(onAction).toHaveBeenCalledWith(card, { kind: "open-task" });
});

it("keeps validation errors in the CI details with wrapping and the complete message", async () => {
  const error = `Worktree validation failed: C:\\${"long-path".repeat(60)}\nExpected branch: feature/checkout`;
  await act(async () => root.render(createElement(CiBadge, { status: { pr: null, checks: [], error }, onFix: vi.fn() })));
  expect(container.textContent).toBe("CI unavailable");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  const alert = document.querySelector('[role="alert"]')!;
  expect(alert.textContent).toBe(error);
  expect(alert.className).toContain("[overflow-wrap:anywhere]");
  expect(alert.className).toContain("whitespace-pre-wrap");
});
