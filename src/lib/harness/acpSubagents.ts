import type { HarnessEvent } from "./types";
import {
  agentToolTitle,
  isAgentTool,
  isAgentToolName,
  mergeToolPreview,
} from "./preview";

type Step = Extract<HarnessEvent, { type: "agent.step" }>;

/** Route explicitly attributed ACP child activity without mixing parent text. */
export class AcpSubagents {
  private tools = new Set<string>();
  private owners = new Map<string, string>();
  /**
   * Subagent run/agent ids → the call that spawned them. Some ACP servers
   * (Devin's `cognition.ai/subagent_*` meta) mark child updates with the run
   * id instead of the parent's toolCallId; the spawn call's own meta names
   * the run ids it created.
   */
  private aliases = new Map<string, string>();
  private pending = new Map<string, Step[]>();
  private prose = new Map<
    string,
    { id: number; kind: "message" | "reasoning"; text: string }
  >();
  private sequence = 0;

  isChild(params: unknown): boolean {
    return !!this.parent(params);
  }

  route(params: unknown, events: HarnessEvent[]): HarnessEvent[] {
    const parent = this.parent(params);
    if (!parent) {
      return events.flatMap<HarnessEvent>((event) => {
        if (event.type !== "tool.started" && event.type !== "tool.updated")
          return [event];
        this.tools.add(event.callId);
        this.indexAliases(params, event.callId);
        const backlog = this.pending.get(event.callId) ?? [];
        this.pending.delete(event.callId);
        return [event, ...backlog];
      });
    }
    const output: Step[] = [];
    for (const event of events) {
      if (event.type === "tool.started" || event.type === "tool.updated") {
        this.owners.set(event.callId, parent);
        this.indexAliases(params, event.callId);
        this.prose.delete(parent);
        output.push({
          type: "agent.step",
          callId: parent,
          stepId: `tool:${event.callId}`,
          kind: "tool",
          text: event.title ?? "",
          toolKind: event.kind,
          status: event.status,
          preview: event.preview,
        });
      } else if (
        event.type === "message.delta" ||
        event.type === "reasoning.delta"
      ) {
        const kind = event.type === "message.delta" ? "message" : "reasoning";
        let prose = this.prose.get(parent);
        if (!prose || prose.kind !== kind)
          prose = { id: ++this.sequence, kind, text: "" };
        const update = record(record(params)?.update) ?? record(params);
        const type =
          update?.sessionUpdate ?? update?.session_update ?? update?.type;
        const snapshot = type === "agent_message" || type === "agent_thought";
        prose.text = (snapshot ? event.text : prose.text + event.text).slice(
          0,
          2_000,
        );
        this.prose.set(parent, prose);
        output.push({
          type: "agent.step",
          callId: parent,
          stepId: `${kind}:${prose.id}`,
          kind,
          text: prose.text,
        });
      }
      // Child plans, context meters and lifecycle notifications belong to the
      // child too; they must never replace or finish the parent's own work.
    }
    if (this.tools.has(parent)) return output;
    const backlog = this.pending.get(parent) ?? [];
    for (const step of output) {
      const index = backlog.findIndex((entry) => entry.stepId === step.stepId);
      if (index < 0) backlog.push(step);
      else
        backlog[index] = {
          ...backlog[index],
          ...step,
          text: step.text || backlog[index].text,
          toolKind: step.toolKind ?? backlog[index].toolKind,
          status: step.status ?? backlog[index].status,
          preview: mergeToolPreview(step.preview, backlog[index].preview),
        };
    }
    this.pending.set(parent, backlog.slice(-64));
    if (this.pending.size > 32)
      this.pending.delete(this.pending.keys().next().value!);
    return [];
  }

  private parent(params: unknown): string | undefined {
    const envelope = record(params);
    const update = record(envelope?.update) ?? envelope;
    const tool = record(update?.toolCall) ?? record(update?.tool_call);
    const sources = [tool, update, envelope];
    const id = text(
      tool?.toolCallId ??
        tool?.tool_call_id ??
        update?.toolCallId ??
        update?.tool_call_id,
    );
    let parent: string | undefined;
    for (const source of sources) {
      const meta = record(source?._meta);
      for (const entry of [
        source,
        meta,
        record(meta?.cursor),
        record(meta?.grok),
        record(meta?.["x.ai"]),
        record(meta?.fx),
        record(meta?.copilot),
        record(meta?.github),
        record(meta?.devin),
        record(meta?.["cognition.ai"]),
      ]) {
        parent = text(entry?.parentToolCallId ?? entry?.parent_tool_call_id);
        if (parent) break;
      }
      if (!parent && meta) parent = this.childContext(meta);
      if (parent) break;
    }
    parent ??= id ? this.owners.get(id) : undefined;
    if (!parent || parent === id) return undefined;
    const seen = new Set<string>();
    while (this.owners.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = this.owners.get(parent)!;
    }
    return seen.has(parent) ? undefined : parent;
  }

  /**
   * A run/agent/chain id is only useful once it has been tied to a spawn
   * call — resolve it through the alias table, then known parent calls, then
   * the ownership map (a ref naming a nested child still lands on the root).
   */
  private refTarget(ref: string | undefined): string | undefined {
    if (!ref) return undefined;
    return (
      this.aliases.get(ref) ??
      (this.tools.has(ref) ? ref : undefined) ??
      this.owners.get(ref)
    );
  }

  /**
   * Vendor-marked child context: `cognition.ai/subagent_context` carries
   * `{parentAgentId, runId}`; Copilot/GitHub shapes may nest under their own
   * `_meta` key or use flat `subagent/*` attribute keys. Anything that looks
   * like a run/agent id resolves through the alias table — the spawn call's
   * `subagent_started` meta is what populates it.
   */
  private childContext(meta: Record<string, unknown>): string | undefined {
    const ctx =
      record(meta["cognition.ai/subagent_context"]) ??
      record(meta.subagent_context) ??
      record(meta.subagentContext);
    for (const key of [
      "runId",
      "run_id",
      "agentId",
      "agent_id",
      "subagentId",
      "subagent_id",
      "toolCallId",
      "tool_call_id",
      "parentToolCallId",
      "parent_tool_call_id",
      "id",
    ]) {
      const found = this.refTarget(text(ctx?.[key]));
      if (found) return found;
    }
    for (const [key, value] of Object.entries(meta)) {
      const norm = key.toLowerCase().replace(/[^a-z]/g, "");
      if (norm.endsWith("parenttoolcallid")) {
        const ref = text(value);
        const found = ref ? (this.refTarget(ref) ?? ref) : undefined;
        if (found) return found;
        continue;
      }
      if (
        /subagent|cognitionai|copilot|github|devin/.test(norm) &&
        /(runid|agentid|chainnodeid|toolcallid)$/.test(norm)
      ) {
        const found = this.refTarget(text(value));
        if (found) return found;
      }
    }
    return undefined;
  }

  /**
   * The spawn call's meta names the run it created — Devin carries
   * `cognition.ai/subagent_started` (`agentId`, `runId`, `model`, `profile`)
   * and flat `subagent/*` attribute keys. Indexing those ids here lets later
   * child updates that only carry the run id still find their parent row.
   */
  private indexAliases(params: unknown, callId: string): void {
    const envelope = record(params);
    const update = record(envelope?.update) ?? envelope;
    const tool = record(update?.toolCall) ?? record(update?.tool_call);
    for (const source of [tool, update, envelope]) {
      const meta = record(source?._meta);
      if (!meta) continue;
      const started =
        record(meta["cognition.ai/subagent_started"]) ??
        record(meta.subagent_started) ??
        record(meta.subagentStarted);
      if (started) {
        for (const key of [
          "agentId",
          "agent_id",
          "runId",
          "run_id",
          "id",
          "subagentId",
          "subagent_id",
        ]) {
          this.remember(text(started[key]), callId);
        }
      }
      for (const [key, value] of Object.entries(meta)) {
        const norm = key.toLowerCase().replace(/[^a-z]/g, "");
        if (
          /^(subagent|agent)[/.]/.test(key) &&
          /(runid|agentid|chainnodeid|subagentid)$/.test(norm)
        ) {
          this.remember(text(value), callId);
        }
      }
    }
  }

  private remember(alias: string | undefined, callId: string): void {
    if (!alias || alias === callId) return;
    this.aliases.delete(alias);
    this.aliases.set(alias, callId);
    if (this.aliases.size > 256) {
      this.aliases.delete(this.aliases.keys().next().value!);
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Some ACP servers classify delegation as `other` and identify it in input. */
export function acpAgentInfo(
  update: Record<string, unknown>,
  tool: Record<string, unknown>,
  kind?: string,
  title?: string,
  nativeInput?: unknown,
): { kind: "agent"; title: string; agentModel?: string } | undefined {
  const input = record(
    nativeInput ??
      update.rawInput ??
      tool.rawInput ??
      update.raw_input ??
      tool.raw_input ??
      update.input ??
      tool.input,
  );
  const meta = record(update._meta) ?? record(tool._meta);
  // Devin marks the run_subagent call with `cognition.ai/subagent_started`
  // (`task`, `profile`, `model`, `depth`, `isBackground`) and/or flat
  // `subagent/*` attribute keys.
  const started =
    record(meta?.["cognition.ai/subagent_started"]) ??
    record(meta?.subagent_started) ??
    record(meta?.subagentStarted);
  const profile =
    text(started?.profile) ??
    text(started?.profileName) ??
    text(meta?.["subagent/profile_name"]) ??
    text(meta?.["subagent/profile"]);
  const name = text(
    input?._toolName ??
      input?.toolName ??
      update.name ??
      tool.name ??
      (started || profile ? "subagent" : undefined),
  );
  if (
    !isAgentTool(kind, title) &&
    !(name && isAgentToolName(name)) &&
    !started &&
    !profile
  ) {
    return undefined;
  }
  const model =
    text(started?.model) ?? text(meta?.["subagent/model"]) ?? text(input?.model);
  const label =
    text(started?.task) ?? text(started?.title) ?? text(input?.task);
  return {
    kind: "agent",
    title:
      label ??
      agentToolTitle(
        { ...(input ?? {}), ...(profile ? { agentType: profile } : {}) },
        title,
      ),
    ...(model ? { agentModel: model } : {}),
  };
}
