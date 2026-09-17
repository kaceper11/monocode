import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  FolderOpen,
  RefreshCw,
  Search,
  Trash2,
} from "../chrome/icons";
import { HarnessIcon } from "../chrome/HarnessIcon";
import { Toggle } from "../chrome/Toggle";
import { ask } from "../lib/dialogs";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { copyText } from "../lib/clipboard";
import {
  agentConfigInventory,
  agentConfigRemove,
  agentConfigSetEnabled,
  type AgentConfigInventory,
  type HookEntry,
  type InstructionEntry,
  type McpServerEntry,
  type PluginEntry,
  type ProviderExtensions,
  type RemoveRef,
  type ToggleRef,
} from "../lib/agentConfig";
import { HARNESS_TITLE, type HarnessId } from "../lib/session";
import type { OpenFileFn } from "../lib/search";
import { SkillsPage } from "./SkillsPage";

type ExtensionTab = "skills" | "mcp" | "plugins" | "instructions" | "hooks";

const TABS: { id: ExtensionTab; label: string }[] = [
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP servers" },
  { id: "plugins", label: "Plugins" },
  { id: "instructions", label: "Instructions" },
  { id: "hooks", label: "Hooks" },
];

const SCOPE_LABEL: Record<string, string> = {
  project: "Project",
  user: "Personal",
  local: "Local",
  managed: "Managed",
};

function providerTitle(provider: string): string {
  return (HARNESS_TITLE as Record<string, string>)[provider] ?? provider;
}

function ProviderMark({ provider }: { provider: string }) {
  if (!(provider in HARNESS_TITLE)) return null;
  return <HarnessIcon harness={provider as HarnessId} className="size-3.5" />;
}

/** Inspect and toggle agent extensions without editing provider files by hand. */
export function ExtensionsPage({
  cwd,
  header,
  onOpenFile,
}: {
  cwd: string;
  header?: ReactNode;
  onOpenFile?: OpenFileFn;
}): ReactNode {
  const [tab, setTab] = useState<ExtensionTab>("skills");
  const [inventory, setInventory] = useState<AgentConfigInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  // Files with an in-flight mutation — every row bound to one is disabled so
  // two read-modify-writes on the same file cannot interleave.
  const [busyFiles, setBusyFiles] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);
  // Scan once per (cwd, reload) — tab switches alone must not rescan.
  const fetchedFor = useRef("");

  useEffect(() => {
    if (tab === "skills") return;
    const key = `${cwd}${reload}`;
    if (fetchedFor.current === key) return;
    const prev = fetchedFor.current;
    const projectChanged =
      prev === "" || prev.slice(0, prev.lastIndexOf(" ")) !== cwd;
    fetchedFor.current = key;
    if (projectChanged) setInventory(null);
    let cancelled = false;
    let settled = false;
    agentConfigInventory(cwd)
      .then((next) => {
        settled = true;
        if (cancelled) return;
        setInventory(next);
        setError(null);
      })
      .catch((err: unknown) => {
        settled = true;
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (cancelled) return;
        // Mutations stay pending until their refetch lands — removed rows keep
        // spinning instead of briefly re-enabling against a stale list.
        setPending(new Set());
        setBusyFiles(new Set());
      });
    return () => {
      cancelled = true;
      // Only an in-flight scan that never delivered needs a retry; once the
      // result landed, keep the key so tab hops don't rescan.
      if (!settled && fetchedFor.current === key) fetchedFor.current = "";
    };
  }, [cwd, reload, tab]);

  useEffect(() => {
    setActionError(null);
  }, [tab]);

  const mutationFailed = (key: string, file: string, message: string): void => {
    setActionError(message);
    setPending((keys) => {
      const next = new Set(keys);
      next.delete(key);
      return next;
    });
    setBusyFiles((files) => {
      const next = new Set(files);
      next.delete(file);
      return next;
    });
  };

  const onToggle = (toggle: ToggleRef, enabled: boolean): void => {
    const key = toggleKey(toggle);
    setPending((keys) => new Set(keys).add(key));
    setBusyFiles((files) => new Set(files).add(toggle.file));
    setActionError(null);
    void agentConfigSetEnabled(cwd, toggle, enabled)
      .then(() => setReload((value) => value + 1))
      .catch((err: unknown) => {
        mutationFailed(
          key,
          toggle.file,
          `Could not update the config: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };

  const onRemove = (remove: RemoveRef, label: string): void => {
    const text =
      remove.format === "file"
        ? `Remove ${remove.file}? It is renamed to ${remove.file}.monocode-bak so you can restore it.`
        : `Remove ${label} from ${remove.file}? A backup is kept as ${remove.file}.monocode-bak.`;
    void (async () => {
      if (
        !(await ask(text, {
          title: "MonoCode",
          kind: "warning",
          okLabel: "Remove",
        }))
      )
        return;
      const key = removeKey(remove);
      setPending((keys) => new Set(keys).add(key));
      setBusyFiles((files) => new Set(files).add(remove.file));
      setActionError(null);
      void agentConfigRemove(cwd, remove)
        .then(() => setReload((value) => value + 1))
        .catch((err: unknown) => {
          mutationFailed(
            key,
            remove.file,
            `Could not remove it: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    })();
  };

  const onReveal = (path: string): void => {
    setActionError(null);
    // explorer.exe needs the backslash UNC form for WSL paths.
    const revealPath = path.startsWith("//wsl.localhost/")
      ? `\\\\${path.slice(2).replace(/\//g, "\\")}`
      : path;
    void revealItemInDir(revealPath).catch((err: unknown) => {
      setActionError(
        `Could not open the folder: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  const onCopyPath = (path: string): void => {
    setActionError(null);
    // Copy the UNC form so it pastes straight into Windows tools.
    const copyPath = path.startsWith("//wsl.localhost/")
      ? `\\\\${path.slice(2).replace(/\//g, "\\")}`
      : path;
    void copyText(copyPath).catch(() => {
      setActionError("Could not copy the path to the clipboard.");
    });
  };

  const onOpen = (path: string): void => {
    if (!onOpenFile) {
      onReveal(path);
      return;
    }
    onOpenFile(path, undefined, { exact: true });
  };

  const tabBar = (
    <div
      role="tablist"
      aria-label="Extension kind"
      className="mt-4 inline-flex gap-0.5 rounded-md border border-content/10 p-0.5 text-[12px]"
    >
      {TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          onClick={() => setTab(item.id)}
          className={`whitespace-nowrap rounded-[5px] px-2.5 py-1 ${
            tab === item.id
              ? "bg-content/10 text-content"
              : "text-content/50 hover:text-content"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );

  if (tab === "skills") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SkillsPage
          cwd={cwd}
          header={
            <>
              {header}
              {tabBar}
            </>
          }
        />
      </div>
    );
  }

  return (
    <InventoryTab
      tab={tab}
      header={header}
      tabBar={tabBar}
      inventory={inventory}
      error={error}
      actionError={actionError}
      pending={pending}
      busyFiles={busyFiles}
      onRefresh={() => setReload((value) => value + 1)}
      onToggle={onToggle}
      onRemove={onRemove}
      onReveal={onReveal}
      onCopyPath={onCopyPath}
      onOpen={onOpen}
    />
  );
}

function toggleKey(toggle: ToggleRef): string {
  return `${toggle.file}${toggle.path.join(".")}${toggle.member}`;
}

function removeKey(remove: RemoveRef): string {
  return `R:${remove.file}${remove.path.join(".")}${remove.arrayItem ?? ""}`;
}

/** Removal of a standalone file/directory (renamed to .monocode-bak). */
function fileRemove(path: string): RemoveRef {
  return { file: path, format: "file", path: [], arrayItem: null };
}

function InventoryTab({
  tab,
  header,
  tabBar,
  inventory,
  error,
  actionError,
  pending,
  busyFiles,
  onRefresh,
  onToggle,
  onRemove,
  onReveal,
  onCopyPath,
  onOpen,
}: {
  tab: Exclude<ExtensionTab, "skills">;
  header?: ReactNode;
  tabBar: ReactNode;
  inventory: AgentConfigInventory | null;
  error: string | null;
  actionError: string | null;
  pending: Set<string>;
  busyFiles: Set<string>;
  onRefresh: () => void;
  onToggle: (toggle: ToggleRef, enabled: boolean) => void;
  onRemove: (remove: RemoveRef, label: string) => void;
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
  onOpen: (path: string) => void;
}): ReactNode {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const needle = query.trim().toLowerCase();

  const counts = useMemo(() => {
    if (!inventory) return { shown: 0, total: 0 };
    if (tab === "instructions") {
      const all = inventory.instructions;
      const shown = all.filter((entry) => instructionHit(entry, needle));
      return { shown: shown.length, total: all.length };
    }
    const pick = (provider: ProviderExtensions) =>
      tab === "mcp"
        ? provider.mcpServers.length
        : tab === "plugins"
          ? provider.plugins.length
          : provider.hooks.length;
    const shown = inventory.providers.reduce(
      (sum, provider) => sum + filteredEntries(provider, tab, needle).length,
      0,
    );
    return { shown, total: inventory.providers.reduce((s, p) => s + pick(p), 0) };
  }, [inventory, tab, needle]);

  const unit =
    tab === "mcp"
      ? "server"
      : tab === "plugins"
        ? "plugin"
        : tab === "instructions"
          ? "file"
          : "hook";

  return (
    <div
      ref={lockOverscroll}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none"
    >
      <div className="mx-auto w-full max-w-5xl px-8 py-8">
        {header}
        {tabBar}
        <div className="flex flex-wrap items-center gap-3 pb-3 pt-4">
          <span className="shrink-0 text-[12px] text-content/40 tabular-nums">
            {inventory == null
              ? "…"
              : needle
                ? `${counts.shown} of ${counts.total} ${counts.total === 1 ? unit : `${unit}s`}`
                : `${counts.shown} ${counts.shown === 1 ? unit : `${unit}s`}`}
          </span>
          <label className="flex h-7 w-52 min-w-0 flex-1 items-center gap-2 rounded-md border border-content/10 px-2 text-content/45 focus-within:border-content/20">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter"
              aria-label={`Filter ${unit}s`}
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
            />
          </label>
          <button
            type="button"
            aria-label="Refresh inventory"
            title="Rescan provider config"
            disabled={inventory === null && !error}
            onClick={onRefresh}
            className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
          >
            <RefreshCw className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        {actionError ? (
          <p role="alert" className="pb-3 text-[12px] text-red-400">
            {actionError}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="pb-3 text-[12px] text-red-400">
            {error}
          </p>
        ) : null}
        {inventory == null ? (
          error == null ? (
            <p role="status" className="text-[12px] text-content/45">
              Scanning provider config…
            </p>
          ) : null
        ) : tab === "instructions" ? (
          <InstructionsList
            entries={inventory.instructions}
            needle={needle}
            pending={pending}
            busyFiles={busyFiles}
            onRemove={onRemove}
            onCopyPath={onCopyPath}
            onReveal={onReveal}
            onOpen={onOpen}
          />
        ) : (
          <ProviderGroups
            providers={inventory.providers}
            tab={tab}
            needle={needle}
            pending={pending}
            busyFiles={busyFiles}
            collapsed={collapsed}
            onCollapseChange={setCollapsed}
            onToggle={onToggle}
            onRemove={onRemove}
            onCopyPath={onCopyPath}
            onReveal={onReveal}
            onOpen={onOpen}
          />
        )}

        <p className="pt-3 text-[12px] text-content/40">
          These entries show what is configured, not whether a server is connected.
          Reconnect or start a new provider session to load configuration changes.{" "}
          Nothing here runs hooks or starts servers. Toggles write a single
          flag in the provider's own config; removal cuts the entry or renames
          the file — every change keeps a{" "}
          <span className="font-sans">.monocode-bak</span> copy. Entries without
          a switch have no native enable flag in that file. Env values are
          never displayed.
        </p>
      </div>
    </div>
  );
}

function filteredEntries(
  provider: ProviderExtensions,
  tab: Exclude<ExtensionTab, "skills" | "instructions">,
  needle: string,
): (McpServerEntry | PluginEntry | HookEntry)[] {
  const entries: (McpServerEntry | PluginEntry | HookEntry)[] =
    tab === "mcp"
      ? provider.mcpServers
      : tab === "plugins"
        ? provider.plugins
        : provider.hooks;
  if (!needle) return entries;
  return entries.filter((entry) => entryHit(provider.provider, entry, needle));
}

function entryHit(
  provider: string,
  entry: McpServerEntry | PluginEntry | HookEntry,
  needle: string,
): boolean {
  const haystacks = [
    provider,
    providerTitle(provider),
    entry.scope,
    entry.file,
    "name" in entry ? entry.name : "",
    "id" in entry ? entry.id : "",
    "kind" in entry ? entry.kind : "",
    "summary" in entry ? entry.summary : "",
    "detail" in entry ? (entry.detail ?? "") : "",
    "event" in entry ? entry.event : "",
    "matcher" in entry ? (entry.matcher ?? "") : "",
    "command" in entry ? (entry.command ?? "") : "",
  ];
  return haystacks.some((text) => text.toLowerCase().includes(needle));
}

function instructionHit(entry: InstructionEntry, needle: string): boolean {
  if (!needle) return true;
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.path.toLowerCase().includes(needle) ||
    entry.kind.includes(needle) ||
    entry.scope.includes(needle) ||
    entry.consumers.some((c) => c.includes(needle) || providerTitle(c).toLowerCase().includes(needle))
  );
}

function entryKey(
  entry: McpServerEntry | PluginEntry | HookEntry,
): string {
  if ("event" in entry) {
    // One event can carry several matcher groups / hooks per file.
    return `${entry.scope}:${entry.file}:${entry.event}:${entry.matcher ?? ""}:${entry.command ?? ""}`;
  }
  const id = "name" in entry ? entry.name : entry.id;
  return `${entry.scope}:${entry.file}:${id}`;
}

function ProviderGroups({
  providers,
  tab,
  needle,
  pending,
  busyFiles,
  collapsed,
  onCollapseChange,
  onToggle,
  onRemove,
  onCopyPath,
  onReveal,
  onOpen,
}: {
  providers: ProviderExtensions[];
  tab: Exclude<ExtensionTab, "skills" | "instructions">;
  needle: string;
  pending: Set<string>;
  busyFiles: Set<string>;
  collapsed: Set<string>;
  onCollapseChange: (next: Set<string>) => void;
  onToggle: (toggle: ToggleRef, enabled: boolean) => void;
  onRemove: (remove: RemoveRef, label: string) => void;
  onCopyPath: (path: string) => void;
  onReveal: (path: string) => void;
  onOpen: (path: string) => void;
}): ReactNode {
  const groups = providers
    .map((provider) => {
      const entries = filteredEntries(provider, tab, needle);
      const entryFiles = new Set(entries.map((entry) => entry.file));
      // A file carrying entries in ANY category must not be offered for
      // removal — on another tab it would silently take those with it.
      const allEntryFiles = new Set(
        [...provider.mcpServers, ...provider.plugins, ...provider.hooks].map(
          (entry) => entry.file,
        ),
      );
      const files = (
        needle
          ? provider.files.filter((f) =>
              f.path.toLowerCase().includes(needle),
            )
          : provider.files
      )
        .filter((f) => entries.length === 0 || !entryFiles.has(f.path))
        .map((f) => ({
          file: f,
          removable: !allEntryFiles.has(f.path),
        }));
      return { provider, entries, files };
    })
    .filter((group) => group.entries.length > 0 || group.files.length > 0);
  const toggleCollapsed = (provider: string): void => {
    const next = new Set(collapsed);
    if (next.has(provider)) {
      next.delete(provider);
    } else {
      next.add(provider);
    }
    onCollapseChange(next);
  };

  if (groups.length === 0) {
    return (
      <p className="px-1 py-3 text-[12px] text-content/45">
        {needle ? "No matching entries" : "Nothing found in provider config"}
      </p>
    );
  }
  return (
    <div className="space-y-5">
      {groups.map(({ provider, entries, files }) => (
        <section key={provider.provider}>
          <h3 className="pb-1.5 text-[11px] font-medium uppercase tracking-wide text-content/45">
            <button
              type="button"
              aria-expanded={!collapsed.has(provider.provider)}
              onClick={() => toggleCollapsed(provider.provider)}
              className="flex w-full items-center gap-1.5 rounded text-left hover:text-content/70"
            >
              {collapsed.has(provider.provider) ? (
                <ChevronRight className="size-3 shrink-0" strokeWidth={2} />
              ) : (
                <ChevronDown className="size-3 shrink-0" strokeWidth={2} />
              )}
              <ProviderMark provider={provider.provider} />
              {providerTitle(provider.provider)}
              <span className="font-normal normal-case tracking-normal text-content/30">
                {entries.length + files.length}
              </span>
              {!provider.detected ? (
                <span className="font-normal normal-case tracking-normal text-content/30">
                  — no install found, config files only
                </span>
              ) : null}
            </button>
          </h3>
          {collapsed.has(provider.provider) ? null : (
          <div className="overflow-hidden rounded-lg border border-content/10">
            {entries.map((entry, index) => (
              <div
                key={`${entryKey(entry)}#${index}`}
                className="border-b border-content/5 px-3 py-2 last:border-b-0"
              >
                {tab === "mcp" ? (
                  <McpRow
                    entry={entry as McpServerEntry}
                    provider={provider.provider}
                    pending={pending}
                    busyFiles={busyFiles}
                    onToggle={onToggle}
                    onRemove={onRemove}
                    onCopyPath={onCopyPath}
                    onReveal={onReveal}
                    onOpen={onOpen}
                  />
                ) : tab === "plugins" ? (
                  <PluginRow
                    entry={entry as PluginEntry}
                    pending={pending}
                    busyFiles={busyFiles}
                    onToggle={onToggle}
                    onRemove={onRemove}
                    onCopyPath={onCopyPath}
                    onReveal={onReveal}
                    onOpen={onOpen}
                  />
                ) : (
                  <HookRow
                    entry={entry as HookEntry}
                    pending={pending}
                    busyFiles={busyFiles}
                    onRemove={onRemove}
                    onCopyPath={onCopyPath}
                    onReveal={onReveal}
                    onOpen={onOpen}
                  />
                )}
              </div>
            ))}
            {files.length > 0 ? (
              <div
                className={`px-3 py-2 ${entries.length > 0 ? "border-t border-content/10 bg-content/[0.02]" : ""}`}
              >
                {files.map(({ file, removable }) => (
                  <div
                    key={file.path}
                    className="flex items-center gap-1 py-0.5"
                  >
                    <p
                      className="min-w-0 flex-1 truncate font-sans text-[11px] text-content/35"
                      title={file.path}
                    >
                      {file.path}
                      {` · ${file.kind} · ${formatSize(file.size)}`}
                    </p>
                    <RemoveButton
                      remove={removable ? fileRemove(file.path) : null}
                      label={file.path.split("/").pop() ?? file.path}
                      pending={pending}
                      busyFiles={busyFiles}
                      onRemove={onRemove}
                    />
                    <RowActions
                      path={file.path}
                      onCopyPath={onCopyPath}
                      onReveal={onReveal}
                      onOpen={onOpen}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          )}
        </section>
      ))}
    </div>
  );
}

function RemoveButton({
  remove,
  label,
  pending,
  busyFiles,
  onRemove,
}: {
  remove: RemoveRef | null;
  /** Entry name, used for the confirm dialog and accessible label. */
  label: string;
  pending: Set<string>;
  busyFiles: Set<string>;
  onRemove: (remove: RemoveRef, label: string) => void;
}) {
  if (!remove) return null;
  // A pending action on this file locks every other row bound to it — the
  // backend does unlocked read-modify-write, so concurrent edits on the same
  // file could resurrect a removed entry.
  const disabled =
    busyFiles.has(remove.file) || pending.has(removeKey(remove));
  return (
    <button
      type="button"
      aria-label={`Remove ${label}`}
      title={remove.format === "file" ? "Remove file" : "Remove from config"}
      disabled={disabled}
      onClick={() => onRemove(remove, label)}
      className="grid size-5 shrink-0 place-items-center rounded text-content/40 hover:bg-red-400/15 hover:text-red-300 disabled:opacity-40"
    >
      <Trash2 className="size-3" strokeWidth={1.75} />
    </button>
  );
}

function ScopeBadge({ scope }: { scope: string }) {
  return (
    <span className="shrink-0 rounded-full bg-content/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-content/60">
      {SCOPE_LABEL[scope] ?? scope}
    </span>
  );
}

function RowActions({
  path,
  onCopyPath,
  onReveal,
  onOpen,
}: {
  path: string;
  onCopyPath: (path: string) => void;
  onReveal: (path: string) => void;
  onOpen?: (path: string) => void;
}) {
  return (
    <>
      {onOpen ? (
        <button
          type="button"
          aria-label={`Open ${path}`}
          title="Open in editor"
          onClick={() => onOpen(path)}
          className="grid size-5 shrink-0 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content"
        >
          <Eye className="size-3" strokeWidth={1.75} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`Copy path ${path}`}
        title="Copy path"
        onClick={() => onCopyPath(path)}
        className="grid size-5 shrink-0 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content"
      >
        <Copy className="size-3" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label={`Reveal ${path} in file explorer`}
        title="Reveal in file manager"
        onClick={() => onReveal(path)}
        className="grid size-5 shrink-0 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content"
      >
        <FolderOpen className="size-3" strokeWidth={1.75} />
      </button>
    </>
  );
}

function GateControl({
  toggle,
  enabled,
  readonly,
  pending,
  busyFiles,
  name,
  onToggle,
}: {
  toggle: ToggleRef | null;
  enabled: boolean | null;
  /** Text shown when there is no writable flag. */
  readonly: string;
  pending: Set<string>;
  busyFiles: Set<string>;
  /** Entry name, used for the switch's accessible label. */
  name: string;
  onToggle: (toggle: ToggleRef, enabled: boolean) => void;
}) {
  if (!toggle) {
    return (
      <span className="shrink-0 text-[11px] text-content/40">{readonly}</span>
    );
  }
  return (
    <Toggle
      label={`Enable ${name}`}
      on={enabled ?? false}
      disabled={
        busyFiles.has(toggle.file) || pending.has(toggleKey(toggle))
      }
      onChange={(next) => onToggle(toggle, next)}
    />
  );
}

function McpRow({
  entry,
  provider,
  pending,
  busyFiles,
  onToggle,
  onRemove,
  onCopyPath,
  onReveal,
  onOpen,
}: {
  entry: McpServerEntry;
  provider: string;
  pending: Set<string>;
  busyFiles: Set<string>;
  onToggle: (toggle: ToggleRef, enabled: boolean) => void;
  onRemove: (remove: RemoveRef, label: string) => void;
  onCopyPath: (path: string) => void;
  onReveal: (path: string) => void;
  onOpen: (path: string) => void;
}): ReactNode {
  // Claude gates project .mcp.json servers behind user approval; other
  // providers treat a flag-less entry as always-on.
  const readonly =
    entry.enabled === null
      ? provider === "claude" && entry.scope === "project"
        ? "Needs approval"
        : "Always on"
      : entry.enabled
        ? "On"
        : "Off";
  const off = entry.enabled === false;
  return (
    <div className={off ? "opacity-50" : ""}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-content">
          {entry.name}
        </span>
        <ScopeBadge scope={entry.scope} />
        <span className="shrink-0 text-[11px] text-content/40">
          {entry.transport}
        </span>
        <GateControl
          toggle={entry.toggle}
          enabled={entry.enabled}
          readonly={readonly}
          pending={pending}
          busyFiles={busyFiles}
          name={entry.name}
          onToggle={onToggle}
        />
      </div>
      {entry.summary ? (
        <p
          className="mt-0.5 truncate font-sans text-[11px] text-content/55"
          title={entry.summary}
        >
          {entry.summary}
        </p>
      ) : null}
      <div className="mt-0.5 flex items-center gap-1">
        <p
          className="min-w-0 flex-1 truncate font-sans text-[11px] text-content/35"
          title={entry.file}
        >
          {entry.file}
          {entry.detail ? ` · ${entry.detail}` : ""}
        </p>
        <RemoveButton
          remove={entry.remove}
          label={entry.name}
          pending={pending}
          busyFiles={busyFiles}
          onRemove={onRemove}
        />
        <RowActions
          path={entry.file}
          onCopyPath={onCopyPath}
          onReveal={onReveal}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}

function PluginRow({
  entry,
  pending,
  busyFiles,
  onToggle,
  onRemove,
  onCopyPath,
  onReveal,
  onOpen,
}: {
  entry: PluginEntry;
  pending: Set<string>;
  busyFiles: Set<string>;
  onToggle: (toggle: ToggleRef, enabled: boolean) => void;
  onRemove: (remove: RemoveRef, label: string) => void;
  onCopyPath: (path: string) => void;
  onReveal: (path: string) => void;
  onOpen: (path: string) => void;
}): ReactNode {
  const readonly = entry.managed
    ? "Managed"
    : !entry.installed
      ? "Not installed"
      : entry.enabled === null
        ? "No flag"
        : entry.enabled
          ? "On"
          : "Off";
  const off = entry.enabled === false || !entry.installed;
  return (
    <div className={off ? "opacity-50" : ""}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-content">
          {entry.id}
        </span>
        {entry.kind !== "plugin" ? (
          <span className="shrink-0 text-[11px] text-content/40">
            {entry.kind}
          </span>
        ) : null}
        <ScopeBadge scope={entry.scope} />
        <GateControl
          toggle={entry.toggle}
          enabled={entry.enabled}
          readonly={readonly}
          pending={pending}
          busyFiles={busyFiles}
          name={entry.id}
          onToggle={onToggle}
        />
      </div>
      <div className="mt-0.5 flex items-center gap-1">
        <p
          className="min-w-0 flex-1 truncate font-sans text-[11px] text-content/35"
          title={entry.detail ?? entry.file}
        >
          {entry.detail ?? entry.file}
        </p>
        <RemoveButton
          remove={entry.remove}
          label={entry.id}
          pending={pending}
          busyFiles={busyFiles}
          onRemove={onRemove}
        />
        <RowActions
          path={entry.file}
          onCopyPath={onCopyPath}
          onReveal={onReveal}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}

function HookRow({
  entry,
  pending,
  busyFiles,
  onRemove,
  onCopyPath,
  onReveal,
  onOpen,
}: {
  entry: HookEntry;
  pending: Set<string>;
  busyFiles: Set<string>;
  onRemove: (remove: RemoveRef, label: string) => void;
  onCopyPath: (path: string) => void;
  onReveal: (path: string) => void;
  onOpen: (path: string) => void;
}): ReactNode {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-content">
          {entry.event}
          {entry.matcher ? (
            <span className="text-content/45"> · {entry.matcher}</span>
          ) : null}
        </span>
        {entry.kind !== "command" ? (
          <span className="shrink-0 text-[11px] text-content/40">
            {entry.kind}
          </span>
        ) : null}
        <ScopeBadge scope={entry.scope} />
      </div>
      {entry.command ? (
        <p
          className="mt-0.5 truncate font-sans text-[11px] text-content/55"
          title={entry.command}
        >
          {entry.command}
        </p>
      ) : null}
      {entry.refs.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {entry.refs.map((ref, index) => (
            <span
              key={`${ref.path}#${index}`}
              title={
                ref.exists === null
                  ? `${ref.path} — depends on the environment`
                  : ref.exists
                    ? ref.path
                    : `${ref.path} — not found`
              }
              className={`max-w-64 truncate rounded-full px-1.5 py-0.5 font-sans text-[10px] ${
                ref.exists === false
                  ? "bg-red-400/15 text-red-300"
                  : ref.exists === null
                    ? "bg-amber-400/15 text-amber-300"
                    : "bg-content/10 text-content/60"
              }`}
            >
              {ref.path.split("/").pop() || ref.path}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-0.5 flex items-center gap-1">
        <p
          className="min-w-0 flex-1 truncate font-sans text-[11px] text-content/35"
          title={entry.file}
        >
          {entry.file}
        </p>
        <RemoveButton
          remove={entry.remove}
          label={entry.command ?? entry.event}
          pending={pending}
          busyFiles={busyFiles}
          onRemove={onRemove}
        />
        <RowActions
          path={entry.file}
          onCopyPath={onCopyPath}
          onReveal={onReveal}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  rules: "Rules",
  subagent: "Subagent",
  command: "Command",
};

function InstructionsList({
  entries,
  needle,
  pending,
  busyFiles,
  onRemove,
  onCopyPath,
  onReveal,
  onOpen,
}: {
  entries: InstructionEntry[];
  needle: string;
  pending: Set<string>;
  busyFiles: Set<string>;
  onRemove: (remove: RemoveRef, label: string) => void;
  onCopyPath: (path: string) => void;
  onReveal: (path: string) => void;
  onOpen: (path: string) => void;
}): ReactNode {
  const filtered = entries.filter((entry) => instructionHit(entry, needle));
  if (filtered.length === 0) {
    return (
      <p className="px-1 py-3 text-[12px] text-content/45">
        {needle
          ? "No matching instruction files"
          : "No AGENTS.md, CLAUDE.md, or rules files found"}
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-content/10">
      {filtered.map((entry) => (
        <div
          key={entry.path}
          className="border-b border-content/5 px-3 py-2 last:border-b-0"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12px] text-content">
              {entry.name}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {entry.consumers.slice(0, 5).map((consumer) => (
                <span key={consumer} title={providerTitle(consumer)}>
                  <ProviderMark provider={consumer} />
                </span>
              ))}
              {entry.consumers.length > 5 ? (
                <span className="text-[10px] text-content/40">
                  +{entry.consumers.length - 5}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-[11px] text-content/40">
              {KIND_LABEL[entry.kind] ?? entry.kind}
            </span>
            <ScopeBadge scope={entry.scope} />
          </div>
          <div className="mt-0.5 flex items-center gap-1">
            <p
              className="min-w-0 flex-1 truncate font-sans text-[11px] text-content/35"
              title={entry.path}
            >
              {entry.path}
              {` · ${formatSize(entry.size)}`}
            </p>
            <button
              type="button"
              aria-label={`Open ${entry.name}`}
              title="Open in editor"
              onClick={() => onOpen(entry.path)}
              className="grid size-5 shrink-0 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content"
            >
              <Eye className="size-3" strokeWidth={1.75} />
            </button>
            <RemoveButton
              remove={fileRemove(entry.path)}
              label={entry.name}
              pending={pending}
              busyFiles={busyFiles}
              onRemove={onRemove}
            />
            <RowActions
              path={entry.path}
              onCopyPath={onCopyPath}
              onReveal={onReveal}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}
