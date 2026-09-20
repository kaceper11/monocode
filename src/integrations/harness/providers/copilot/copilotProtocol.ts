import type { AgentModel } from "../../../../features/sessions/model/models.ts";
import { acpConfigOptions, acpModelConfigId, acpStopReasonMessage, asRecord, stringField, type AcpConfigOption } from "../../core/acpProtocol.ts";
import {
  COPILOT_EFFORT_OPTIONS,
  copilotEffortSetting,
  normalizeEffort,
  type CopilotEffort,
} from "./copilotEffort";

export {
  COPILOT_EFFORT_OPTIONS,
  copilotEffortSetting,
  normalizeEffort,
};
export type { CopilotEffort };

/**
 * `elicitation.form` advertises form-mode questions; Copilot only sends
 * `elicitation/create` when the client advertises a mode.
 */
export const COPILOT_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  elicitation: { form: {} },
};

export const AUTH_HELP =
  "GitHub Copilot CLI is not signed in. Run `copilot login` in a terminal, or set COPILOT_GITHUB_TOKEN for BYOK/headless use, then retry.";

/**
 * Matches explicit auth-failure phrases rather than any "login"/"auth"
 * substring, so routine stderr (token refresh logs, `authorized`, sandbox
 * denials) doesn't surface a spurious "not signed in" error.
 */
export const COPILOT_AUTH_PATTERN =
  /not (?:signed|logged) in|not authenticated|unauthori[sz]ed|authentication (?:required|failed|error)|(?:please|then|must) (?:log|sign) ?in|(?:log|sign) ?in (?:required|first|again|to continue)|(?:signed|logged) out|invalid (?:api key|access token|token|credentials?)|expired (?:token|credentials?|session)|(?:token|credentials?|session)(?:\s+(?:has|have|is))?\s+expired|(?:401|403)[^\n]*(?:unauthori[sz]ed|forbidden)|(?:unauthori[sz]ed|forbidden)[^\n]*\b(?:401|403)\b|copilot login/i;

/** Launch args for `copilot` ACP stdio. Reasoning is fixed at server start. */
export function copilotSpawnArgs(effort?: string): string[] {
  const args = ["--acp", "--stdio"];
  const level = normalizeEffort(effort);
  if (level) args.push(`--effort=${level}`);
  return args;
}

export function copilotEffortFromSettings(
  settings?: Record<string, string>,
): CopilotEffort | undefined {
  return normalizeEffort(settings?.effort);
}

/**
 * `session/new` advertises models two ways: the `models.availableModels`
 * state (`session/set_model` accepts those ids) and a `model` config option
 * (`session/set_config_option`). Prefer availableModels; both shapes yield
 * `copilot:<id>` entries with the shared Reasoning select attached.
 */
export function copilotModelsFromSetup(result: unknown): AgentModel[] {
  const rec = asRecord(result);
  const available = asRecord(rec?.models)?.availableModels;
  const models: AgentModel[] = [
    // Keep "let Copilot decide" selectable after discovery; it maps to no
    // `session/set_model` call at all.
    {
      id: "copilot:default",
      harness: "copilot",
      name: "Default",
      nativeId: "",
      settings: [copilotEffortSetting()],
    },
  ];
  const seen = new Set<string>();
  const push = (nativeId: string, name: string, contextWindow?: number) => {
    if (!nativeId || seen.has(nativeId) || models.length >= 200) return;
    seen.add(nativeId);
    models.push({
      id: `copilot:${nativeId}`,
      harness: "copilot",
      name: name || nativeId,
      nativeId,
      settings: [copilotEffortSetting()],
      ...(contextWindow ? { contextWindow } : {}),
    });
  };
  if (Array.isArray(available)) {
    for (const item of available) {
      const model = asRecord(item);
      if (!model || copilotModelDisabled(model)) continue;
      const nativeId = String(
        model.modelId ?? model.id ?? model.value ?? "",
      ).trim();
      const meta = asRecord(model._meta);
      push(
        nativeId,
        String(model.name ?? nativeId).trim(),
        numberField(meta, "contextWindow") ?? numberField(model, "contextWindow"),
      );
    }
  }
  // When availableModels was advertised but every entry was filtered (e.g.
  // all disabled by policy), do not fall back to the unfiltered config
  // option — it can re-offer the same disabled models.
  if (seen.size === 0 && !Array.isArray(available)) {
    for (const choice of copilotModelChoices(acpConfigOptions(rec?.configOptions))) {
      push(choice.value, choice.name, choice.contextWindow);
    }
  }
  return models;
}

/**
 * Copilot ≥1.0.37 annotates entries with `_meta.copilotEnabled`; plan- or
 * org-policy-disabled models stay in the list but must never be offered.
 * `copilotMultiplier: "0x"` means unmetered, not disabled — leave it alone.
 */
function copilotModelDisabled(model: Record<string, unknown>): boolean {
  const meta = asRecord(model._meta);
  if (meta?.copilotEnabled === false || meta?.enabled === false) return true;
  return model.enabled === false || model.disabled === true;
}

function copilotModelChoices(options: AcpConfigOption[]): AcpConfigOption["options"] {
  const model =
    options.find((option) => option.id === "model") ??
    options.find((option) => option.category === "model");
  return model?.options ?? [];
}

/** The model the session reports as current, from either advertised shape. */
export function copilotCurrentModelId(
  setup: unknown,
  options: AcpConfigOption[],
): string | undefined {
  const rec = asRecord(setup);
  const fromModels =
    stringField(asRecord(rec?.models) ?? {}, "currentModelId") ??
    stringField(asRecord(rec?.models) ?? {}, "current_model_id");
  if (fromModels) return fromModels;
  const configId = acpModelConfigId(options);
  return options.find((option) => option.id === configId)?.currentValue;
}

export function copilotStopReasonMessage(stopReason: string): string | undefined {
  return acpStopReasonMessage("Copilot", stopReason);
}

function numberField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  if (!rec) return undefined;
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
