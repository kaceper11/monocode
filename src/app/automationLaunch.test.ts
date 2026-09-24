// @vitest-environment happy-dom
import source from "./App.tsx?raw";
import { transpile } from "typescript";
import { expect, it, vi } from "vitest";
import { automationWorkCwd, newAutomationDraft, type Automation } from "../features/automations/model/automations";
import { newSession, type Session } from "../features/sessions/model/session";
import { wslLocation } from "../shared/lib/paths";

// Exercise the production callback, without mounting the app's background services.
const callback = source.slice(source.indexOf("  const launchAutomation = useCallback("), source.indexOf("  const ensureAutomationRecovery = useCallback("));
function fixture(connectAutomationWorkspace = vi.fn().mockResolvedValue(undefined)) {
  const sessionsRef: { current: Session[] } = { current: [] };
  const onSubmit = vi.fn().mockReturnValue(true);
  const updateAutomationRun = vi.fn().mockResolvedValue(undefined);
  const dependencies = {
    useCallback: (fn: unknown) => fn,
    automationWorkCwd, connectAutomationWorkspace, newSession, sessionsRef, onSubmit, updateAutomationRun, wslLocation,
    automationSessionReservations: { current: new Set<string>() },
    linkedWorkItemFromAutomationEvent: () => undefined,
    formatSessionTitle: (_harness: string, name: string) => name,
    setSessions: vi.fn(), appendTab: vi.fn(), focusOpenSession: vi.fn(),
    newTab: (id: string) => ({ id }),
  };
  const launch = new Function(...Object.keys(dependencies), transpile(`${callback}\nreturn launchAutomation;`))(...Object.values(dependencies));
  const automation: Automation = {
    ...newAutomationDraft("//wsl.localhost/Ubuntu/project", "codex", "codex:only-in-worktree"),
    id: "automation", workspaceMode: "existing", worktreeCwd: "//wsl.localhost/Ubuntu/child",
    modelSettings: { effort: "high" }, nextRunAt: 0, createdAt: 1, updatedAt: 1,
  };
  return { launch, automation, sessionsRef, onSubmit, updateAutomationRun, connectAutomationWorkspace };
}
it("background runs connect the selected worktree and preserve undiscovered saved models", async () => {
  const f = fixture();
  await f.launch(f.automation, { id: "run", trigger: "scheduled" });
  expect(f.connectAutomationWorkspace).toHaveBeenCalledWith(f.automation.worktreeCwd);
  expect(f.sessionsRef.current[0]).toMatchObject({
    cwd: f.automation.cwd, worktreeCwd: f.automation.worktreeCwd,
    model: "codex:only-in-worktree", modelSettings: { effort: "high" },
  });
  expect(f.onSubmit).toHaveBeenCalledTimes(1);
});
it("a failed background connection creates no session and dispatches no turn", async () => {
  const f = fixture(vi.fn().mockRejectedValue(new Error("WSL offline")));
  await expect(f.launch(f.automation, { id: "run", trigger: "scheduled" })).rejects.toThrow("WSL offline");
  expect(f.sessionsRef.current).toEqual([]);
  expect(f.onSubmit).not.toHaveBeenCalled();
  expect(f.updateAutomationRun).toHaveBeenCalledWith("run", "failed", { error: "WSL offline" });
});
