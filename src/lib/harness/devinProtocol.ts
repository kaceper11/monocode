import { modelsFor, type AgentModel } from "../models";
import { acpAuthError, acpAutoOption, acpCommandsFromUpdate, acpConfigOptions, acpCurrentModelId, acpElicitation, acpElicitationResult, acpEventsFromUpdate, acpModeId, acpModeIdsFromConfig, acpModesFromSetup, acpModelConfigId, acpPermissionOptionId, acpPermissionRequest, acpPromptBlocks, acpStopReasonMessage, asRecord, sessionIdFromResult, stringField, type AcpConfigOption, type AcpElicitField } from "./acpProtocol";

export { asRecord, sessionIdFromResult, stringField };

export type DevinConfigOption = AcpConfigOption;
export type DevinElicitField = AcpElicitField;

/**
 * `elicitation.form` advertises form-mode questions; an empty `elicitation`
 * object advertises no modes and Devin would never send `elicitation/create`.
 */
export const DEVIN_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  elicitation: { form: {} },
};

export const AUTH_HELP =
  "Devin CLI is not signed in. Run `devin auth login` in a terminal, then retry.";

/**
 * True when Devin CLI output reports a real auth problem. Matches explicit
 * failure phrases rather than any "login"/"auth" substring so routine stderr
 * logs like `toolbox::tools::exec::login_shell_env` snapshots don't surface a
 * spurious "not signed in" error while the session works fine.
 */
const DEVIN_AUTH_MESSAGE =
  /not (?:signed|logged) in|not authenticated|unauthori[sz]ed|authentication (?:required|failed|error)|(?:please|then|must) (?:log|sign) ?in|(?:log|sign) ?in (?:required|first|again|to continue)|(?:signed|logged) out|invalid (?:api key|access token|token|credentials?)|expired (?:token|credentials?|session)|(?:token|credentials?|session)(?:\s+(?:has|have|is))?\s+expired|(?:401|403)[^\n]*(?:unauthori[sz]ed|forbidden)|(?:unauthori[sz]ed|forbidden)[^\n]*\b(?:401|403)\b|devin auth login/i;

export function isDevinAuthMessage(text: string): boolean {
  return DEVIN_AUTH_MESSAGE.test(text);
}

const MAX_CATALOG_ITEMS = 200;
/** Raw variant cap before grouping — Devin currently ships ~420 choices. */
const MAX_CATALOG_VARIANTS = 2000;

/** Devin advertises image and embedded-context prompt blocks. */
export const devinPromptBlocks = acpPromptBlocks;

export function devinSpawnArgs(): string[] {
  return ["acp"];
}

export const devinModeId = acpModeId;
export const devinModesFromSetup = acpModesFromSetup;
export const devinModeIdsFromConfig = acpModeIdsFromConfig;
export const devinConfigOptions = acpConfigOptions;
export const devinModelConfigId = acpModelConfigId;
export const devinCurrentModelId = acpCurrentModelId;
export const devinEventsFromUpdate = acpEventsFromUpdate;
export const devinPermissionRequest = acpPermissionRequest;
export const devinAutoOption = acpAutoOption;
export const devinPermissionOptionId = acpPermissionOptionId;
export const devinElicitation = acpElicitation;
export const devinElicitationResult = acpElicitationResult;

export function devinCommandsFromUpdate(params: unknown) {
  return acpCommandsFromUpdate("devin", params);
}

export function devinAuthError(error: unknown, verb = "start"): Error {
  return acpAuthError("Devin", AUTH_HELP, error, verb);
}

export function devinStopReasonMessage(stopReason: string): string | undefined {
  return acpStopReasonMessage("Devin", stopReason);
}

/**
 * Devin bakes the reasoning level into the model uid (`claude-opus-5-high`,
 * `gpt-5-6-sol-none-priority`). These patterns pull the level word back out of
 * a variant label so the picker can offer one model row with a separate
 * Reasoning select instead of one row per level. The first match wins — in a
 * Fusion label the primary's level precedes the sidekick's, so only the
 * primary's level is split out.
 */
const DEVIN_LEVELS: { re: RegExp; level: string }[] = [
  { re: /\bNo Thinking\b/i, level: "none" },
  { re: /\bNone\b/i, level: "none" },
  { re: /\bMinimal\b/i, level: "minimal" },
  { re: /\bLow(?:\s+Thinking)?\b/i, level: "low" },
  { re: /\bMedium(?:\s+Thinking)?\b/i, level: "medium" },
  { re: /\b(?:X-?High|Extra[- ]High)(?:\s+Thinking)?\b/i, level: "xhigh" },
  { re: /\bHigh(?:\s+Thinking)?\b/i, level: "high" },
  { re: /\bMax(?:\s+Thinking)?\b/i, level: "max" },
  { re: /\bThinking\b/i, level: "thinking" },
];

/**
 * Last resort when a label carries no level word (e.g. Devin starts omitting
 * `name` so the label is the uid itself): strip trailing speed/context
 * segments, then a trailing level segment, from the uid.
 */
const DEVIN_UID_LEVEL =
  /^(.*?)[-_](none|minimal|low|medium|high|xhigh|max|thinking)((?:[-_](?:fast|priority|1m))*)$/i;

const DEVIN_LEVEL_RANK: Record<string, number> = {
  default: 0,
  none: 1,
  minimal: 2,
  low: 3,
  medium: 4,
  high: 5,
  xhigh: 6,
  max: 7,
  thinking: 8,
};

const DEVIN_LEVEL_LABEL: Record<string, string> = {
  default: "Standard",
  none: "No Thinking",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  thinking: "Thinking",
};

type DevinVariant = {
  uid: string;
  /** Label with the reasoning level removed — the picker row's name. */
  descriptor: string;
  level: string;
  contextWindow?: number;
};

function parseDevinVariant(
  uid: string,
  label: string,
  contextWindow?: number,
): DevinVariant {
  const name = label.trim() || uid;
  let best: { index: number; end: number; level: string } | undefined;
  for (const { re, level } of DEVIN_LEVELS) {
    const match = re.exec(name);
    if (match && (!best || match.index < best.index)) {
      best = { index: match.index, end: match.index + match[0].length, level };
    }
  }
  if (!best) {
    const suffix = DEVIN_UID_LEVEL.exec(uid);
    if (suffix?.[1]) {
      const tail = (suffix[3] ?? "").replace(/priority/gi, "fast");
      const descriptor = `${suffix[1]}${tail}`.replace(/[-_]+/g, " ").trim();
      return {
        uid,
        descriptor: descriptor || name,
        level: suffix[2]!.toLowerCase(),
        contextWindow,
      };
    }
    return { uid, descriptor: name, level: "default", contextWindow };
  }
  const descriptor = `${name.slice(0, best.index)} ${name.slice(best.end)}`
    .replace(/\s+/g, " ")
    .trim();
  return {
    uid,
    descriptor: descriptor || name,
    level: best.level,
    contextWindow,
  };
}

/**
 * Groups variants that differ only in reasoning level into one model carrying
 * a `reasoning` select. Option values are the full variant uids — legacy
 * `MODEL_*` ids and Fusion pairs cannot be recomposed from a base + level.
 * `currentUid` (the session's live value) wins the default when present.
 */
function devinGroupedModels(
  variants: DevinVariant[],
  currentUid?: string,
  usedIds: Set<string> = new Set(),
): AgentModel[] {
  // Case-fold the key — labels that differ only in casing ("Model A" /
  // "model a") are the same family.
  const groups = new Map<string, { descriptor: string; list: DevinVariant[] }>();
  for (const variant of variants) {
    const key = variant.descriptor.toLowerCase();
    const group = groups.get(key);
    if (group) group.list.push(variant);
    else groups.set(key, { descriptor: variant.descriptor, list: [variant] });
  }
  const models: AgentModel[] = [];
  for (const { descriptor, list: members } of groups.values()) {
    if (models.length >= MAX_CATALOG_ITEMS) break;
    // Every variant stays selectable — two uids can share a level word
    // ("X" vs "X Thinking" labels), so disambiguate duplicate labels with the
    // uid rather than dropping a variant.
    const sorted = [...members].sort(
      (a, b) =>
        (DEVIN_LEVEL_RANK[a.level] ?? 9) - (DEVIN_LEVEL_RANK[b.level] ?? 9),
    );
    const levelCounts = new Map<string, number>();
    for (const member of sorted) {
      levelCounts.set(member.level, (levelCounts.get(member.level) ?? 0) + 1);
    }
    const active =
      (currentUid
        ? members.find((member) => member.uid === currentUid)
        : undefined) ?? members[0];
    if (!active) continue;
    const slug =
      descriptor
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || active.uid;
    let id = `devin:${slug}`;
    for (let suffix = 2; usedIds.has(id); suffix += 1) {
      id = `devin:${slug}-${suffix}`;
    }
    usedIds.add(id);
    models.push({
      id,
      harness: "devin",
      name: descriptor,
      nativeId: active.uid,
      ...(active.contextWindow ? { contextWindow: active.contextWindow } : {}),
      ...(sorted.length > 1
        ? {
            settings: [
              {
                id: "reasoning",
                label: "Reasoning",
                kind: "select" as const,
                value: active.uid,
                options: sorted.map((member) => ({
                  value: member.uid,
                  label:
                    (levelCounts.get(member.level) ?? 0) > 1
                      ? `${DEVIN_LEVEL_LABEL[member.level] ?? member.level} (${member.uid})`
                      : (DEVIN_LEVEL_LABEL[member.level] ?? member.level),
                })),
              },
            ],
          }
        : {}),
    });
  }
  return models;
}

/** Dynamic catalog from the session's `model` config option. */
export function devinModelsFromConfig(
  options: DevinConfigOption[],
): AgentModel[] {
  const model =
    options.find((option) => option.id === "model") ??
    options.find((option) => option.category === "model");
  const seen = new Set<string>();
  const variants: DevinVariant[] = [];
  for (const choice of (model?.options ?? []).slice(0, MAX_CATALOG_VARIANTS)) {
    if (seen.has(choice.value)) continue;
    seen.add(choice.value);
    variants.push(
      parseDevinVariant(choice.value, choice.name, choice.contextWindow),
    );
  }
  return devinGroupedModels(variants, model?.currentValue);
}

/**
 * Maps a live `model` config value (a variant uid) back to the grouped
 * catalog entry: the model id plus the `reasoning` setting value when the uid
 * is one of that group's levels. Unknown uids keep their raw `devin:<uid>` id.
 */
export function devinModelSelectionForUid(
  options: DevinConfigOption[],
  uid: string,
  cwd?: string,
): { id: string; reasoning?: string } {
  const find = (models: AgentModel[]) => {
    for (const model of models) {
      const reasoning = model.settings?.find(
        (setting) => setting.id === "reasoning",
      );
      if (reasoning?.options.some((option) => option.value === uid)) {
        return { id: model.id, reasoning: uid };
      }
      if (model.nativeId === uid) return { id: model.id };
    }
    return undefined;
  };
  // The picker catalog (from `devin models list`) is the id space the picker
  // displays — prefer it so a reported uid maps to the same row the user sees.
  return (
    find(modelsFor("devin", cwd)) ??
    find(devinModelsFromConfig(options)) ?? { id: `devin:${uid}` }
  );
}

/**
 * `devin models list --format json` → `{families: [{slug, variants: [
 * {model_uid, label, max_context_tokens}]}]}`. Variants are the concrete ids
 * `session/set_config_option` accepts; a family with no variants keeps its
 * slug — slugs are selectable aliases.
 */
function devinModelsFromJson(raw: unknown): AgentModel[] {
  const rec = asRecord(raw);
  const families = Array.isArray(rec?.families) ? rec.families : [];
  const seen = new Set<string>();
  const variants: DevinVariant[] = [];
  const familiesOnly: { slug: string; label: string }[] = [];
  for (const item of families) {
    const family = asRecord(item);
    if (!family) continue;
    const slug = stringField(family, "slug") ?? stringField(family, "family_uid");
    const label =
      stringField(family, "family_label") ??
      stringField(family, "label") ??
      slug ??
      "";
    const entries = Array.isArray(family.variants) ? family.variants : [];
    if (slug && entries.length === 0) familiesOnly.push({ slug, label });
    for (const entry of entries) {
      if (variants.length >= MAX_CATALOG_VARIANTS) break;
      const variant = asRecord(entry);
      const uid = stringField(variant ?? {}, "model_uid");
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      variants.push(
        parseDevinVariant(
          uid,
          stringField(variant ?? {}, "label") ?? uid,
          numberField(variant, "max_context_tokens") ??
            numberField(variant, "context_window"),
        ),
      );
    }
  }
  const usedIds = new Set<string>();
  const models = devinGroupedModels(variants, undefined, usedIds);
  for (const { slug, label } of familiesOnly) {
    if (models.length >= MAX_CATALOG_ITEMS) break;
    let id = `devin:${slug}`;
    for (let suffix = 2; usedIds.has(id); suffix += 1) {
      id = `devin:${slug}-${suffix}`;
    }
    usedIds.add(id);
    models.push({ id, harness: "devin", name: label || slug, nativeId: slug });
  }
  return models;
}

export function devinModelsFromOutput(stdout: string): AgentModel[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const start = trimmed.indexOf("{");
  if (start < 0) return [];
  try {
    return devinModelsFromJson(JSON.parse(trimmed.slice(start)));
  } catch {
    return [];
  }
}

function numberField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  if (!rec) return undefined;
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
