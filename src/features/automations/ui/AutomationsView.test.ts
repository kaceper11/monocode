// @vitest-environment happy-dom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AutomationsView } from "./AutomationsView";
import { newAutomationDraft, type Automation } from "../model/automations";
import { connectWslProject } from "../../sessions/model/wsl";
import { setWslStatus } from "../../sessions/model/wslStatus";
import type { HarnessId } from "../../sessions/model/session";
import * as models from "../../sessions/model/models";
import { saveModelControls } from "../../settings/model/settings";
import { refreshHarnessCatalogs } from "../../../integrations/harness/core/registry";
import { wslLocation } from "../../../shared/lib/paths";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../../../app/shell/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../../../app/shell/TitleBar", () => ({ OverlayNav: () => null }));
vi.mock("../../sessions/model/wsl", () => ({ connectWslProject: vi.fn() }));
vi.mock("../../sessions/ui/WslBadge", () => ({ WslBadge: () => null }));
vi.mock("../../../integrations/harness/core/registry", () => ({ refreshHarnessCatalogs: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../integrations/harness/core/availability", () => ({ probeHarnessAvailability: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../skills/ui/SkillPromptField", () => ({ SkillPromptField: () => null }));
vi.mock("../../projects/ui/SearchableProjectPicker", () => ({
  SearchableProjectPicker: ({ cwd, recents, onSelectProject }: { cwd: string; recents: { path: string }[]; onSelectProject: (cwd: string) => void }) =>
    createElement("select", { "aria-label": "Project", value: cwd,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onSelectProject(event.target.value) },
      recents.map(({ path }) => createElement("option", { key: path, value: path }, path))),
}));
// The picker has its own interaction suite; exercise this view's catalog scope,
// selected value, and settings wiring against the real model store.
vi.mock("../../sessions/ui/ModelPicker", () => ({
  ModelPicker: ({ cwd, harness, model, onChange }: { cwd?: string; harness: HarnessId; model: string; onChange: (harness: HarnessId, model: string) => void }) => {
    useSyncExternalStore(models.subscribeModels, models.getModelSnapshot);
    return createElement("select", { "aria-label": "Model", "data-cwd": cwd, value: model,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(harness, event.target.value) },
      models.modelsFor(harness, cwd).map(item => createElement("option", { key: item.id, value: item.id }, item.name)));
  },
  ModelControlPills: ({ cwd, harness, model, values, onSettingsChange }: { cwd?: string; harness: HarnessId; model: string; values: Record<string, string>; onSettingsChange: (values: Record<string, string>) => void }) =>
    createElement("button", { type: "button", "aria-label": "Model settings", "data-cwd": cwd,
      onClick: () => onSettingsChange({ ...values, effort: "high" }) }, models.resolveModel(harness, model, cwd).name),
}));

const ubuntu = "//wsl.localhost/AutomationUbuntu/repo";
const debian = "//wsl.localhost/AutomationDebian/repo";
const native = "/native/repo";
const makeModel = (name: string): models.AgentModel => ({ id: `codex:${name}`, name, harness: "codex" });
let saved: Automation[];
let host: HTMLDivElement;
let root: Root;
const launch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  models.resetHarnessModelOverlays();
  models.setHarnessModels("codex", [makeModel("Native")]);
  models.saveLastModelChoice("codex", "codex:default", ubuntu);
  saveModelControls("beside");
  saved = [];
  launch.mockReset();
  vi.mocked(refreshHarnessCatalogs).mockClear();
  vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
    if (command === "automations_list") return saved;
    if (command === "automation_runs_list") return [];
    if (command === "automations_upsert") {
      const automation = (args as { automation: Automation }).automation;
      saved = [{ ...automation, id: automation.id || "saved", createdAt: 1, updatedAt: 1 }];
      return saved[0];
    }
    return { connected: false };
  });
  for (const distribution of ["AutomationUbuntu", "AutomationDebian"]) setWslStatus(distribution, { state: "unknown" });
  vi.mocked(connectWslProject).mockReset().mockImplementation(async cwd => {
    setWslStatus(wslLocation(cwd)!.distribution, { state: "connected" });
    return cwd;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  models.resetHarnessModelOverlays();
  localStorage.clear();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(createElement(AutomationsView, {
    cwd: ubuntu, recents: [ubuntu, debian, native].map(path => ({ path, openedAt: 1 })),
    onClose: vi.fn(), onLaunch: launch, onOpenSession: vi.fn(),
  })));
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(button => button.textContent?.includes(text));
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
async function select(label: string, value: string) {
  const input = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => { input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); });
}

it("discovers against the draft's WSL project and switches catalogs without launching a session", async () => {
  await render();
  await click("Start from scratch");
  expect(connectWslProject).toHaveBeenCalledWith(ubuntu, expect.any(AbortSignal));
  expect(refreshHarnessCatalogs).toHaveBeenCalledWith(["codex"], ubuntu);
  await act(async () => {
    models.setHarnessModels("codex", [makeModel("Ubuntu")], ubuntu);
    models.setHarnessModels("codex", [makeModel("Debian")], debian);
  });
  expect(host.querySelector('[aria-label="Model"]')?.textContent).toBe("Ubuntu");
  await select("Model", "codex:Ubuntu");
  await select("Project", debian);
  expect(host.querySelector('[aria-label="Model"]')?.textContent).toBe("Debian");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("codex:Ubuntu");
  await select("Model", "codex:Debian");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[aria-label="Model settings"]')?.getAttribute("data-cwd")).toBe(debian);
  expect(refreshHarnessCatalogs).toHaveBeenCalledWith(["codex"], debian);
  await select("Project", native);
  expect(host.querySelector('[aria-label="Model"]')?.textContent).toBe("Native");
  expect(launch).not.toHaveBeenCalled();
});

it("waits for connection, exposes failure and retries without losing the draft", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(connectWslProject).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  await render();
  await click("Start from scratch");
  expect(refreshHarnessCatalogs).not.toHaveBeenCalled();
  await act(async () => fail(new Error("WSL unavailable")));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("WSL unavailable");
  await click("Retry");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(refreshHarnessCatalogs).toHaveBeenCalledWith(["codex"], ubuntu);
});

it("ignores an abandoned target's late result", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(connectWslProject).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  await render();
  await click("Start from scratch");
  const signal = vi.mocked(connectWslProject).mock.calls[0][1]!;
  await select("Project", native);
  expect(signal.aborted).toBe(true);
  await act(async () => fail(new Error("old connection")));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(refreshHarnessCatalogs).not.toHaveBeenCalledWith(["codex"], ubuntu);
});

it("edits and saves the existing worktree's model and settings without native substitution", async () => {
  const worktree = `${ubuntu}-worktree`;
  models.setHarnessModels("codex", [makeModel("Worktree"), makeModel("Other")], worktree);
  saved = [{ ...newAutomationDraft(ubuntu, "codex", "codex:Worktree"),
    id: "existing", name: "Saved WSL task", prompt: "Check files", workspaceMode: "existing", worktreeCwd: worktree,
    nextRunAt: 0, createdAt: 1, updatedAt: 1 }];
  await render();
  await click("Saved WSL task");
  expect(connectWslProject).toHaveBeenCalledWith(worktree, expect.any(AbortSignal));
  expect(host.querySelector('[aria-label="Model"]')?.getAttribute("data-cwd")).toBe(worktree);
  await select("Model", "codex:Other");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')!.click());
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(saved[0]).toMatchObject({ model: "codex:Other", modelSettings: { effort: "high" }, worktreeCwd: worktree });
  await click("Saved WSL task");
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Model"]')!.value).toBe("codex:Other");
  await select("Project", native);
  expect(host.querySelector('[aria-label="Model"]')?.getAttribute("data-cwd")).toBe(native);
  await select("Model", "codex:Native");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(saved[0]).toMatchObject({ cwd: native, workspaceMode: "current", model: "codex:Native" });
  expect(saved[0].worktreeCwd).toBeFalsy();
});
