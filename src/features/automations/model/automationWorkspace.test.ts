import { beforeEach, expect, it, vi } from "vitest";
import { automationWorkCwd, connectAutomationWorkspace } from "./automations";
import { connectWslProject } from "../../sessions/model/wsl";
vi.mock("../../sessions/model/wsl", () => ({ connectWslProject: vi.fn() }));
beforeEach(() => vi.mocked(connectWslProject).mockReset());
it("uses a selected existing worktree and the source project for a future worktree", () => {
  const target = { cwd: "//wsl.localhost/Ubuntu/repo", worktreeCwd: "//wsl.localhost/Ubuntu/child" };
  expect(automationWorkCwd({ ...target, workspaceMode: "existing" })).toBe(target.worktreeCwd);
  expect(automationWorkCwd({ ...target, workspaceMode: "worktree" })).toBe(target.cwd);
  expect(automationWorkCwd({ ...target, workspaceMode: "current" })).toBe(target.cwd);
});
it("connects a background WSL target without silently retargeting or swallowing errors", async () => {
  const cwd = "//wsl.localhost/Ubuntu/repo";
  vi.mocked(connectWslProject).mockResolvedValueOnce("//wsl$/ubuntu/repo")
    .mockResolvedValueOnce("//wsl.localhost/Ubuntu/other")
    .mockRejectedValueOnce(new Error("offline"));
  await expect(connectAutomationWorkspace(cwd)).resolves.toBeUndefined();
  await expect(connectAutomationWorkspace(cwd)).rejects.toThrow("canonical location");
  await expect(connectAutomationWorkspace(cwd)).rejects.toThrow("offline");
  vi.mocked(connectWslProject).mockClear();
  await connectAutomationWorkspace("C:/native/project");
  expect(connectWslProject).not.toHaveBeenCalled();
});
