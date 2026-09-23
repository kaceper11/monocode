// @vitest-environment happy-dom
import source from "./App.tsx?raw";
import { transpile } from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as models from "../features/sessions/model/models";
import * as sessions from "../features/sessions/model/session";
import * as handoff from "../features/sessions/model/handoff";
import { dropContextWindow } from "../features/sessions/model/contextUsage";

// Exercise the actual App callback without mounting unrelated app services.
const choice = source.slice(
  source.indexOf("function withHarnessChoice("),
  source.indexOf("function withPlanBuildTarget("),
);
const callback = source.slice(
  source.indexOf("  const onModelChange = useCallback("),
  source.indexOf("  const onModelSettingsChange = useCallback("),
);

afterEach(() => {
  models.resetHarnessModelOverlays();
  localStorage.clear();
});

it.each([false, true])(
  "keeps a WSL model selection (worktree: %s)",
  (worktree) => {
    const cwd = "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo";
    const worktreeCwd = `${cwd}-worktree`;
    const targetCwd = worktree ? worktreeCwd : cwd;
    const model: models.AgentModel = {
      id: "codex:gpt-wsl",
      name: "GPT WSL",
      harness: "codex",
      settings: [
        {
          id: "effort",
          label: "Reasoning",
          kind: "select",
          value: "high",
          options: [{ value: "high", label: "High" }],
        },
      ],
    };
    models.setHarnessModels("codex", [
      { id: "codex:gpt-native", name: "GPT Native", harness: "codex" },
    ]);
    let state = [sessions.newSession("codex", cwd)];
    if (worktree) state[0].worktreeCwd = worktreeCwd;
    models.setHarnessModels("codex", [model], targetCwd);
    const dependencies = {
      ...models,
      ...sessions,
      ...handoff,
      dropContextWindow,
      useCallback: (fn: unknown) => fn,
      sessionsRef: { current: state },
      setSessions: (
        update: (prev: sessions.Session[]) => sessions.Session[],
      ) => {
        state = update(state);
      },
      forgetHarnessSession: vi.fn(),
    };
    const onModelChange = new Function(
      ...Object.keys(dependencies),
      transpile(`${choice}\n${callback}\nreturn onModelChange;`),
    )(...Object.values(dependencies));

    onModelChange(state[0].id, "codex", model.id);

    expect(state[0].model).toBe(model.id);
    expect(state[0].modelSettings).toEqual({ effort: "high" });
    expect(models.resolveModel("codex", state[0].model, targetCwd).name).toBe(
      "GPT WSL",
    );
    expect(models.loadRecentModelChoices()[0]).toMatchObject({
      model: model.id,
    });
  },
);
