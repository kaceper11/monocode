import { promptBlocks, type PromptContentBlock } from "../attachments";
import type { Attachment, RuntimeMode, ToolPreview } from "../session";
import { normalizeTaskListStatus } from "../taskList";
import type { UserQuestion, UserQuestionReply } from "../userQuestion";
import {
  JsonRpcClient,
  type JsonRpcHandlers,
  type JsonRpcId,
} from "./jsonRpc";
import {
  nativeCommandInvocation,
  type NativeCommand,
} from "./nativeCommands";
import type { HarnessId } from "../session";
import type { ApprovalDecision, HarnessEvent } from "./types";
import {
  composeToolTitle,
  extractSearchQuery,
  extractShellCommand,
  extractSkillName,
  extractToolPreview,
  isMcpToolName,
} from "./preview";
import { acpAgentInfo } from "./acpSubagents";

export type AcpHandlers = {
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (
    id: JsonRpcId,
    method: string,
    params: unknown,
  ) => void | Promise<void>;
};

/**
 * ACP JSON-RPC client. Server request ids are passed through untouched so
 * respond() echoes back the exact id — coercing a string id to number would
 * serialize `null` and leave the agent's request hanging.
 */
export class AcpClient {
  private readonly rpc: JsonRpcClient;
  private readonly prompts = new Set<Promise<unknown>>();
  private questions: Promise<void> = Promise.resolve();
  private questionGeneration = 0;

  constructor(
    sessionId: string,
    private readonly handlers: AcpHandlers,
  ) {
    const rpcHandlers: JsonRpcHandlers = {
      onNotification: (method, params) =>
        this.handlers.onNotification?.(method, params),
      onRequest: (id, method, params) => {
        void this.handlers.onRequest?.(id, method, params);
      },
    };
    this.rpc = new JsonRpcClient(sessionId, rpcHandlers, {
      includeJsonrpc: true,
      label: "acp",
    });
  }

  pushLine(line: string) {
    this.rpc.pushLine(line);
  }

  close(error?: Error) {
    this.questionGeneration += 1;
    this.rpc.close(error);
  }

  rejectPending(error?: Error) {
    this.questionGeneration += 1;
    this.rpc.rejectPending(error);
  }

  /** The composer presents one question at a time; cancelled queued asks still get a reply. */
  queueQuestion(run: (cancelled: boolean) => Promise<void>): Promise<void> {
    const generation = this.questionGeneration;
    const pending = this.questions.catch(() => undefined)
      .then(() => run(generation !== this.questionGeneration));
    this.questions = pending;
    return pending;
  }

  request<T>(method: string, params?: unknown, timeoutMs = method === "session/prompt" ? 30 * 60_000 : 15_000): Promise<T> {
    const request = this.rpc.request<T>(method, params, timeoutMs);
    if (method === "session/prompt") {
      this.prompts.add(request);
      const remove = () => { this.prompts.delete(request); };
      request.then(remove, remove);
    }
    return request;
  }

  /** A turn includes every follow-up accepted before it becomes idle. */
  async waitForPrompts(): Promise<void> {
    while (this.prompts.size) await Promise.all([...this.prompts]);
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.rpc.notify(method, params);
  }

  respond(id: JsonRpcId, result: unknown): Promise<void> {
    return this.rpc.respond(id, result);
  }

  respondError(
    id: JsonRpcId,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void> {
    return this.rpc.respondError(id, error);
  }
}

export type AcpConfigOption = {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options: AcpConfigChoice[];
};

type AcpConfigChoice = {
  value: string;
  name: string;
  contextWindow?: number;
};

export type AcpPermissionOption = { optionId: string; kind?: string };

export function acpPermissionOptions(raw: unknown): AcpPermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const option = asRecord(value);
    const optionId = stringField(option ?? {}, "optionId") ?? stringField(option ?? {}, "option_id");
    return optionId ? [{ optionId, kind: stringField(option ?? {}, "kind") }] : [];
  });
}

export type AcpPermissionRequest = {
  title: string;
  kind?: string;
  callId?: string;
  preview?: ToolPreview;
  optionIds: string[];
  options?: AcpPermissionOption[];
};

/** One schema property of an ACP `elicitation/create` request. */
export type AcpElicitField = {
  key: string;
  multi: boolean;
  required?: boolean;
  minItems?: number;
  maxItems?: number;
  numberType?: "number" | "integer";
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  /** UserQuestion option id → the schema value the agent expects back. */
  values: Record<string, unknown>;
};

const MAX_CATALOG_ITEMS = 200;
const MAX_DESCRIPTION_CHARS = 240;

/** Standard ACP prompt blocks: text plus images/resource links. */
export function acpPromptBlocks(
  text: string,
  attachments: Attachment[] = [],
): PromptContentBlock[] {
  return promptBlocks(text, attachments);
}

/**
 * Pick a provider-advertised session mode for a MonoCode runtime mode.
 * `session/set_mode` silently ignores unknown ids, so only ids the session
 * actually listed are candidates. Nothing suitable → keep the agent's mode.
 */
export function acpModeId(
  runtimeMode: RuntimeMode,
  planning: boolean,
  advertised: string[],
): string | undefined {
  const pick = (candidates: string[]) =>
    candidates.find((id) => advertised.includes(id));
  if (planning) {
    return pick(["plan", "ask"]);
  }
  switch (runtimeMode) {
    case "full-access":
      return pick(["bypass", "dangerous", "yolo", "auto-accept"]);
    case "auto":
      return pick(["smart", "auto", "autonomous"]);
    case "auto-accept-edits":
      return pick([
        "accept-edits",
        "accept_edits",
        "acceptedits",
        "acceptEdits",
      ]);
    case "supervised":
      return pick(["normal", "manual", "default", "accept-edits", "code"]);
    default:
      return undefined;
  }
}

export function acpModesFromSetup(result: unknown): {
  currentModeId?: string;
  availableModeIds: string[];
} {
  const rec = asRecord(result);
  const modes = asRecord(rec?.modes);
  const available = Array.isArray(modes?.availableModes)
    ? modes.availableModes
    : Array.isArray(modes?.available_modes)
      ? modes.available_modes
      : [];
  const ids = available.flatMap((item) => {
    const id = asRecord(item)?.id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
  const current =
    stringField(modes ?? {}, "currentModeId") ??
    stringField(modes ?? {}, "current_mode_id");
  return { currentModeId: current, availableModeIds: ids };
}

/** Mode ids are also offered as a `mode` config option on some agents. */
export function acpModeIdsFromConfig(options: AcpConfigOption[]): string[] {
  const mode =
    options.find((option) => option.id === "mode") ??
    options.find((option) => option.category === "mode");
  return (mode?.options ?? []).map((choice) => choice.value).filter(Boolean);
}

export function acpConfigOptions(raw: unknown): AcpConfigOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const rec = asRecord(item);
    const id = String(rec?.id ?? rec?.configId ?? "").trim();
    if (!id) return [];
    const choices = Array.isArray(rec?.options) ? rec.options : [];
    return [
      {
        id,
        name: stringField(rec ?? {}, "name"),
        category: stringField(rec ?? {}, "category"),
        type: stringField(rec ?? {}, "type"),
        currentValue:
          typeof rec?.currentValue === "string" && rec.currentValue.trim()
            ? rec.currentValue
            : undefined,
        options: choices.flatMap((choice) => {
          const option = asRecord(choice);
          const value = String(option?.value ?? option?.id ?? "").trim();
          if (!value) return [];
          const meta = asRecord(option?._meta) ?? option ?? {};
          return [
            {
              value,
              name:
                stringField(option ?? {}, "name") ??
                stringField(option ?? {}, "label") ??
                value,
              contextWindow:
                numberField(meta, "cognition.ai/contextWindow") ??
                numberField(meta, "contextWindow"),
            },
          ];
        }),
      },
    ];
  });
}

export function acpModelConfigId(options: AcpConfigOption[]): string {
  const exact = options.find((option) => option.id === "model");
  if (exact) return exact.id;
  const byCategory = options.find(
    (option) =>
      option.category === "model" &&
      option.type === "select" &&
      option.options.length > 0,
  );
  return byCategory?.id ?? "model";
}

/** The model the agent reports as active after setup or a config update. */
export function acpCurrentModelId(options: AcpConfigOption[]): string {
  const id = acpModelConfigId(options);
  return options.find((option) => option.id === id)?.currentValue ?? "";
}

export function acpCommandsFromUpdate(
  harness: HarnessId,
  params: unknown,
): NativeCommand[] {
  const rec = asRecord(params);
  const update = asRecord(rec?.update) ?? rec;
  const raw =
    (Array.isArray(update?.availableCommands)
      ? update.availableCommands
      : undefined) ??
    (Array.isArray(update?.available_commands)
      ? update.available_commands
      : undefined) ??
    [];
  const commands: NativeCommand[] = [];
  for (const item of raw.slice(0, MAX_CATALOG_ITEMS)) {
    const command = asRecord(item);
    const name = String(command?.name ?? "").trim();
    if (!name || !/^[\w:.-]+$/.test(name)) continue;
    const input = asRecord(command?.input);
    const hint =
      stringField(input ?? {}, "hint") ??
      stringField(command ?? {}, "inputHint") ??
      stringField(command ?? {}, "input_hint");
    commands.push({
      name,
      description: cap(
        stringField(command ?? {}, "description") ?? "",
        MAX_DESCRIPTION_CHARS,
      ),
      invocation: nativeCommandInvocation(harness, name),
      source: harness,
      ...(hint ? { inputHint: hint } : {}),
    });
  }
  return commands;
}

/** Standard ACP `session/update` → MonoCode harness events. */
export function acpEventsFromUpdate(params: unknown): HarnessEvent[] {
  const rec = asRecord(params);
  const update = asRecord(rec?.update) ?? rec;
  if (!update) return [];
  const kind = String(
    update.sessionUpdate ?? update.session_update ?? update.type ?? "",
  );

  if (kind === "agent_message_chunk" || kind === "agent_message") {
    const text = textFromContent(
      update.content ?? update.text,
      kind === "agent_message" ? "\n" : "",
    );
    return text ? [{ type: "message.delta", text }] : [];
  }

  if (kind === "agent_thought_chunk" || kind === "agent_thought") {
    const text = textFromContent(
      update.content ?? update.text,
      kind === "agent_thought" ? "\n" : "",
    );
    return text ? [{ type: "reasoning.delta", text }] : [];
  }

  if (
    kind === "tool_call" ||
    kind === "tool_call_update" ||
    kind === "tool_call_content_chunk"
  ) {
    const tool =
      asRecord(update.toolCall) ?? asRecord(update.tool_call) ?? update;
    const callId = String(
      tool.toolCallId ??
        tool.tool_call_id ??
        update.toolCallId ??
        update.tool_call_id ??
        "",
    );
    if (!callId) return [];
    const toolKind = isAcpMcpToolCall(tool, update)
      ? "mcp"
      : (stringField(update, "kind") ?? stringField(tool, "kind"));
    const status = stringField(update, "status") ?? stringField(tool, "status");
    const preview = extractToolPreview(update, tool);
    const meta = asRecord(update._meta) ?? asRecord(tool._meta);
    const command =
      extractShellCommand(
        update.rawInput,
        tool.rawInput,
        update.raw_input,
        tool.raw_input,
        update.input,
        tool.input,
      ) ??
      (meta?.["cognition.ai/preview_is_shell_command"] === true
        ? stringField(meta, "cognition.ai/terminalPreview") ??
          stringField(meta, "cognition.ai/command")
        : undefined);
    const title =
      composeToolTitle({
        kind: toolKind,
        title: toolLabel(update) ?? toolLabel(tool),
        command,
        skill: extractSkillName(
          update.rawInput,
          tool.rawInput,
          update.raw_input,
          tool.raw_input,
          update.input,
          tool.input,
        ),
        path: preview?.path,
        query:
          preview?.query ??
          extractSearchQuery(
            update.rawInput ??
              tool.rawInput ??
              update.raw_input ??
              tool.raw_input ??
              update.input ??
              tool.input,
          ),
        previewKind: preview?.kind,
      }) ??
      toolLabel(update) ??
      toolLabel(tool);
    return [
      {
        type: "tool.updated",
        callId,
        title,
        kind: toolKind,
        status,
        detail: cap(toolDetail(update, tool) ?? "") || undefined,
        preview,
        ...acpAgentInfo(update, tool, toolKind, title),
      },
    ];
  }

  if (kind === "plan" || kind === "current_plan") {
    const event = planEvent(update);
    return event ? [event] : [];
  }

  if (kind === "usage_update" || kind === "context_update") {
    const usage = usageFromUpdate(update);
    return usage ? [usage] : [];
  }

  const usage = usageFromUpdate(update);
  return usage ? [usage] : [];
}

/**
 * ACP has no MCP tool kind in the spec; agents mark calls loosely through the
 * kind, a server field on the toolCall/_meta, or an `mcp`-prefixed name.
 */
export function isAcpMcpToolCall(
  tool: Record<string, unknown>,
  extra?: Record<string, unknown> | null,
): boolean {
  const records = [tool, extra ?? null];
  for (const rec of records) {
    if (!rec) continue;
    if (stringField(rec, "kind")?.toLowerCase() === "mcp") return true;
    const meta = asRecord(rec._meta) ?? asRecord(rec.meta);
    if (meta?.mcp === true) return true;
    for (const source of [rec, meta]) {
      if (!source) continue;
      if (
        stringField(source, "serverName") ||
        stringField(source, "server_name") ||
        stringField(source, "mcpServer") ||
        stringField(source, "mcp_server")
      ) {
        return true;
      }
    }
    const name =
      stringField(rec, "name") ??
      stringField(rec, "toolName") ??
      stringField(rec, "tool_name") ??
      stringField(rec, "title");
    if (isMcpToolName(name)) return true;
  }
  return false;
}

export function acpPermissionRequest(
  params: unknown,
): AcpPermissionRequest {
  const rec = asRecord(params);
  const subject = asRecord(rec?.subject);
  const tool =
    asRecord(rec?.toolCall) ??
    asRecord(rec?.tool_call) ??
    asRecord(subject?.toolCall) ??
    asRecord(subject) ??
    rec ??
    {};
  const command = stringField(subject ?? {}, "command");
  const kind = isAcpMcpToolCall(tool, subject)
    ? "mcp"
    : (stringField(tool, "kind") ?? stringField(subject ?? {}, "kind"));
  const preview = extractToolPreview(tool, tool);
  const title =
    composeToolTitle({
      kind,
      title: toolLabel(tool),
      command: command ?? extractShellCommand(tool),
      skill: extractSkillName(tool),
      path: preview?.path,
      query: preview?.query ?? extractSearchQuery(tool),
      previewKind: preview?.kind,
    }) ||
    toolLabel(tool) ||
    command ||
    stringField(rec ?? {}, "title") ||
    "Permission";
  const options = Array.isArray(rec?.options) ? rec.options : [];
  const optionIds = options
    .map((item) => asRecord(item)?.optionId ?? asRecord(item)?.option_id)
    .filter((value): value is string => typeof value === "string");

  return {
    title,
    kind,
    callId:
      stringField(tool, "toolCallId") ??
      stringField(tool, "tool_call_id") ??
      stringField(rec ?? {}, "toolCallId"),
    preview,
    optionIds,
    options: acpPermissionOptions(rec?.options),
  };
}

/**
 * Requests that still reach us are answered by runtime mode: supervised keeps
 * every prompt, auto-accept-edits auto-answers only edit/read/search/think and
 * keeps everything else (MCP included) on a prompt, and the auto/full-access
 * modes answer immediately since the agent already applied its own mode
 * judgement before asking.
 */
export function acpAutoOption(
  runtimeMode: RuntimeMode,
  kind: string | undefined,
  optionIds: string[],
  options: AcpPermissionOption[] = [],
): string | null {
  if (optionIds.length === 0) return null;
  const tool = (kind ?? "").toLowerCase();
  if (runtimeMode === "supervised") return null;
  if (runtimeMode === "auto-accept-edits") {
    // AcceptEdits auto-answers only harmless kinds — edits and reads. MCP,
    // commands, deletes, fetches and anything unrecognized still prompt the
    // way the real CLIs do.
    if (tool !== "edit" && tool !== "read" && tool !== "search" && tool !== "think") {
      return null;
    }
  }
  const kinds = runtimeMode === "full-access"
    ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"];
  for (const kind of kinds) {
    const offered = options.find((option) => option.kind === kind);
    if (offered) return offered.optionId;
  }
  const untyped = optionIds.filter((id) => !options.find((option) => option.optionId === id)?.kind);
  return pickOption(untyped, runtimeMode === "full-access"
    ? ["allow-always", "allow_always", "allow-once", "allow_once", "allow"]
    : ["allow-once", "allow_once", "allow-always", "allow_always", "allow"]);
}

export function acpPermissionOptionId(
  decision: ApprovalDecision,
  optionIds: string[],
  options: AcpPermissionOption[] = [],
): string | undefined {
  for (const kind of decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"]) {
    const offered = options.find((option) => option.kind === kind);
    if (offered) return offered.optionId;
  }
  const wanted =
    decision === "allow"
      ? [
          "allow-once",
          "allow_once",
          "allow-always",
          "allow_always",
          "allow",
        ]
      : [
          "reject-once",
          "reject_once",
          "reject-always",
          "reject_always",
          "reject",
          "deny",
        ];
  const untyped = optionIds.filter((id) => !options.find((option) => option.optionId === id)?.kind);
  const match = pickOption(untyped, wanted);
  if (match) return match;
  // Never invent an id the agent did not offer; fall back to the first
  // advertised option that looks like an allow/reject, else nothing.
  const kind = decision === "allow" ? "allow" : "reject";
  return untyped.find((id) => id.toLowerCase().startsWith(`${kind}-`) || id.toLowerCase().startsWith(`${kind}_`));
}

/**
 * ACP `elicitation/create` (MCP form schema). Each schema property becomes one
 * UserQuestion; enum and oneOf entries become fixed options, everything else
 * is free text.
 */
export function acpElicitation(params: unknown): {
  title?: string;
  questions: UserQuestion[];
  fields: AcpElicitField[];
} | null {
  const rec = asRecord(params);
  const inner = asRecord(rec?.params) ?? rec;
  const schema =
    asRecord(inner?.requestedSchema) ??
    asRecord(inner?.requested_schema) ??
    asRecord(inner?.schema);
  const properties = asRecord(schema?.properties);
  if (!properties) return null;

  const questions: UserQuestion[] = [];
  const fields: AcpElicitField[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const field = asRecord(value);
    if (!field) continue;
    const type = String(field.type ?? "");
    const multi = type === "array";
    const target = multi ? (asRecord(field.items) ?? field) : field;
    const values: Record<string, unknown> = {};
    const options: { id: string; label: string; description?: string }[] = [];

    const enumValues = Array.isArray(target.enum) ? target.enum : [];
    const enumNames = Array.isArray(target.enumNames)
      ? target.enumNames
      : Array.isArray(target.enum_names)
        ? target.enum_names
        : [];
    enumValues.forEach((entry, index) => {
      const id = String(entry);
      const label =
        typeof enumNames[index] === "string" && enumNames[index].trim()
          ? String(enumNames[index])
          : String(entry);
      options.push({ id, label });
      values[id] = entry;
    });
    const titledOptions = multi ? target.anyOf ?? target.oneOf : target.oneOf;
    for (const item of Array.isArray(titledOptions) ? titledOptions : []) {
      const choice = asRecord(item);
      if (!choice || choice.const == null) continue;
      const id = String(choice.const);
      options.push({
        id,
        label: stringField(choice, "title") ?? id,
        ...(stringField(choice, "description")
          ? { description: stringField(choice, "description") }
          : {}),
      });
      values[id] = choice.const;
    }
    if (type === "boolean" && options.length === 0) {
      options.push({ id: "yes", label: "Yes" }, { id: "no", label: "No" });
      values.yes = true;
      values.no = false;
    }

    const prompt =
      stringField(field, "title") ??
      stringField(field, "description") ??
      key;
    questions.push({
      id: key,
      prompt,
      ...(stringField(field, "title") &&
      stringField(field, "description")
        ? { header: stringField(field, "title") }
        : {}),
      multiSelect: multi,
      allowCustom: options.length === 0,
      options,
    });
    if (type && !["string", "number", "integer", "boolean", "array"].includes(type)) {
      throw new Error(`Unsupported question field ${key}: ${type}`);
    }
    if (multi && options.length === 0) throw new Error(`Unsupported free-form array question: ${key}`);
    fields.push({ key, multi, values,
      required: Array.isArray(schema?.required) && schema.required.includes(key),
      ...(typeof field.minItems === "number" ? { minItems: field.minItems } : {}),
      ...(typeof field.maxItems === "number" ? { maxItems: field.maxItems } : {}),
      ...((type === "number" || type === "integer") ? {
        numberType: type,
        ...(typeof field.minimum === "number" ? { minimum: field.minimum } : {}),
        ...(typeof field.maximum === "number" ? { maximum: field.maximum } : {}),
        ...(typeof field.exclusiveMinimum === "number" ? { exclusiveMinimum: field.exclusiveMinimum } : {}),
        ...(typeof field.exclusiveMaximum === "number" ? { exclusiveMaximum: field.exclusiveMaximum } : {}),
        ...(typeof field.multipleOf === "number" ? { multipleOf: field.multipleOf } : {}),
      } : {}),
    });
  }
  if (questions.length === 0) return null;
  const title = stringField(inner ?? {}, "message");
  return { ...(title ? { title } : {}), questions, fields };
}

/** MCP elicitation result: `accept` carries schema values, anything else cancels. */
export function acpElicitationResult(
  reply: UserQuestionReply,
  questions: UserQuestion[],
  fields: AcpElicitField[],
): Record<string, unknown> {
  if (reply.kind !== "answered") return { action: "cancel" };
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const question = questions.find((item) => item.id === field.key);
    if (!question) continue;
    const custom = reply.custom?.[field.key]?.trim();
    const selected = reply.answers[field.key] ?? [];
    if (field.numberType && custom && question.allowCustom) {
      const number = Number(custom);
      if (!Number.isFinite(number) || (field.numberType === "integer" && !Number.isSafeInteger(number)) ||
          (field.minimum != null && number < field.minimum) ||
          (field.maximum != null && number > field.maximum) ||
          (field.exclusiveMinimum != null && number <= field.exclusiveMinimum) ||
          (field.exclusiveMaximum != null && number >= field.exclusiveMaximum) ||
          (field.multipleOf != null && (!(field.multipleOf > 0) || Math.abs(number / field.multipleOf - Math.round(number / field.multipleOf)) > 1e-9))) {
        throw new Error(`Invalid ${field.numberType} answer for ${field.key}`);
      }
      content[field.key] = number;
      continue;
    }
    if (selected.length === 0 && custom && question.allowCustom) {
      content[field.key] = custom;
      continue;
    }
    const values = selected.flatMap((id) => {
      if (id in field.values) return [field.values[id]];
      if (custom && question.allowCustom) return [custom];
      return [];
    });
    if (values.length === 0) {
      if (field.required) throw new Error(`Answer the required question: ${field.key}`);
      continue;
    }
    if (field.multi && ((field.minItems != null && values.length < field.minItems) ||
        (field.maxItems != null && values.length > field.maxItems))) {
      throw new Error(`Invalid number of selections for ${field.key}`);
    }
    content[field.key] = field.multi ? values : values[0];
  }
  if (Object.keys(content).length === 0) return { action: "cancel" };
  return { action: "accept", content };
}

export function sessionIdFromResult(result: unknown): string | undefined {
  const rec = asRecord(result);
  const id = rec?.sessionId ?? rec?.session_id ?? rec?.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/**
 * ACP terminal stop reasons that are not a clean `end_turn`. `cancelled` is
 * handled by the cancel path, so it never reaches this message.
 */
export function acpStopReasonMessage(
  provider: string,
  stopReason: string,
): string | undefined {
  switch (stopReason) {
    case "end_turn":
    case "":
    case "cancelled":
      return undefined;
    case "refusal":
      return `${provider} declined this turn.`;
    case "max_tokens":
      return `${provider} stopped: response reached the token limit.`;
    case "max_turn_requests":
      return `${provider} stopped: turn request limit reached.`;
    default:
      return `${provider} stopped: ${stopReason}.`;
  }
}

/**
 * Matches explicit auth-failure phrases rather than any "auth"/"credential"
 * substring, so routine error text (token refresh logs, `authorized`, a
 * tool's bare 403) doesn't get a spurious "not signed in" hint appended.
 */
const ACP_AUTH_PATTERN =
  /not (?:signed|logged) in|not authenticated|unauthori[sz]ed|authentication (?:required|failed|error)|(?:please|then|must) (?:log|sign) ?in|(?:log|sign) ?in (?:required|first|again|to continue)|(?:signed|logged) out|invalid (?:api key|access token|token|credentials?)|expired (?:token|credentials?|session)|(?:token|credentials?|session)(?:\s+(?:has|have|is))?\s+expired|(?:401|403)[^\n]*(?:unauthori[sz]ed|forbidden)|(?:unauthori[sz]ed|forbidden)[^\n]*\b(?:401|403)\b/i;

/** Wrap an initialize/session failure with provider-specific sign-in help. */
export function acpAuthError(
  provider: string,
  authHelp: string,
  error: unknown,
  verb = "start",
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (ACP_AUTH_PATTERN.test(detail)) {
    return new Error(`${detail.trim()}\n\n${authHelp}`);
  }
  if (/timed out/i.test(detail)) {
    return new Error(`${provider} did not answer. ${authHelp}`);
  }
  return new Error(`${provider} did not ${verb}. ${detail}`);
}

function usageFromUpdate(update: Record<string, unknown>): HarnessEvent | null {
  const usage =
    asRecord(update.usage) ??
    asRecord(update.tokenUsage) ??
    asRecord(update.token_usage) ??
    (hasUsageFields(update) ? update : null);
  if (!usage) return null;
  const used =
    numberField(usage, "used") ??
    numberField(usage, "usedTokens") ??
    numberField(usage, "used_tokens") ??
    numberField(usage, "totalTokens") ??
    numberField(usage, "total_tokens") ??
    sumNumbers(usage, [
      "inputTokens",
      "outputTokens",
      "input_tokens",
      "output_tokens",
    ]);
  const window =
    numberField(usage, "size") ??
    numberField(usage, "window") ??
    numberField(usage, "contextWindow") ??
    numberField(usage, "context_window") ??
    numberField(usage, "maxTokens") ??
    numberField(usage, "max_tokens");
  if (used == null && window == null) return null;
  return {
    type: "context",
    used: used ?? undefined,
    window: window ?? undefined,
  };
}

function hasUsageFields(rec: Record<string, unknown>): boolean {
  return (
    numberField(rec, "used") != null ||
    numberField(rec, "usedTokens") != null ||
    numberField(rec, "inputTokens") != null ||
    numberField(rec, "totalTokens") != null
  );
}

function planEvent(update: Record<string, unknown>): HarnessEvent | null {
  const entries = update.entries ?? update.plan;
  if (Array.isArray(entries)) {
    const items = entries.flatMap((item) => {
      const rec = asRecord(item);
      if (!rec) return [];
      const content = String(rec.content ?? rec.text ?? rec.title ?? "").trim();
      if (!content) return [];
      return [
        {
          text: content,
          status: normalizeTaskListStatus(rec.status),
        },
      ];
    });
    return { type: "tasks.updated", items };
  }
  if (typeof update.text === "string" && update.text.trim()) {
    return { type: "plan", text: update.text };
  }
  return null;
}

function toolLabel(rec: Record<string, unknown>): string | undefined {
  return (
    humanField(rec, "title") ??
    humanField(rec, "name") ??
    humanField(rec, "toolName") ??
    humanField(rec, "tool_name")
  );
}

function toolDetail(
  update: Record<string, unknown>,
  tool: Record<string, unknown>,
): string | undefined {
  const content =
    textFromContent(update.content, "\n") ||
    textFromContent(tool.content, "\n");
  if (content.trim()) return cap(content);
  const output = update.rawOutput ?? tool.rawOutput;
  if (typeof output === "string" && output.trim()) return cap(output);
  const outputText = textFromContent(output);
  return outputText.trim() ? cap(outputText) : undefined;
}

function cap(value: string, max = 8_000): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…`;
}

function pickOption(optionIds: string[], preferred: string[]): string | null {
  for (const id of preferred) {
    if (optionIds.includes(id)) return id;
  }
  return null;
}

function humanField(
  rec: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = stringField(rec, key);
  if (!value || looksLikeCallId(value)) return undefined;
  return value;
}

function looksLikeCallId(value: string): boolean {
  const text = value.trim();
  return (
    /^(call[-_]?|tool[-_])[a-z0-9_-]+$/i.test(text) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      text,
    )
  );
}

function textFromContent(content: unknown, separator = ""): string {
  if (typeof content === "string") return content;
  const rec = asRecord(content);
  if (rec && typeof rec.text === "string") return rec.text;
  if (rec && rec.content != null) return textFromContent(rec.content, separator);
  if (Array.isArray(content)) {
    return content
      .map((item) => textFromContent(item, separator))
      .filter(Boolean)
      .join(separator);
  }
  return "";
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

function numberField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  if (!rec) return undefined;
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumNumbers(
  rec: Record<string, unknown>,
  keys: string[],
): number | undefined {
  let total = 0;
  let found = false;
  for (const key of keys) {
    const value = numberField(rec, key);
    if (value == null) continue;
    total += value;
    found = true;
  }
  return found ? total : undefined;
}

/** Only a missing method permits trying an older control; policy failures do not. */
export function acpUnsupportedControl(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === -32601 ||
    /method not found|not implemented|unknown method/i.test(error instanceof Error ? error.message : String(error));
}

export function acpAssertConfigApplied(
  options: { id: string; currentValue?: string | boolean }[], id: string, value: string | boolean,
): void {
  const current = options.find((option) => option.id === id)?.currentValue;
  if (current != null && String(current) !== String(value)) {
    throw new Error(`Agent did not apply ${id}=${value} (still ${current}). Pick a supported setting before sending.`);
  }
}
