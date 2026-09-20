import { describe, expect, it } from "vitest";
import {
  copilotCurrentModelId,
  copilotEffortFromSettings,
  copilotModelsFromSetup,
  copilotSpawnArgs,
  copilotStopReasonMessage,
  normalizeEffort,
} from "./copilotProtocol";

describe("copilotSpawnArgs", () => {
  it("always starts the ACP stdio server", () => {
    expect(copilotSpawnArgs()).toEqual(["--acp", "--stdio"]);
  });

  it("passes a recognized reasoning effort as a launch flag", () => {
    expect(copilotSpawnArgs("high")).toEqual([
      "--acp",
      "--stdio",
      "--effort=high",
    ]);
    expect(copilotSpawnArgs("xhigh")).toContain("--effort=xhigh");
    expect(copilotSpawnArgs("max")).toContain("--effort=max");
  });

  it("omits the flag for default or unknown effort", () => {
    expect(copilotSpawnArgs("default")).toEqual(["--acp", "--stdio"]);
    expect(copilotSpawnArgs("turbo")).toEqual(["--acp", "--stdio"]);
    expect(copilotSpawnArgs(undefined)).toEqual(["--acp", "--stdio"]);
  });
});

describe("normalizeEffort", () => {
  it("accepts the documented Copilot effort levels", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(normalizeEffort(level)).toBe(level);
    }
  });

  it("is case-insensitive and trims", () => {
    expect(normalizeEffort(" High ")).toBe("high");
  });

  it("rejects anything else", () => {
    expect(normalizeEffort("default")).toBeUndefined();
    expect(normalizeEffort("")).toBeUndefined();
    expect(normalizeEffort(undefined)).toBeUndefined();
  });
});

describe("copilotEffortFromSettings", () => {
  it("reads the effort model setting", () => {
    expect(copilotEffortFromSettings({ effort: "low" })).toBe("low");
    expect(copilotEffortFromSettings({ effort: "default" })).toBeUndefined();
    expect(copilotEffortFromSettings({})).toBeUndefined();
    expect(copilotEffortFromSettings(undefined)).toBeUndefined();
  });
});

describe("copilotModelsFromSetup", () => {
  it("reads models.availableModels from session/new", () => {
    const models = copilotModelsFromSetup({
      sessionId: "S1",
      models: {
        currentModelId: "gpt-5",
        availableModels: [
          { modelId: "gpt-5", name: "GPT-5" },
          { modelId: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
        ],
      },
    });
    expect(models.map((m) => m.id)).toEqual([
      "copilot:default",
      "copilot:gpt-5",
      "copilot:claude-sonnet-4.5",
    ]);
    expect(models[0].nativeId).toBe("");
    expect(models[1].harness).toBe("copilot");
    expect(models[1].nativeId).toBe("gpt-5");
    expect(models[1].name).toBe("GPT-5");
  });

  it("attaches the effort select so reasoning stays a separate choice", () => {
    const models = copilotModelsFromSetup({
      models: { availableModels: [{ modelId: "gpt-5", name: "GPT-5" }] },
    });
    const effort = models[1].settings?.find((s) => s.id === "effort");
    expect(effort?.kind).toBe("select");
    expect(effort?.options.map((o) => o.value)).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("falls back to the model config option when availableModels is absent", () => {
    const models = copilotModelsFromSetup({
      sessionId: "S1",
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "gpt-4.1",
          options: [
            { value: "gpt-4.1", name: "GPT-4.1" },
            { value: "o4-mini", name: "o4 Mini" },
          ],
        },
      ],
    });
    expect(models.map((m) => m.id)).toEqual([
      "copilot:default",
      "copilot:gpt-4.1",
      "copilot:o4-mini",
    ]);
  });

  it("dedupes model ids and ignores empty entries", () => {
    const models = copilotModelsFromSetup({
      models: {
        availableModels: [
          { modelId: "gpt-5", name: "GPT-5" },
          { modelId: "gpt-5", name: "GPT-5 again" },
          { modelId: "", name: "blank" },
          { name: "no id" },
        ],
      },
    });
    expect(models.map((m) => m.id)).toEqual([
      "copilot:default",
      "copilot:gpt-5",
    ]);
  });

  it("excludes models disabled by plan or org policy", () => {
    const models = copilotModelsFromSetup({
      models: {
        availableModels: [
          { modelId: "gpt-5", name: "GPT-5", _meta: { copilotEnabled: true } },
          {
            modelId: "gpt-5.3",
            name: "GPT-5.3",
            _meta: { copilotEnabled: false, copilotMultiplier: "1x" },
          },
          { modelId: "o4-mini", name: "o4 Mini", disabled: true },
          { modelId: "free", name: "Free", _meta: { copilotMultiplier: "0x" } },
        ],
      },
    });
    // "0x" means unmetered, not disabled — it stays selectable.
    expect(models.map((m) => m.id)).toEqual([
      "copilot:default",
      "copilot:gpt-5",
      "copilot:free",
    ]);
  });

  it("returns only the Default entry for a bare setup result", () => {
    expect(copilotModelsFromSetup({ sessionId: "S1" }).map((m) => m.id)).toEqual(
      ["copilot:default"],
    );
    expect(copilotModelsFromSetup(null).map((m) => m.id)).toEqual([
      "copilot:default",
    ]);
  });
});

describe("copilotCurrentModelId", () => {
  it("prefers models.currentModelId", () => {
    expect(
      copilotCurrentModelId(
        { models: { currentModelId: "gpt-5" } },
        [],
      ),
    ).toBe("gpt-5");
  });

  it("falls back to the model config option currentValue", () => {
    expect(
      copilotCurrentModelId({ sessionId: "S1" }, [
        {
          id: "model",
          currentValue: "gpt-4.1",
          options: [],
        },
      ]),
    ).toBe("gpt-4.1");
  });

  it("returns undefined when nothing reports a model", () => {
    expect(copilotCurrentModelId({}, [])).toBeUndefined();
  });
});

describe("copilotStopReasonMessage", () => {
  it("treats end_turn and empty as clean", () => {
    expect(copilotStopReasonMessage("end_turn")).toBeUndefined();
    expect(copilotStopReasonMessage("")).toBeUndefined();
  });

  it("treats cancelled as handled by the cancel path", () => {
    expect(copilotStopReasonMessage("cancelled")).toBeUndefined();
  });

  it("surfaces other stop reasons", () => {
    expect(copilotStopReasonMessage("max_tokens")).toContain("token limit");
    expect(copilotStopReasonMessage("refusal")).toContain("declined");
    expect(copilotStopReasonMessage("mystery")).toContain("mystery");
  });
});
