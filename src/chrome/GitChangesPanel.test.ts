// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { provider, diffIndex } = vi.hoisted(() => ({ provider: vi.fn(), diffIndex: vi.fn() }));
vi.mock("../lib/gitPrProvider", () => ({ gitPrProvider: provider }));
vi.mock("../lib/fs", () => ({
  gitDiffIndex: diffIndex,
  subscribeGitChanged: () => () => {},
  notifyGitChanged: () => {},
}));
vi.mock("../lib/harness", () => ({}));
vi.mock("../lib/fileWatch", () => ({ invalidateWatchedFiles: () => {} }));
vi.mock("../hooks/useProjectDiffStats", () => ({ applyProjectDiffStats: () => {} }));
vi.mock("./GitHistoryGraph", () => ({
  GitHistoryGraph: () => null,
  GraphResizeSash: () => null,
  GRAPH_PANEL_DEFAULT: 200,
  GRAPH_PANEL_MIN: 100,
  loadGraphPanelHeight: () => 200,
  saveGraphPanelHeight: () => {},
}));
import { GitChangesPanel } from "./GitChangesPanel";
import { AZURE_CHANGE_EVENT } from "../lib/azure";

let container: HTMLDivElement;
let root: Root;
let serial = 0;
let cwd: string;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  cwd = `/pr-panel-test-${++serial}`;
  provider.mockReset();
  diffIndex.mockResolvedValue({ branch: "feature", remote: "origin", upstream: "origin/feature", defaultBranch: "main", files: [], ahead: 0, behind: 0, aheadOfDefault: 1 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const destination = (name: "github" | "azure") => ({
  provider: name, label: `${name} destination`,
  pr: { number: 7, title: "Existing PR", state: "open", url: "https://example.com/pr/7" },
  create: vi.fn(),
});
async function render() {
  await act(async () => root.render(createElement(GitChangesPanel, {
    cwd, enabled: true, onOpenFile: () => {}, onOpenAllChanges: () => {}, onOpenCommit: () => {},
  })));
}
const viewPr = () => container.querySelector('[title="View PR #7: Existing PR"]');

it("preserves the upstream GitHub PR display during refresh and remount", async () => {
  provider.mockResolvedValue(destination("github"));
  await render();
  expect(viewPr()).not.toBeNull();
  provider.mockReturnValue(new Promise(() => {}));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(viewPr()).not.toBeNull();
  expect(container.textContent).not.toContain("github destination");
  act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(viewPr()).not.toBeNull();
});

it("invalidates the Azure destination when its connection changes", async () => {
  provider.mockResolvedValue(destination("azure"));
  await render();
  expect(viewPr()).not.toBeNull();
  expect(container.textContent).toContain("azure destination");
  provider.mockReturnValue(new Promise(() => {}));
  await act(async () => { window.dispatchEvent(new Event(AZURE_CHANGE_EVENT)); });
  expect(viewPr()).toBeNull();
  expect(container.textContent).not.toContain("azure destination");
});
