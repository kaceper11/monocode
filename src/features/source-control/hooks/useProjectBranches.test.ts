// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useProjectBranchesState } from "./useProjectBranches";
import { gitBranches } from "../../../platform/tauri/fs";

let changed: () => void;
vi.mock("../../../platform/tauri/fs", () => ({
  gitBranches: vi.fn(), subscribeGitChanged: (listener: () => void) => { changed = listener; return () => {}; },
}));
it("reloads after a fetch invalidates an in-flight branch read", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  let finish!: (value: Awaited<ReturnType<typeof gitBranches>>) => void;
  vi.mocked(gitBranches).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ current: "main", branches: [{ name: "fresh", remote: "origin", current: false }] });
  const host = document.createElement("div");
  const root = createRoot(host);
  const View = () => createElement("div", null, useProjectBranchesState("/refresh-race", true).branches?.branches.map(b => b.name).join(","));
  try {
    await act(async () => root.render(createElement(View)));
    await act(async () => changed());
    await act(async () => finish({ current: "main", branches: [] }));
    expect(gitBranches).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("fresh");
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
