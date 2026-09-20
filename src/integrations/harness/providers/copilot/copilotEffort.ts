import type { ModelSetting } from "../../../../features/sessions/model/models.ts";

/**
 * Reasoning effort is a server-launch option in Copilot ACP (`--effort`), not
 * a per-session control. `default` omits the flag so the CLI keeps its own.
 * The placeholder catalog in models.ts and the probed catalog in
 * copilotProtocol.ts share this select so the options cannot drift.
 */
export const COPILOT_EFFORT_OPTIONS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CopilotEffort = (typeof COPILOT_EFFORT_OPTIONS)[number];

/** The effort level worth launching with; `default`/unknown → CLI default. */
export function normalizeEffort(value?: string): CopilotEffort | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  return (COPILOT_EFFORT_OPTIONS as readonly string[]).includes(normalized)
    ? (normalized as CopilotEffort)
    : undefined;
}

export function copilotEffortSetting(): ModelSetting {
  return {
    id: "effort",
    label: "Reasoning",
    kind: "select",
    value: "default",
    options: [
      { value: "default", label: "Default" },
      ...COPILOT_EFFORT_OPTIONS.map((value) => ({
        value,
        label: effortLabel(value),
      })),
    ],
  };
}

function effortLabel(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
