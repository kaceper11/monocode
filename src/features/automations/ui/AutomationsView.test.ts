// @vitest-environment happy-dom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AutomationsView } from "./AutomationsView";
import {
  listAutomations,
  newAutomationDraft,
  notifyAutomationsChanged,
  peekAutomations,
  type Automation,
} from "../model/automations";
import type { HarnessId } from "../../sessions/model/session";
import * as models from "../../sessions/model/models";
import { saveModelControls } from "../../settings/model/settings";
import { refreshHarnessCatalogs } from "../../../integrations/harness/core/registry";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));
vi.mock("../../../app/shell/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../../../app/shell/TitleBar", () => ({ OverlayNav: () => null }));
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
  ModelPicker: ({ harness, model, onChange }: { harness: HarnessId; model: string; onChange: (harness: HarnessId, model: string) => void }) => {
    useSyncExternalStore(models.subscribeModels, models.getModelSnapshot);
    return createElement("select", { "aria-label": "Model", value: model,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(harness, event.target.value) },
      models.modelsFor(harness).map(item => createElement("option", { key: item.id, value: item.id }, item.name)));
  },
  ModelControlPills: ({ harness, model, values, onSettingsChange }: { harness: HarnessId; model: string; values: Record<string, string>; onSettingsChange: (values: Record<string, string>) => void }) =>
    createElement("button", { type: "button", "aria-label": "Model settings",
      onClick: () => onSettingsChange({ ...values, effort: "high" }) }, models.resolveModel(harness, model).name),
}));

const ubuntu = "/projects/ubuntu-repo";
const debian = "/projects/debian-repo";
const native = "/native/repo";
const makeModel = (name: string): models.AgentModel => ({ id: `codex:${name}`, name, harness: "codex" });
let saved: Automation[];
let host: HTMLDivElement;
let root: Root;
const launch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  notifyAutomationsChanged();
  models.resetHarnessModelOverlays();
  models.setHarnessModels("codex", [makeModel("Native")]);
  models.saveLastModelChoice("codex", "codex:default");
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
async function render(cwd = ubuntu) {
  await act(async () => root.render(createElement(AutomationsView, {
    cwd, recents: [ubuntu, debian, native].map(path => ({ path, openedAt: 1 })),
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

it("discovers the provider catalog and flags a missing saved model without launching a session", async () => {
  await render();
  await click("Start from scratch");
  expect(refreshHarnessCatalogs).toHaveBeenCalledWith(["codex"]);
  await act(async () => models.setHarnessModels("codex", [makeModel("Native")]));
  await select("Model", "codex:Native");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => models.setHarnessModels("codex", [makeModel("Other")]));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("codex:Native");
  await select("Model", "codex:Other");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await select("Project", debian);
  expect(launch).not.toHaveBeenCalled();
});

it("edits and saves the existing worktree's model and settings", async () => {
  const worktree = `${ubuntu}-worktree`;
  models.setHarnessModels("codex", [makeModel("Worktree"), makeModel("Other"), makeModel("Native")]);
  saved = [{ ...newAutomationDraft(ubuntu, "codex", "codex:Worktree"),
    id: "existing", name: "Saved task", prompt: "Check files", workspaceMode: "existing", worktreeCwd: worktree,
    nextRunAt: 0, createdAt: 1, updatedAt: 1 }];
  await render();
  await click("Saved task");
  await select("Model", "codex:Other");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')!.click());
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(saved[0]).toMatchObject({ model: "codex:Other", modelSettings: { effort: "high" }, worktreeCwd: worktree });
  await click("Saved task");
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Model"]')!.value).toBe("codex:Other");
  await select("Project", native);
  await select("Model", "codex:Native");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(saved[0]).toMatchObject({ cwd: native, workspaceMode: "current", model: "codex:Native" });
  expect(saved[0].worktreeCwd).toBeFalsy();
});

it("shows the cached automation list immediately and refreshes it without a loading screen", async () => {
  const automation: Automation = {
    ...newAutomationDraft(ubuntu, "codex", "model"),
    id: "test-automation",
    name: "Daily review",
    nextRunAt: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  invoke.mockImplementation(async () => [automation]);
  await listAutomations();
  let finish!: (automations: Automation[]) => void;
  const refresh = new Promise<Automation[]>((resolve) => {
    finish = resolve;
  });
  invoke.mockImplementation(async () => refresh);
  await render();
  expect(
    host.querySelector('[aria-label="Open Daily review"]'),
  ).not.toBeNull();
  expect(host.querySelector(".animate-spin")).toBeNull();

  await act(async () => finish([{ ...automation, name: "Updated review" }]));
  expect(
    host.querySelector('[aria-label="Open Updated review"]'),
  ).not.toBeNull();
  expect(
    host.querySelector('[aria-label="Open Daily review"]'),
  ).toBeNull();
});

it("invalidates the cached list when an automation changes", async () => {
  invoke.mockImplementation(async () => []);
  await listAutomations();
  expect(peekAutomations()).toEqual([]);
  notifyAutomationsChanged();
  expect(peekAutomations()).toBeNull();
});
