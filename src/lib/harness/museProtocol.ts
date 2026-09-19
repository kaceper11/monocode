import { attachmentPathText, isVisionImage, normalizeImageMime } from "../attachments";
import {
  MUSE_EFFORT_OPTIONS,
  type AgentModel,
  type ModelSetting,
} from "../models";
import type { Attachment, RuntimeMode, TaskListItem, ToolPreview } from "../session";
import { normalizeTaskListStatus } from "../taskList";
import type { UserQuestion, UserQuestionReply } from "../userQuestion";
import {
  extractToolPreview,
  formatAgentType,
  isMcpToolName,
  titleFromToolInput,
} from "./preview";
import { snapshotRemainder } from "./streamText";
import type { HarnessEvent } from "./types";

/**
 * Muse Session Protocol (MSP) helpers. MSP is JSON-RPC 2.0 over
 * newline-delimited JSON; `muse serve` is the supported stdio host.
 * Only the stable v1 surface is spoken here — experimental methods are
 * never requested and unknown fields are ignored defensively.
 */
const MUSE_SCHEMA_VERSION = 1;

export const MUSE_AUTH_HELP =
  "Muse is not signed in. Run `muse auth set --api-key-stdin` in a terminal, or set META_API_KEY, then retry.";

/**
 * Lines that read as a real auth failure in host output or error text.
 * Matches explicit failure phrases rather than any "login"/"auth" substring
 * so routine stderr logs (token refresh, `authorized`, sandbox denials, a
 * tool's bare 403) don't surface a spurious "not signed in" error while the
 * session works fine.
 */
export const MUSE_AUTH_PATTERN =
  /not (?:signed|logged) in|not authenticated|unauthori[sz]ed|authentication (?:required|failed|error)|(?:please|then|must) (?:log|sign) ?in|(?:log|sign) ?in (?:required|first|again|to continue)|(?:signed|logged) out|invalid (?:api key|access token|token|credentials?)|expired (?:token|credentials?|session)|(?:token|credentials?|session)(?:\s+(?:has|have|is))?\s+expired|(?:401|403)[^\n]*(?:unauthori[sz]ed|forbidden)|(?:unauthori[sz]ed|forbidden)[^\n]*\b(?:401|403)\b|muse auth|authRequired/i;

const MUSE_CLIENT_CAPABILITIES = {
  // MonoCode renders userInput dialogs through the shared question UI.
  userInputDialogs: true,
};

const MAX_CATALOG_ITEMS = 200;
const MAX_DETAIL_CHARS = 8_000;
const MAX_ITEM_TRACKED = 500;

export type MuseApprovalChoice = {
  choiceId: string;
  decision: string;
  scope: string;
};

export type MuseApproval = {
  approvalId: string;
  sessionId: string;
  itemId: string;
  requirementId: { approvalId: string; sourceIndex: number };
  choices: MuseApprovalChoice[];
  title: string;
  kind?: string;
  preview?: ToolPreview;
};

export type MuseUserInput = {
  userInputId: string;
  sessionId: string;
  itemId?: string;
  questions: UserQuestion[];
  /** Raw question records retained for answer construction. */
  raw: MuseUserInputQuestion[];
  autoResolveAt?: number;
};

type MuseUserInputQuestion = {
  id: string;
  options: string[];
  multi: boolean;
};

/** Per-item streaming state, owned by the live session. */
export type MuseItemState = {
  kind: string;
  text: string;
  output: string;
  /** Tool title/kind/preview are stable for an item; computed once. */
  tool?: { title: string; kind: string; preview?: ToolPreview };
};

/** UUIDv7 — every MSP command requires a genuine v7 command id. */
export function newCommandId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/**
 * `muse serve` flags fix the host's sandbox posture for its lifetime;
 * approval mode is negotiated per session over the wire instead.
 */
export function museSpawnArgs(opts: {
  planning?: boolean;
  fullAccess?: boolean;
}): string[] {
  const args = ["serve"];
  if (opts.planning) args.push("--disable-write");
  if (opts.fullAccess) args.push("--disable-sandbox");
  return args;
}

/**
 * The spawn flags above cannot change on a running host, so the live
 * session must be recycled when this key differs.
 */
export function musePostureKey(
  runtimeMode: RuntimeMode,
  planning: boolean,
): string {
  if (planning) {
    return runtimeMode === "full-access" ? "plan:full-access" : "plan";
  }
  if (runtimeMode === "full-access") return "full-access";
  return "default";
}

/**
 * Approval enforcement is wire-selected. MonoCode's modes map to the four
 * preconfigured MSP modes: supervised/auto-accept prompt, auto lets Muse's
 * own reviewer decide, full-access admits everything, and plan denies what
 * the (disabled) write path did not already refuse.
 */
export function museApprovalMode(
  runtimeMode: RuntimeMode,
  planning: boolean,
): string {
  if (planning) return "denyUnmatched";
  switch (runtimeMode) {
    case "full-access":
      return "allowAll";
    case "auto":
      return "onRequest";
    default:
      return "promptUnmatched";
  }
}

export function museInitializeParams(): Record<string, unknown> {
  return {
    clientInfo: { name: "monocode", title: "MonoCode", version: "0.1.0" },
    capabilities: MUSE_CLIENT_CAPABILITIES,
  };
}

/**
 * Accept only the schema version this client speaks. The fingerprint moves
 * on additive changes and is diagnostic only; version is the contract.
 */
export function museCheckInitialize(result: unknown): {
  serverVersion: string;
  fingerprint?: string;
} {
  const rec = asRecord(result);
  const schema = asRecord(rec?.schema);
  const version = schema?.version;
  if (version !== MUSE_SCHEMA_VERSION) {
    throw new Error(
      `Muse speaks an incompatible MSP schema version (${String(
        version ?? "unknown",
      )}); this build expects ${MUSE_SCHEMA_VERSION}. Update Muse or MonoCode.`,
    );
  }
  const name = stringField(asRecord(rec?.serverInfo), "name");
  if (name && name !== "muse") {
    throw new Error(`Expected a Muse host, got "${name}".`);
  }
  return {
    serverVersion:
      stringField(asRecord(rec?.serverInfo), "version") ?? "unknown",
    fingerprint: stringField(schema ?? {}, "fingerprint"),
  };
}

export function museSessionIdFromResult(result: unknown): string | undefined {
  const session = asRecord(asRecord(result)?.session);
  const id = session?.sessionId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/** Ordered turn input: text, file mentions as text, then image parts. */
export function museTurnInput(
  text: string,
  attachments: Attachment[] = [],
): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  const trimmed = text.trim();
  const mentions: string[] = [];
  for (const file of attachments) {
    if (file.data && isVisionImage(file.mimeType)) {
      parts.push({
        type: "image",
        mediaType: normalizeImageMime(file.mimeType),
        base64Data: file.data,
      });
      continue;
    }
    mentions.push(attachmentPathText(file));
  }
  const body = [trimmed, ...mentions].filter(Boolean).join("\n");
  if (body) parts.unshift({ type: "text", text: body });
  return parts;
}

const MUSE_EFFORT_TIERS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export function museReasoningEffort(
  settings: Record<string, string> | undefined,
): string | undefined {
  const raw = settings?.effort ?? settings?.reasoningEffort ?? "";
  const tier = raw.trim().toLowerCase();
  return MUSE_EFFORT_TIERS.has(tier) ? tier : undefined;
}

/** One shared picker row; Muse samples it per turn submission. */
function museEffortSetting(): ModelSetting {
  return {
    id: "effort",
    label: "Reasoning",
    kind: "select",
    value: "default",
    options: MUSE_EFFORT_OPTIONS,
  };
}

/**
 * `model/list` result → picker rows. The catalog's default row sorts first so
 * `pickDefaultId` lands on it when nothing explicit is chosen.
 */
export function museModelsFromList(result: unknown): AgentModel[] {
  const rec = asRecord(result);
  const raw = Array.isArray(rec?.models) ? rec.models : [];
  const seen = new Set<string>();
  const parsed: { model: AgentModel; isDefault: boolean }[] = [];
  for (const entry of raw) {
    if (parsed.length >= MAX_CATALOG_ITEMS) break;
    const row = asRecord(entry);
    const modelId = stringField(row, "modelId");
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const contextLimit = row?.contextLimit;
    parsed.push({
      model: {
        id: `muse:${modelId}`,
        harness: "muse",
        name: stringField(row, "displayLabel") ?? modelId,
        nativeId: modelId,
        settings: [museEffortSetting()],
        ...(typeof contextLimit === "number" &&
        Number.isFinite(contextLimit) &&
        contextLimit > 0
          ? { contextWindow: contextLimit }
          : {}),
      },
      isDefault: row?.isDefault === true,
    });
  }
  parsed.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return parsed.map((entry) => entry.model);
}

function museToolKind(name: string): string {
  const tool = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["bash", "shell", "sh", "exec", "run", "command"].includes(tool)) {
    return "execute";
  }
  if (["read", "read_file", "cat", "view"].includes(tool)) return "read";
  if (
    ["write", "edit", "write_file", "edit_file", "multi_edit", "apply_patch"].includes(
      tool,
    )
  ) {
    return "edit";
  }
  if (
    ["glob", "grep", "search", "find", "list", "ls", "web_search", "websearch", "web_fetch", "webfetch"].includes(
      tool,
    )
  ) {
    return "search";
  }
  if (["task", "subagent", "agent", "spawn_agent"].includes(tool)) return "agent";
  if (tool === "skill") return "skill";
  return "other";
}

export function museItemStatus(status: unknown, terminal: boolean): string {
  const value = String(status ?? "");
  if (value === "inProgress") return "in_progress";
  if (value === "completed") return "completed";
  if (value === "cancelled") return "cancelled";
  if (value === "failed" || value === "rejected" || value === "timedOut") {
    return "failed";
  }
  // Unknown open-enum values past inProgress are terminal-unknown.
  return terminal ? "failed" : "in_progress";
}

function museToolTitle(
  item: Record<string, unknown>,
  args: Record<string, unknown> | null,
): { title: string; kind: string; preview?: ToolPreview } {
  const tool = stringField(item, "tool") ?? "";
  const kind = museToolKind(tool);
  const input = args ?? {};
  const preview =
    extractToolPreview(
      { title: tool, name: tool, kind, rawInput: input, input },
      { title: tool, name: tool, kind, rawInput: input },
    ) ?? undefined;
  return { title: titleFromToolInput(tool, kind, input) || "Tool", kind, preview };
}

function genericItemTitle(item: Record<string, unknown>, kind: string): string {
  return (
    stringField(item, "fallbackText") ??
    stringField(item, "summary") ??
    (kind ? formatAgentType(kind) : "Activity")
  );
}

/**
 * item/started and item/updated carry the full Item; map each kind to the
 * block vocabulary other providers emit. `items` tracks what was already
 * streamed so completed snapshots only publish the remainder.
 */
export function museItemEvent(
  item: unknown,
  phase: "started" | "updated" | "completed",
  items: Map<string, MuseItemState>,
): HarnessEvent[] {
  const rec = asRecord(item);
  if (!rec) return [];
  const itemId = stringField(rec, "itemId");
  const kind = stringField(rec, "kind") ?? "";
  if (!itemId) return [];
  const terminal = phase === "completed";

  let state = items.get(itemId);
  if (!state) {
    state = { kind, text: "", output: "" };
    if (items.size >= MAX_ITEM_TRACKED) {
      const oldest = items.keys().next().value;
      if (oldest !== undefined) {
        items.delete(oldest);
        console.debug("[muse] evicted still-open item state", oldest);
      }
    }
    items.set(itemId, state);
  }
  if (terminal) items.delete(itemId);

  if (kind === "userMessage") return [];

  if (kind === "agentMessage") {
    const snapshot = stringField(rec, "text") ?? "";
    // Deltas stream between events; a full snapshot only adds the remainder.
    const emit = snapshotRemainder(state.text, snapshot);
    if (emit) state.text += emit;
    return emit ? [{ type: "message.delta", text: emit }] : [];
  }

  if (kind === "reasoning") {
    const summary = Array.isArray(rec.summary)
      ? rec.summary
          .filter((part): part is string => typeof part === "string")
          .join("\n\n")
      : "";
    const raw = stringField(rec, "text") ?? "";
    const snapshot = summary || raw;
    const emit = snapshotRemainder(state.text, snapshot);
    if (emit) state.text += emit;
    return emit ? [{ type: "reasoning.delta", text: emit }] : [];
  }

  if (kind === "toolCall" || kind === "userShell") {
    if (!state.tool) {
      state.tool =
        kind === "userShell"
          ? {
              title:
                stringField(rec, "commandText") ??
                stringField(rec, "command") ??
                "Shell",
              kind: "execute",
            }
          : museToolTitle(rec, parseJsonRecord(stringField(rec, "args")));
    }
    const { title, kind: toolKind, preview } = state.tool;
    const output = stringField(rec, "visibleOutput");
    if (output && output !== state.output) state.output = output;
    const status = museItemStatus(rec.status, terminal);
    const failure = stringField(rec, "failureReason");
    const detail = cap(
      [state.output || undefined, terminal ? failure : undefined]
        .filter(Boolean)
        .join("\n"),
    );
    // Approval rows join on the item id, which is also the block identity.
    const callId = itemId;
    const event =
      phase === "started"
        ? ({
            type: "tool.started",
            callId,
            title,
            kind: toolKind,
            status,
            ...(preview ? { preview } : {}),
          } satisfies HarnessEvent)
        : ({
            type: "tool.updated",
            callId,
            title,
            kind: toolKind,
            status,
            ...(detail ? { detail } : {}),
            ...(preview ? { preview } : {}),
          } satisfies HarnessEvent);
    return [event];
  }

  if (kind === "compaction") {
    const status = museItemStatus(rec.status, terminal);
    const reason = stringField(rec, "reason");
    const title =
      status === "in_progress"
        ? "Compacting context"
        : reason
          ? `Context compaction: ${reason}`
          : "Context compacted";
    return [
      {
        type: phase === "started" ? "tool.started" : "tool.updated",
        callId: itemId,
        title,
        kind: "other",
        status,
      },
    ];
  }

  if (kind === "subagent") {
    const leaf = stringField(rec, "agentPath")
      ?.split(/[/\\]/)
      .filter(Boolean)
      .pop();
    const title =
      stringField(rec, "objective") ??
      (leaf ? `${formatAgentType(leaf)} subagent` : "Subagent");
    const status = museItemStatus(rec.status, terminal);
    const failure = terminal ? stringField(rec, "failureReason") : undefined;
    const summary = terminal
      ? stringField(asRecord(rec.result), "summary")
      : undefined;
    const detail = cap(failure ?? summary ?? "");
    return [
      {
        type: phase === "started" ? "tool.started" : "tool.updated",
        callId: itemId,
        title,
        kind: "agent",
        status,
        ...(detail ? { detail } : {}),
      },
    ];
  }

  // Reminder bookkeeping is transient host activity, never transcript content.
  if (kind === "reminderChild") return [];

  // workflow and unknown kinds render generically.
  const status = museItemStatus(rec.status, terminal);
  return [
    {
      type: phase === "started" ? "tool.started" : "tool.updated",
      callId: itemId,
      title: genericItemTitle(rec, kind),
      kind: "other",
      status,
    },
  ];
}

/**
 * item/delta appends to one field of an open item: `text` (agentMessage),
 * `summary.N` (reasoning parts), `output` (toolCall/userShell visible output).
 */
export function museDeltaEvent(
  params: unknown,
  items: Map<string, MuseItemState>,
): HarnessEvent[] {
  const rec = asRecord(params);
  const itemId = stringField(rec, "itemId");
  const delta = typeof rec?.delta === "string" ? rec.delta : "";
  if (!itemId || !delta) return [];
  const field = stringField(rec, "field") ?? "text";
  const state = items.get(itemId);
  if (!state) return [];
  // Reminder children are bookkeeping; no field streams a tool row.
  if (state.kind === "reminderChild") return [];

  if (field === "text") {
    if (state.kind !== "agentMessage" && state.kind !== "reasoning") return [];
    state.text += delta;
    return [
      state.kind === "reasoning"
        ? { type: "reasoning.delta", text: delta }
        : { type: "message.delta", text: delta },
    ];
  }
  const summaryMatch = field.match(/^summary\.(\d+)$/);
  if (summaryMatch) {
    if (state.kind !== "reasoning") return [];
    state.text += delta;
    return [{ type: "reasoning.delta", text: delta }];
  }
  if (field === "output") {
    state.output += delta;
    // Keep a bounded tail; consumers replace detail wholesale per event.
    if (state.output.length > MAX_DETAIL_CHARS * 2) {
      state.output = state.output.slice(-MAX_DETAIL_CHARS);
    }
    return [
      {
        type: "tool.updated",
        callId: itemId,
        detail: cap(state.output),
      },
    ];
  }
  return [];
}

/** session/todoListChanged → the shared task list. */
export function museTodoListEvent(params: unknown): HarnessEvent | null {
  const rec = asRecord(params);
  const raw = Array.isArray(rec?.items) ? rec.items : [];
  const items: TaskListItem[] = raw.flatMap((entry) => {
    const row = asRecord(entry);
    const text = stringField(row, "text");
    if (!text) return [];
    return [{ text, status: normalizeTaskListStatus(row?.status) }];
  });
  return { type: "tasks.updated", key: "muse", items };
}

/** session/goalChanged → a compact status line; only on actual changes. */
export function museGoalText(params: unknown): string | undefined {
  const goal = asRecord(asRecord(params)?.goal);
  if (!goal) return undefined;
  const objective = stringField(goal, "objective");
  if (!objective) return undefined;
  const percent = goal.percentComplete;
  const suffix =
    typeof percent === "number" && Number.isFinite(percent) && percent > 0
      ? ` (${Math.round(percent)}%)`
      : "";
  return `Goal: ${objective}${suffix}`;
}

/** session/contextUsage → context gauge event. */
export function museContextEvent(params: unknown): HarnessEvent | null {
  const rec = asRecord(params);
  const used = rec?.usedTokens;
  const window = rec?.windowTokens;
  const usedNum = typeof used === "number" && Number.isFinite(used) ? used : undefined;
  const winNum =
    typeof window === "number" && Number.isFinite(window) ? window : undefined;
  if (usedNum == null && winNum == null) return null;
  return { type: "context", used: usedNum, window: winNum };
}

export function museApprovalFromParams(params: unknown): MuseApproval | null {
  const rec = asRecord(params);
  const approvalId = stringField(rec, "approvalId");
  const sessionId = stringField(rec, "sessionId");
  const requirement = asRecord(rec?.currentRequirementId);
  const sourceIndex = requirement?.sourceIndex;
  if (
    !approvalId ||
    !sessionId ||
    typeof sourceIndex !== "number" ||
    !Number.isFinite(sourceIndex)
  ) {
    return null;
  }
  const choices = museChoicesFrom(rec);
  if (choices.length === 0) return null;

  const subject = asRecord(rec?.subject);
  const subjectKind = stringField(subject, "kind") ?? "";
  const toolName = stringField(rec, "toolName") ?? "";
  const args = parseJsonRecord(stringField(rec, "rawArgs"));

  let kind = "other";
  let preview: ToolPreview | undefined;
  let title = toolName || "Approval";
  if (subjectKind === "mcp" || isMcpToolName(toolName)) {
    kind = "mcp";
    title = toolName || title;
  } else if (subjectKind === "shell") {
    kind = "execute";
    const command = stringField(subject, "command");
    preview = command ? { kind: "shell", title: command } : undefined;
    title = command ?? title;
  } else if (subjectKind === "fileAccess") {
    const path = stringField(subject, "path");
    const access = (stringField(subject, "access") ?? "").toLowerCase();
    const write = /write|delete|create|modify/.test(access);
    kind = write ? "edit" : "read";
    preview = path ? { kind: write ? "write" : "read", path } : undefined;
    title = path ? `${write ? "Write" : "Read"} ${path}` : title;
  } else if (subjectKind === "network") {
    const host = stringField(subject, "host") ?? stringField(subject, "target");
    const port = subject?.port;
    title = host
      ? `Network ${host}${typeof port === "number" ? `:${port}` : ""}`
      : title;
  } else if (subjectKind === "process") {
    kind = "execute";
    title = stringField(subject, "target") ?? title;
  } else if (toolName) {
    const mapped = museToolTitle(
      { tool: toolName },
      args,
    );
    title = mapped.title;
    kind = mapped.kind;
    preview = mapped.preview;
  }
  const itemId = stringField(rec, "itemId") ?? approvalId;
  return {
    approvalId,
    sessionId,
    itemId,
    requirementId: { approvalId, sourceIndex },
    choices,
    title,
    kind,
    preview,
  };
}

function museChoicesFrom(
  rec: Record<string, unknown> | null,
): MuseApprovalChoice[] {
  const raw = Array.isArray(rec?.availableChoices) ? rec.availableChoices : [];
  return raw.flatMap((entry): MuseApprovalChoice[] => {
    const choice = asRecord(entry);
    const choiceId = stringField(choice, "choiceId");
    const decision = stringField(choice, "decision");
    if (!choiceId || !decision) return [];
    return [
      {
        choiceId,
        decision,
        scope: stringField(choice, "scope") ?? "once",
      },
    ];
  });
}

/** The refreshed pending view: new requirement token + choices. */
export function museApprovalRefresh(
  params: unknown,
): { approvalId: string; requirementId: { approvalId: string; sourceIndex: number }; choices: MuseApprovalChoice[] } | null {
  const rec = asRecord(params);
  const approvalId = stringField(rec, "approvalId");
  const requirement = asRecord(rec?.currentRequirementId);
  const sourceIndex = requirement?.sourceIndex;
  if (
    !approvalId ||
    typeof sourceIndex !== "number" ||
    !Number.isFinite(sourceIndex)
  ) {
    return null;
  }
  return {
    approvalId,
    requirementId: { approvalId, sourceIndex },
    choices: museChoicesFrom(rec),
  };
}

/**
 * Pick a server-offered choice for a MonoCode allow/deny. Allow prefers a
 * one-shot approval; deny prefers a plain denial over abort. Never invent a
 * choiceId the host did not advertise.
 */
export function museChoiceFor(
  decision: "allow" | "deny",
  choices: MuseApprovalChoice[],
): MuseApprovalChoice | undefined {
  const rank = (choice: MuseApprovalChoice) =>
    choice.scope === "once" ? 0 : choice.scope === "session" ? 1 : 2;
  if (decision === "allow") {
    return choices
      .filter((choice) => choice.decision.startsWith("approved"))
      .sort((a, b) => rank(a) - rank(b))[0];
  }
  return choices
    .filter(
      (choice) =>
        choice.decision.startsWith("denied") || choice.decision === "abort",
    )
    .sort(
      (a, b) =>
        Number(b.decision.startsWith("denied")) -
          Number(a.decision.startsWith("denied")) || rank(a) - rank(b),
    )[0];
}

/** approval/resolved → local UI decision for the open row. */
export function museResolvedDecision(
  decision: unknown,
): "allow" | "deny" | "cancelled" {
  const value = String(decision ?? "");
  if (value.startsWith("approved")) return "allow";
  if (value.startsWith("denied")) return "deny";
  return "cancelled";
}

export function museUserInputFromParams(
  params: unknown,
): MuseUserInput | null {
  const rec = asRecord(params);
  const userInputId = stringField(rec, "userInputId");
  const sessionId = stringField(rec, "sessionId");
  if (!userInputId || !sessionId) return null;
  const raw = Array.isArray(rec?.questions) ? rec.questions : [];
  const questions: UserQuestion[] = [];
  const parsed: MuseUserInputQuestion[] = [];
  for (const entry of raw) {
    const row = asRecord(entry);
    const id = stringField(row, "id");
    const prompt =
      stringField(row, "question") ?? stringField(row, "header");
    if (!id || !prompt) continue;
    const selection = asRecord(row?.selection);
    const multi = stringField(selection, "mode") === "multiple";
    const options = (Array.isArray(row?.options) ? row.options : []).flatMap(
      (option) => {
        const opt = asRecord(option);
        const label = stringField(opt, "label");
        if (!label) return [];
        return [
          {
            id: label,
            label,
            ...(stringField(opt, "description")
              ? { description: stringField(opt, "description") }
              : {}),
          },
        ];
      },
    );
    questions.push({
      id,
      prompt,
      ...(stringField(row, "header") ? { header: stringField(row, "header") } : {}),
      multiSelect: multi,
      allowCustom: true,
      options,
    });
    parsed.push({
      id,
      multi,
      options: options.map((option) => option.id),
    });
  }
  if (questions.length === 0) return null;
  const autoMs = rec?.autoResolutionMs;
  return {
    userInputId,
    sessionId,
    itemId: stringField(rec, "itemId"),
    questions,
    raw: parsed,
    ...(typeof autoMs === "number" && Number.isFinite(autoMs) && autoMs > 0
      ? { autoResolveAt: Date.now() + autoMs }
      : {}),
  };
}

/**
 * Build userInput/answer answers. Returns null when the reply settles
 * nothing (the caller sends userInput/cancel instead).
 */
export function museAnswerParts(
  reply: UserQuestionReply,
  questions: UserQuestion[],
  raw: MuseUserInputQuestion[],
): Record<string, unknown>[] | null {
  if (reply.kind !== "answered") return null;
  const answers: Record<string, unknown>[] = [];
  for (const meta of raw) {
    const question = questions.find((item) => item.id === meta.id);
    if (!question) continue;
    const selected = reply.answers[meta.id] ?? [];
    const custom = reply.custom?.[meta.id]?.trim();
    const labels = selected.flatMap((id) => {
      const option = question.options.find((item) => item.id === id);
      return option ? [option.label] : [];
    });
    if (labels.length === 0 && !custom) continue;
    if (labels.length === 0 && custom) {
      answers.push({ questionId: meta.id, freeText: custom.slice(0, 500) });
      continue;
    }
    if (meta.multi) {
      answers.push({
        questionId: meta.id,
        selectedLabels: labels,
        ...(custom ? { note: custom.slice(0, 500) } : {}),
      });
    } else {
      answers.push({
        questionId: meta.id,
        selectedLabel: labels[0],
        ...(custom ? { note: custom.slice(0, 500) } : {}),
      });
    }
  }
  return answers.length > 0 ? answers : null;
}

/** Structured MSP error kind from a rejected request, when the host sent one. */
export function museErrorKind(error: unknown): string | undefined {
  const data = asRecord(
    (error as { data?: unknown } | null | undefined)?.data,
  );
  return stringField(data, "kind");
}

export function museAuthError(error: unknown, verb = "start"): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (MUSE_AUTH_PATTERN.test(detail)) {
    return new Error(`${detail.trim()}\n\n${MUSE_AUTH_HELP}`);
  }
  if (/timed out/i.test(detail)) {
    return new Error(`Muse did not answer initialize. ${MUSE_AUTH_HELP}`);
  }
  return new Error(`Muse did not ${verb}. ${detail}`);
}

/** turn/completed terminal → error text for the transcript. */
export function museTurnError(params: unknown): Error | null {
  const rec = asRecord(params);
  if (stringField(rec, "terminal") !== "failed") return null;
  const error = asRecord(rec?.error);
  const kind = stringField(error, "kind");
  const message =
    stringField(error, "message") ??
    stringField(rec, "reason") ??
    "Muse turn failed";
  const text = kind === "authRequired" ? `${message}\n\n${MUSE_AUTH_HELP}` : message;
  return new Error(text);
}

function parseJsonRecord(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function cap(value: string, max = MAX_DETAIL_CHARS): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…`;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function stringField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  if (!rec) return undefined;
  const value = rec[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
