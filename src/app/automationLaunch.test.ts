// @vitest-environment happy-dom
import source from "./App.tsx?raw";
import { transpile } from "typescript";
import { expect, it, vi } from "vitest";
import { automationWorkCwd, newAutomationDraft, type Automation } from "../features/automations/model/automations";
import { newSession, type Session } from "../features/sessions/model/session";
import { submitWithSettlement } from "./model/managedSubmission";

// Exercise the production callback, without mounting the app's background services.
const callback = source.slice(source.indexOf("  const launchAutomation = useCallback("), source.indexOf("  const launchQuickSession = useCallback("));
function fixture() {
  const sessionsRef: { current: Session[] } = { current: [] };
  const submitSession = vi.fn().mockReturnValue(true);
  const updateAutomationRun = vi.fn().mockResolvedValue(undefined);
  const dependencies = {
    useCallback: (fn: unknown) => fn,
    automationWorkCwd, newSession, sessionsRef, submitSession, submitWithSettlement, updateAutomationRun,
    automationSessionReservations: { current: new Set<string>() },
    linkedWorkItemFromAutomationEvent: () => undefined,
    formatSessionTitle: (_harness: string, name: string) => name,
    onSaveDraft: vi.fn(),
    setSessions: vi.fn(), appendTab: vi.fn(), focusOpenSession: vi.fn(),
    newTab: (id: string) => ({ id }),
    useQuickComposerLaunches: () => undefined,
  };
  const launch = new Function(...Object.keys(dependencies), transpile(`${callback}\nreturn launchAutomation;`))(...Object.values(dependencies));
  const automation: Automation = {
    ...newAutomationDraft("/home/me/project", "codex", "codex:only-in-worktree"),
    id: "automation", workspaceMode: "existing", worktreeCwd: "/home/me/child",
    modelSettings: { effort: "high" }, nextRunAt: 0, createdAt: 1, updatedAt: 1,
  };
  return { launch, automation, sessionsRef, submitSession, updateAutomationRun };
}
it("background runs keep the selected worktree and preserve undiscovered saved models", async () => {
  const f = fixture();
  await f.launch(f.automation, { id: "run", trigger: "scheduled" });
  expect(f.sessionsRef.current[0]).toMatchObject({
    cwd: f.automation.cwd, worktreeCwd: f.automation.worktreeCwd,
    model: "codex:only-in-worktree", modelSettings: { effort: "high" },
  });
  expect(f.submitSession).toHaveBeenCalledTimes(1);
});
it("a rejected background submission marks the run failed", async () => {
  const f = fixture();
  f.submitSession.mockImplementation(() => {
    throw new Error("launch failed");
  });
  await f.launch(f.automation, { id: "run", trigger: "scheduled" });
  expect(f.updateAutomationRun).toHaveBeenCalledWith("run", "failed", {
    error: "launch failed",
    sessionId: f.sessionsRef.current[0].id,
  });
});
