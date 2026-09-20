import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const { view } = vi.hoisted(() => ({ view: vi.fn(() => null) }));
vi.mock("../../source-control/ui/UnifiedDiffView", () => ({ UnifiedDiffView: view }));
import { InboxPrDiff } from "./InboxPrDiff";

it("preserves the provider's full GitHub totals when the loaded patch is truncated", () => {
  renderToStaticMarkup(createElement(InboxPrDiff, { diff: {
    patch: "", files: [], additions: 125, deletions: 42, truncated: true,
  } }));
  expect(view).toHaveBeenLastCalledWith(expect.objectContaining({
    totals: { additions: 125, deletions: 42 }, truncated: true,
  }), undefined);
});

it("passes Azure DevOps totals through unchanged", () => {
  renderToStaticMarkup(createElement(InboxPrDiff, { diff: {
    patch: "", files: [], additions: 3, deletions: 2, truncated: false,
  } }));
  expect(view).toHaveBeenLastCalledWith(expect.objectContaining({
    totals: { additions: 3, deletions: 2 }, truncated: false,
  }), undefined);
});
