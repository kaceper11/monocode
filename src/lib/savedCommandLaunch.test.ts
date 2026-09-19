// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from "vitest";
import { prepareSavedCommandLaunch } from "./savedCommandLaunch";
import { savedCommandsSnapshot } from "./savedCommands";
import {
  pruneQueuedSavedCommands,
  savedCommandRunsSnapshot,
} from "./savedCommandRun";
const destination = { projectCwd: "/project", worktreeCwd: "/worktree" };
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    "monocode.savedCommands.v1",
    JSON.stringify({
      version: 1,
      commands: [{ id: "test", name: "Test", command: "npm test" }],
      groups: [],
    }),
  );
});
afterEach(() => pruneQueuedSavedCommands(() => false));
function request(ids = ["test"]) {
  return { ids, snapshot: savedCommandsSnapshot(), destination };
}
it("reuses queued intent on repeat clicks without creating a second terminal", () => {
  const first = prepareSavedCommandLaunch(request(), destination);
  const second = prepareSavedCommandLaunch(request(), destination);
  expect(first.files).toHaveLength(1);
  expect(second.files).toHaveLength(0);
  expect(second.focusId).toBe(first.focusId);
  expect(savedCommandRunsSnapshot()).toHaveLength(1);
  expect(first.files[0]).toMatchObject({
    terminal: true,
    cwd: "/worktree",
    projectCwd: "/project",
  });
});
it("does not reuse another project's terminal at the same working-copy path", () => {
  const first = prepareSavedCommandLaunch(request(), destination);
  const other = { projectCwd: "/another-project", worktreeCwd: "/worktree" };
  const second = prepareSavedCommandLaunch(
    { ...request(), destination: other },
    other,
  );
  expect(second.files).toHaveLength(1);
  expect(second.focusId).not.toBe(first.focusId);
});
it("checks selected project, host and stored revision before creating intent", () => {
  expect(() =>
    prepareSavedCommandLaunch(request(), {
      ...destination,
      worktreeCwd: "//wsl.localhost/Ubuntu/worktree",
    }),
  ).toThrow(/changed/);
  const stale = request();
  localStorage.setItem(
    "monocode.savedCommands.v1",
    JSON.stringify({ version: 1, commands: [], groups: [] }),
  );
  expect(() => prepareSavedCommandLaunch(stale, destination)).toThrow(
    /changed/,
  );
  expect(savedCommandRunsSnapshot()).toHaveLength(0);
});
it("validates every member before launching any part of a group", () => {
  expect(() =>
    prepareSavedCommandLaunch(request(["test", "deleted"]), destination),
  ).toThrow(/deleted/);
  expect(savedCommandRunsSnapshot()).toHaveLength(0);
});
it("prunes closed terminals that never mounted, retaining still-open queued work", () => {
  const first = prepareSavedCommandLaunch(request(), destination);
  pruneQueuedSavedCommands((id) => id === first.focusId);
  expect(savedCommandRunsSnapshot()).toHaveLength(1);
  pruneQueuedSavedCommands(() => false);
  expect(savedCommandRunsSnapshot()).toHaveLength(0);
});
