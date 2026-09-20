// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { prStatus, diffIndex } = vi.hoisted(() => ({ prStatus: vi.fn(), diffIndex: vi.fn() }));
vi.mock("../../../platform/tauri/fs", () => ({
  gitDiffIndex: diffIndex,
  gitPrStatus: prStatus,
  subscribeGitChanged: () => () => {},
  notifyGitChanged: () => {},
}));
vi.mock("../../../integrations/harness", () => ({}));
vi.mock("../../files/model/fileWatch", () => ({ invalidateWatchedFiles: () => {} }));
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

let container: HTMLDivElement;
let root: Root;
let serial = 0;
let cwd: string;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  cwd = `/pr-panel-test-${++serial}`;
  prStatus.mockReset();
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
const openPr = () => ({
  number: 7,
  title: "Existing PR",
  state: "open",
  url: "https://example.com/pr/7",
});
async function render() {
  await act(async () => root.render(createElement(GitChangesPanel, {
    cwd, enabled: true, onOpenFile: () => {}, onOpenAllChanges: () => {}, onOpenCommit: () => {},
  })));
}
const viewPr = () => container.querySelector('[title="View PR #7: Existing PR"]');

it("preserves the upstream GitHub PR display during refresh and remount", async () => {
  prStatus.mockResolvedValue(openPr());
  await render();
  expect(viewPr()).not.toBeNull();
  prStatus.mockReturnValue(new Promise(() => {}));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(viewPr()).not.toBeNull();
  act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(viewPr()).not.toBeNull();
});
