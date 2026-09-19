import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const { view } = vi.hoisted(() => ({ view: vi.fn(() => null) }));
vi.mock("./UnifiedDiffView", () => ({ UnifiedDiffView: view }));
import { InboxPrDiff } from "./InboxPrDiff";

it("preserves the provider's full GitHub totals when the loaded patch is truncated", () => {
  renderToStaticMarkup(createElement(InboxPrDiff, { diff: {
    patch: "", files: [], additions: 125, deletions: 42, truncated: true,
  } }));
  expect(view).toHaveBeenLastCalledWith(expect.objectContaining({
    totals: { additions: 125, deletions: 42 }, truncated: true,
  }), undefined);
});

it("derives Azure totals from its loaded file contents", () => {
  renderToStaticMarkup(createElement(InboxPrDiff, { diff: {
    items: [{ path: "a.ts", original: "old\n", modified: "new\n" }],
    nextSkip: null, revision: "rev-a", truncated: false,
  } }));
  expect(view).toHaveBeenLastCalledWith(expect.objectContaining({
    totals: { additions: 1, deletions: 1 }, truncated: false,
  }), undefined);
});
