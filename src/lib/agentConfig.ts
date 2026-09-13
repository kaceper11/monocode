import { invoke } from "@tauri-apps/api/core";

/**
 * Agent environment inventory — MCP servers, plugins, hooks, and instruction
 * files discovered across harness config locations on disk. Entries are
 * metadata only: commands and hook scripts are never executed, and env values
 * are never read out of config files.
 */

export type ToggleRef = {
  file: string;
  format: "json" | "toml";
  path: string[];
  member: string;
  invert: boolean;
};

/**
 * Where and how an entry can be removed. `"file"` means the entry is itself a
 * file/directory, renamed to `<name>.monocode-bak` so removal stays
 * recoverable. `arrayItem` removes one element of the list at `path`.
 */
export type RemoveRef = {
  file: string;
  format: "json" | "toml" | "file";
  path: string[];
  arrayItem?: string | null;
  expect?: string | null;
};

export type McpServerEntry = {
  name: string;
  /** "project" | "user" | "local" */
  scope: string;
  file: string;
  /** "stdio" | "http" | "sse" */
  transport: string;
  summary: string;
  detail: string | null;
  /**
   * Provider-native gate when one exists. `null` means the provider loads the
   * server unconditionally — or, for Claude `.mcp.json` entries, that the
   * server is still waiting for approval.
   */
  enabled: boolean | null;
  toggle: ToggleRef | null;
  remove: RemoveRef | null;
};

export type PluginEntry = {
  id: string;
  /** "plugin" | "marketplace" | "extension" */
  kind: string;
  scope: string;
  file: string;
  detail: string | null;
  installed: boolean;
  /** Forced by a managed (admin) settings file — user toggles are ignored. */
  managed: boolean;
  enabled: boolean | null;
  toggle: ToggleRef | null;
  remove: RemoveRef | null;
};

export type HookRef = {
  path: string;
  /** `null` when the path contains an unresolved environment variable. */
  exists: boolean | null;
};

export type HookEntry = {
  event: string;
  matcher: string | null;
  /** "command" | "prompt" */
  kind: string;
  command: string | null;
  file: string;
  scope: string;
  refs: HookRef[];
  remove: RemoveRef | null;
};

export type InstructionEntry = {
  path: string;
  name: string;
  /** "rules" | "subagent" | "command" */
  kind: string;
  scope: string;
  consumers: string[];
  size: number;
};

export type ConfigFileEntry = {
  path: string;
  kind: string;
  size: number;
};

export type ProviderExtensions = {
  provider: string;
  /** True when the provider's config directory or files exist on disk. */
  detected: boolean;
  mcpServers: McpServerEntry[];
  plugins: PluginEntry[];
  hooks: HookEntry[];
  files: ConfigFileEntry[];
};

export type AgentConfigInventory = {
  providers: ProviderExtensions[];
  instructions: InstructionEntry[];
};

export function agentConfigInventory(cwd: string): Promise<AgentConfigInventory> {
  return invoke<AgentConfigInventory>("agent_config_inventory", { cwd });
}

/**
 * Flip a provider-native enable flag. The backend validates that the target is
 * a known enable/disable member of a known config section inside the project
 * or home directory of the scanned host, and keeps a `.monocode-bak` copy.
 */
export function agentConfigSetEnabled(
  cwd: string,
  toggle: ToggleRef,
  enabled: boolean,
): Promise<void> {
  return invoke<void>("agent_config_set_enabled", { cwd, toggle, enabled });
}

/**
 * Remove an entry from its config file — a JSON member or list element, a
 * TOML table or member — or rename a standalone file to `.monocode-bak`.
 * Same project/home bounds and `.monocode-bak` backup as the toggle path.
 */
export function agentConfigRemove(cwd: string, remove: RemoveRef): Promise<void> {
  return invoke<void>("agent_config_remove", { cwd, remove });
}
