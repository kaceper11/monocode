import { invoke } from "@tauri-apps/api/core";
import { normalizeProjectPath } from "./recents";

const KEY = "monocode.connections.v1";
export const CONNECTIONS_CHANGED = "monocode:connections-changed";
export type ConnectionProvider =
  | "github"
  | "linear"
  | "jira"
  | "azure-boards"
  | "azure-repos"
  | "github-actions"
  | "azure-pipelines";
export type ServiceBinding = {
  provider: ConnectionProvider;
  accountId: string;
  project: string;
};
export type ConnectionAccount = {
  id: string;
  provider: ConnectionProvider;
  hostname: string;
  login: string;
  credentialHost: "local";
  writes: boolean;
};
export type ExecutionHost =
  { kind: "local" } | { kind: "wsl"; distribution: string };
export type ProjectConnections = {
  tickets: ServiceBinding[] | null;
  gitRemote: string | null;
  prs: ServiceBinding | null | false;
  ci: ServiceBinding[];
  executionHost: ExecutionHost;
};
export type Connections = {
  version: 1;
  accounts: ConnectionAccount[];
  projects: Record<string, ProjectConnections>;
};
export type GithubBinding = {
  hostname: string;
  account: string;
  repository: string;
  writes: boolean;
};
export const DEFAULT_PROJECT_CONNECTIONS: ProjectConnections = {
  tickets: null,
  gitRemote: null,
  prs: null,
  ci: [],
  executionHost: { kind: "local" },
};
const providers: ConnectionProvider[] = [
  "github",
  "linear",
  "jira",
  "azure-boards",
  "azure-repos",
  "github-actions",
  "azure-pipelines",
];
const empty = (): Connections => ({ version: 1, accounts: [], projects: {} });

export function validateConnections(value: Connections): void {
  if (
    value.version !== 1 ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 32 ||
    !value.projects ||
    Object.keys(value.projects).length > 256
  )
    throw new Error("Unsupported or oversized connection settings");
  const ids = new Set<string>();
  for (const account of value.accounts) {
    if (
      !account.id ||
      ids.has(account.id) ||
      !providers.includes(account.provider) ||
      account.credentialHost !== "local" ||
      typeof account.writes !== "boolean" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(account.hostname) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,127}$/.test(account.login)
    )
      throw new Error("Invalid or duplicate connection account");
    ids.add(account.id);
  }
  for (const project of Object.values(value.projects)) {
    if (
      !project ||
      !(project.tickets === null || Array.isArray(project.tickets)) ||
      !Array.isArray(project.ci) ||
      project.ci.length > 8 ||
      (project.tickets?.length ?? 0) > 8 ||
      !(
        project.prs === null ||
        project.prs === false ||
        typeof project.prs === "object"
      ) ||
      !(
        project.gitRemote === null ||
        (typeof project.gitRemote === "string" &&
          /^[^\s\x00-\x1f-][^\s\x00-\x1f]*$/.test(project.gitRemote))
      )
    )
      throw new Error("Invalid project bindings");
    if (
      !project.executionHost ||
      !(
        project.executionHost.kind === "local" ||
        (project.executionHost.kind === "wsl" &&
          typeof project.executionHost.distribution === "string" &&
          project.executionHost.distribution.length > 0 &&
          project.executionHost.distribution.length <= 128 &&
          !/[\x00-\x1f]/.test(project.executionHost.distribution))
      )
    )
      throw new Error("Invalid execution host");
    for (const binding of [
      ...(project.tickets ?? []),
      ...project.ci,
      ...(project.prs ? [project.prs] : []),
    ]) {
      if (
        !binding ||
        !providers.includes(binding.provider) ||
        typeof binding.accountId !== "string" ||
        typeof binding.project !== "string" ||
        binding.project.length > 512 ||
        /[\x00-\x1f]/.test(binding.project)
      )
        throw new Error("Invalid service binding");
    }
  }
}

export function loadConnections(): Connections {
  const raw =
    typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
  if (!raw) return empty();
  if (raw.length > 256 * 1024)
    throw new Error("Connection settings exceed 256 KiB");
  const value = JSON.parse(raw) as Connections;
  validateConnections(value);
  return value;
}

export function inboxConnectionsKey(config: Connections): string {
  return JSON.stringify({
    accounts: config.accounts.filter(
      (account) => account.provider === "github",
    ),
    projects: Object.entries(config.projects).map(([path, project]) => [
      path,
      project.tickets,
      project.prs,
    ]),
  });
}

export function saveConnections(
  value: Connections,
  expected?: Connections,
): void {
  if (
    expected &&
    JSON.stringify(loadConnections()) !== JSON.stringify(expected)
  )
    throw new Error(
      "Connections changed in another window. Reopen Settings before saving.",
    );
  validateConnections(value);
  const encoded = JSON.stringify(value);
  if (encoded.length > 256 * 1024)
    throw new Error("Connection settings exceed 256 KiB");
  const previous = localStorage.getItem(KEY);
  if (previous) localStorage.setItem(`${KEY}.backup`, previous);
  localStorage.setItem(KEY, encoded);
  if (!expected || inboxConnectionsKey(expected) !== inboxConnectionsKey(value))
    window.dispatchEvent(new Event(CONNECTIONS_CHANGED));
}

export function projectConnections(
  cwd: string,
  config = loadConnections(),
): ProjectConnections {
  return (
    config.projects[normalizeProjectPath(cwd)] ?? DEFAULT_PROJECT_CONNECTIONS
  );
}

export function githubBinding(
  binding: ServiceBinding,
  config = loadConnections(),
): GithubBinding {
  if (binding.provider !== "github")
    throw new Error(`${binding.provider} connector is not available yet`);
  const account = config.accounts.find(
    (candidate) => candidate.id === binding.accountId,
  );
  if (!account || account.provider !== "github")
    throw new Error(
      "GitHub account is disconnected. Select an account in Connections.",
    );
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding.project) ||
    binding.project.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Use the full GitHub owner/repository name");
  return {
    hostname: account.hostname.toLowerCase(),
    account: account.login,
    repository: binding.project,
    writes: account.writes,
  };
}

export function githubBindingKey(binding?: GithubBinding): string {
  return binding
    ? JSON.stringify([
        binding.hostname.toLowerCase(),
        binding.account.toLowerCase(),
        binding.repository.toLowerCase(),
      ])
    : "legacy";
}

/** An open artifact keeps its original binding; edits never retarget it. */
export function assertGithubBinding(
  cwd: string,
  kind: "issue" | "pr",
  binding?: GithubBinding,
  write = false,
): void {
  const config = loadConnections();
  const project = projectConnections(cwd, config);
  const selected =
    kind === "issue"
      ? project.tickets
      : project.prs === null
        ? null
        : project.prs
          ? [project.prs]
          : [];
  if (selected === null && !binding) return;
  const match = selected?.some((candidate) => {
    try {
      const current = githubBinding(candidate, config);
      return (
        githubBindingKey(current) === githubBindingKey(binding) &&
        (!write || current.writes)
      );
    } catch {
      return false;
    }
  });
  if (!match)
    throw new Error(
      "This connection changed, disconnected, or does not allow writes. Refresh the inbox.",
    );
}

export function testGithubAccount(
  account: ConnectionAccount,
  repository: string,
): Promise<string> {
  return invoke("github_connection_test", {
    binding: githubBinding(
      { provider: "github", accountId: account.id, project: repository },
      { ...empty(), accounts: [account] },
    ),
  });
}

let githubActive = 0;
const githubWaiting: (() => void)[] = [];
/** A shared finite queue for the existing GitHub UI paths. */
export async function githubRequest<T>(
  command: string,
  args: {
    cwd: string;
    binding?: GithubBinding;
    kind?: string;
    [key: string]: unknown;
  },
): Promise<T> {
  if (githubActive >= 4) {
    if (githubWaiting.length >= 64)
      throw new Error(
        "GitHub request queue is full. Retry after current requests finish.",
      );
    await new Promise<void>((resolve) =>
      githubWaiting.push(() => {
        githubActive++;
        resolve();
      }),
    );
  } else githubActive++;
  try {
    if (command !== "git_github_repo")
      assertGithubBinding(
        args.cwd,
        args.kind === "issue" ? "issue" : "pr",
        args.binding,
        command === "git_github_work_item_comment" ||
          command === "git_pr_create",
      );
    return await invoke<T>(command, args);
  } finally {
    githubActive--;
    githubWaiting.shift()?.();
  }
}

export function inheritWorktreeConnections(from: string, to: string): void {
  const config = loadConnections();
  const original = config.projects[normalizeProjectPath(from)];
  const target = normalizeProjectPath(to);
  if (original && !config.projects[target]) {
    saveConnections(
      {
        ...config,
        projects: { ...config.projects, [target]: structuredClone(original) },
      },
      config,
    );
  }
}
